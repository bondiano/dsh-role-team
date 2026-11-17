import assert from "node:assert/strict";
import test from "node:test";
import { createActor, fromPromise, toPromise } from "xstate";
import { apply, backgroundJobPublicStatus, createBackgroundJobMachine, createRuntimeRoleMachine, handleRolesRoute, handleRunStateRequest, isBackgroundJobActive, normalizeRoute, parseWorkerStatus, resolveRoleTeamConfig, roleFallbackMachine, teamPipelineMachine, } from "../src/index.js";
function makeRoleResult(role, text, overrides = {}) {
    return {
        role,
        route: { provider: "opencode-go", model: `${role}-model` },
        childName: `${role}-1`,
        status: "completed",
        text,
        durationMs: 10,
        ...overrides,
    };
}
test("backgroundJobMachine transitions cleanly through running, cancelling, settled, cancelled and failed", async () => {
    const machine = createBackgroundJobMachine();
    const controller1 = new AbortController();
    const job1 = createActor(machine, {
        input: {
            id: "run-1",
            owner: "session-1",
            task: "Build feature",
            startedAt: 100,
            controller: controller1,
        },
    });
    job1.start();
    assert.equal(job1.getSnapshot().value, "running");
    assert.equal(isBackgroundJobActive(job1.getSnapshot()), true);
    assert.equal(backgroundJobPublicStatus(job1.getSnapshot()), "running");
    job1.send({ type: "STATE_UPDATED", state: { progress: "halfway" } });
    assert.equal(job1.getSnapshot().context.lastState?.progress, "halfway");
    job1.send({
        type: "SETTLE",
        outcome: { status: "approved", report: "OK" },
    });
    assert.equal(job1.getSnapshot().value, "settled");
    assert.equal(isBackgroundJobActive(job1.getSnapshot()), false);
    assert.equal(backgroundJobPublicStatus(job1.getSnapshot()), "approved");
    // Cancellation path: running -> cancelling -> cancelled
    const controller2 = new AbortController();
    const job2 = createActor(machine, {
        input: {
            id: "run-2",
            owner: "session-1",
            task: "Cancel me",
            startedAt: 200,
            controller: controller2,
        },
    });
    job2.start();
    job2.send({ type: "CANCEL" });
    assert.equal(controller2.signal.aborted, true);
    assert.equal(job2.getSnapshot().value, "cancelling");
    assert.equal(isBackgroundJobActive(job2.getSnapshot()), true);
    // Duplicate CANCEL is a no-op
    job2.send({ type: "CANCEL" });
    assert.equal(job2.getSnapshot().value, "cancelling");
    job2.send({ type: "FAIL", error: new Error("aborted") });
    assert.equal(job2.getSnapshot().value, "cancelled");
    assert.equal(isBackgroundJobActive(job2.getSnapshot()), false);
    assert.match(job2.getSnapshot().context.error ?? "", /CANCELLED/);
});
test("roleFallbackMachine deduplicates routes, falls back on validation/execution failure, and stops on abort", async () => {
    const validated = [];
    const executed = [];
    const machine = roleFallbackMachine.provide({
        actors: {
            validateCandidate: fromPromise(async ({ input }) => {
                validated.push(input.route.model);
                if (input.route.model === "bad-validate") {
                    throw new Error("validation failed");
                }
            }),
            executeCandidate: fromPromise(async ({ input }) => {
                executed.push(input.route ? input.route.model : "inherit");
                if (input.route?.model === "bad-exec") {
                    throw new Error("execution failed");
                }
                return makeRoleResult("worker", "STATUS: done", {
                    route: input.route,
                });
            }),
        },
    });
    const actor = createActor(machine, {
        input: {
            role: "worker",
            primaryRoute: { provider: "p", model: "bad-validate" },
            fallbacks: [
                { provider: "p", model: "bad-validate" }, // duplicate should be skipped
                { provider: "p", model: "bad-exec" },
                { provider: "p", model: "good" },
            ],
        },
    });
    actor.start();
    await toPromise(actor);
    const snap = actor.getSnapshot();
    assert.equal(snap.value, "succeeded");
    assert.deepEqual(validated, ["bad-validate", "bad-exec", "good"]);
    assert.deepEqual(executed, ["bad-exec", "good"]);
    assert.equal(snap.context.result?.fallback, true);
    assert.equal(snap.context.result?.attempts?.length, 2);
    // Abort stops fallback chain immediately
    const controller = new AbortController();
    const abortActor = createActor(roleFallbackMachine.provide({
        actors: {
            validateCandidate: fromPromise(async () => { }),
            executeCandidate: fromPromise(async () => {
                controller.abort();
                throw new Error("cancelled");
            }),
        },
    }), {
        input: {
            role: "worker",
            primaryRoute: { provider: "p", model: "first" },
            fallbacks: [{ provider: "p", model: "second" }],
            signal: controller.signal,
        },
    });
    abortActor.start();
    await toPromise(abortActor);
    assert.equal(abortActor.getSnapshot().value, "aborted");
});
test("runtimeRoleMachine closes the session even when streaming fails", async () => {
    const closed = [];
    const machine = createRuntimeRoleMachine().provide({
        actors: {
            prepareSession: fromPromise(async () => ({
                session: { id: "rt-1", cwd: "/tmp/rt-1" },
                directory: "/tmp/src",
                startedAt: Date.now(),
            })),
            streamEvents: fromPromise(async () => {
                throw new Error("stream broken");
            }),
            closeSession: fromPromise(async ({ input }) => {
                closed.push(input.sessionId);
            }),
        },
    });
    const actor = createActor(machine, {
        input: {
            route: { runtime: "cursor", provider: "cursor", model: "m" },
            role: "worker",
            prompt: "do it",
        },
    });
    actor.start();
    await toPromise(actor);
    const snap = actor.getSnapshot();
    assert.equal(snap.value, "failed");
    assert.deepEqual(closed, ["rt-1"]);
    assert.match(snap.context.error?.message ?? "", /stream broken/);
});
test("teamPipelineMachine executes plan revision, blocked worker skip, exhaustion retry/model, and approval", async () => {
    const visited = [];
    let planAuditCount = 0;
    let workerCount = 0;
    let exhaustionCount = 0;
    const machine = teamPipelineMachine.provide({
        actors: {
            validateSetup: fromPromise(async () => { }),
            runPlan: fromPromise(async () => makeRoleResult("plan", "STEPS:\n1. Draft")),
            auditPlan: fromPromise(async () => {
                planAuditCount += 1;
                return {
                    result: makeRoleResult("advisor", "{}"),
                    verdict: {
                        approved: planAuditCount > 1,
                        summary: planAuditCount === 1 ? "revise" : "ok",
                        issues: planAuditCount === 1
                            ? [{ severity: "major", detail: "add tests" }]
                            : [],
                        parsed: true,
                    },
                };
            }),
            revisePlan: fromPromise(async () => makeRoleResult("plan", "STEPS:\n1. Draft\n2. Test")),
            runWorker: fromPromise(async () => {
                workerCount += 1;
                if (workerCount === 1) {
                    return {
                        result: makeRoleResult("worker", "STATUS: blocked\nNOTES: wait"),
                        blocked: true,
                        blockedDetail: "wait",
                    };
                }
                return {
                    result: makeRoleResult("worker", "STATUS: done"),
                    blocked: false,
                    blockedDetail: "",
                };
            }),
            auditWork: fromPromise(async () => ({
                result: makeRoleResult("advisor", "{}"),
                verdict: {
                    approved: workerCount >= 2,
                    summary: "ok",
                    issues: [],
                    parsed: true,
                },
            })),
            reviewWork: fromPromise(async () => ({
                result: makeRoleResult("reviewer", "{}"),
                verdict: {
                    approved: true,
                    summary: "ship it",
                    issues: [],
                    parsed: true,
                },
            })),
            askExhaustion: fromPromise(async () => {
                exhaustionCount += 1;
                return { kind: "retry" };
            }),
            chooseWorkerModel: fromPromise(async () => ({
                accepted: false,
                note: "unused",
            })),
        },
    });
    const actor = createActor(machine, {
        input: {
            task: "Implement feature",
            config: resolveRoleTeamConfig({ maxRounds: 1, maxPlanPasses: 2 }),
        },
    });
    actor.subscribe((snap) => {
        const stateName = String(snap.value);
        if (visited.at(-1) !== stateName)
            visited.push(stateName);
    });
    actor.start();
    await toPromise(actor);
    const snap = actor.getSnapshot();
    assert.equal(snap.value, "settled");
    assert.equal(snap.context.outcomeStatus, "approved");
    assert.equal(exhaustionCount, 1);
    assert.deepEqual(visited, [
        "validating",
        "planning",
        "auditingPlan",
        "revisingPlan",
        "auditingPlan",
        "runningWorker",
        "awaitingExhaustionDecision",
        "runningWorker",
        "auditingWork",
        "reviewingWork",
        "settled",
    ]);
});
test("bugfix regressions: single-role fallback, empty-config reset, safe runtime catalog, strict HTTP methods, and NaN sectionOrder", async () => {
    const tools = new Map();
    const sections = [];
    const entry = {
        id: "role-team",
        options: { config: { roles: { worker: "broken/model" } } },
    };
    const ctx = {
        fiber: { entry },
        tools: {
            register(def) {
                tools.set(def.name, def);
                return () => tools.delete(def.name);
            },
        },
        systemPrompt: {
            getSectionOrder: () => undefined,
            section(def) {
                sections.push(def);
                return () => { };
            },
        },
        effect(cb) {
            return cb();
        },
        inject() { },
        get(name) {
            if (name === "llm") {
                return {
                    async resolveCallConfig(route) {
                        if (route.provider === "broken")
                            throw new Error("provider unavailable");
                        return {};
                    },
                    listProviders: () => [],
                    listModels: async () => [],
                };
            }
            if (name === "subagents") {
                return {
                    getProvider: () => ({ capabilities: {} }),
                    async startActivation() {
                        return {
                            name: "worker-1",
                            childId: "child-1",
                            result: Promise.resolve({
                                stopReason: "completed",
                                output: [{ type: "text", text: "STATUS: done" }],
                            }),
                            async dispose() { },
                        };
                    },
                };
            }
            if (name === "configEditor") {
                return {
                    async edit(_target, change) {
                        entry.options.config = change(entry.options.config);
                    },
                };
            }
            return undefined;
        },
    };
    // 1. apply() handles getSectionOrder returning undefined without NaN
    apply(ctx, {
        roles: { worker: "broken/model" },
        fallbacks: { worker: ["good/model"] },
    });
    assert.equal(Number.isFinite(sections[0]?.order), true);
    // 2. Single-role tool role_worker falls back when primary fails validation
    const workerResult = await tools
        .get("role_worker")
        .execute({ task: "do work" }, { agent: { session: { id: "s1" } } });
    assert.equal(workerResult.fallback, true);
    assert.equal(workerResult.route.provider, "good");
    // 3. handleRolesRoute with unknown runtime query param returns empty runtimes without prototype pollution
    const rtResp = await handleRolesRoute(ctx, new Request("http://127.0.0.1:3344/plugin-api/role-team/roles?models=1&runtime=__proto__", { headers: { host: "127.0.0.1:3344" } }));
    const rtJson = await rtResp.json();
    assert.deepEqual(rtJson.runtimes, {});
    // 4. handleRunStateRequest rejects DELETE with 405
    const delResp = handleRunStateRequest(ctx, new Request("http://127.0.0.1:3344/plugin-api/role-team/run/r1", {
        method: "DELETE",
        headers: { host: "127.0.0.1:3344" },
    }));
    assert.equal(delResp.status, 405);
    // 5. parseWorkerStatus keeps NOTES intact even when lines contain lowercase `note:`
    const workerStatus = parseWorkerStatus("STATUS: blocked\nNOTES: see details\nnote: env var missing");
    assert.equal(workerStatus.blocked, true);
    assert.match(workerStatus.detail, /env var missing/);
    // 6. normalizeRoute parses :effort on external runtime shorthand
    const parsedRuntime = normalizeRoute("cursor:claude-opus-5.5:high");
    assert.deepEqual(parsedRuntime.route, {
        runtime: "cursor",
        provider: "cursor",
        model: "claude-opus-5.5",
        reasoningEffort: "high",
    });
    // 7. Resetting the last role override via HTTP does not fall back to a stale entry.options.config
    const resetResp = await handleRolesRoute(ctx, new Request("http://127.0.0.1:3344/plugin-api/role-team/roles", {
        method: "POST",
        headers: {
            host: "127.0.0.1:3344",
            "content-type": "application/json",
            "x-role-team-request": "1",
        },
        body: JSON.stringify({ role: "worker", action: "reset" }),
    }));
    assert.equal(resetResp.status, 200);
    entry.options.config = { roles: { worker: "stale/model" } };
    const getAfterReset = await (await handleRolesRoute(ctx, new Request("http://127.0.0.1:3344/plugin-api/role-team/roles", {
        headers: { host: "127.0.0.1:3344" },
    }))).json();
    assert.equal(getAfterReset.roles.worker.source, "default");
    assert.notEqual(getAfterReset.roles.worker.route.provider, "stale");
});
