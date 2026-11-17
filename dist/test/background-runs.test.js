import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundRuns, } from "../background-runs.js";
const LEAD = { session: { id: "lead-session" } };
const OTHER = { session: { id: "other-session" } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function harness(t, { services = {}, states = new Map(), run, } = {}) {
    const requests = [];
    const pending = new Map();
    const execute = run ??
        ((options) => {
            requests.push(options);
            const result = deferred();
            pending.set(options.callId, result);
            const abort = () => result.reject(new Error("cancelled by signal"));
            if (options.signal.aborted)
                abort();
            else
                options.signal.addEventListener("abort", abort, { once: true });
            return result.promise.finally(() => options.signal.removeEventListener("abort", abort));
        });
    const context = {
        get: (name) => services[name],
    };
    const manager = createBackgroundRuns(context, execute, (id) => states.get(id));
    t.after(() => manager.dispose());
    return { manager, requests, pending, states };
}
// Only ownership and verdict retention matter in this fixture, so presentation metadata is deliberately partial.
const approved = (report) => ({
    status: "approved",
    report,
    stages: [{ role: "worker", status: "completed" }],
    comments: [
        { role: "reviewer", approved: true },
    ],
    decisions: [],
});
test("background start returns before work finishes and retains its final report", async (t) => {
    const { manager, requests, pending } = harness(t);
    const launched = manager.start(LEAD, "run-1", {
        task: "Implement\n the feature",
    });
    assert.equal(launched.status, "running");
    assert.equal(launched.task, "Implement the feature");
    assert.equal(requests.length, 0, "starting the pipeline is deferred beyond the caller");
    await tick();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].agent, LEAD);
    assert.equal(requests[0].callId, "run-1");
    assert.equal((await manager.status(LEAD)).status, "running");
    pending.get("run-1").resolve(approved("Role team: APPROVED"));
    await tick();
    const completed = await manager.status(LEAD, "run-1");
    assert.equal(completed.status, "approved");
    assert.equal(completed.text, "Role team: APPROVED");
    assert.deepEqual(completed.stages, [{ role: "worker", status: "completed" }]);
    assert.deepEqual(completed.comments, [{ role: "reviewer", approved: true }]);
    assert.ok(completed.finishedAt >= completed.startedAt);
    assert.equal((await manager.status(LEAD)).text, completed.text, "later questions retain the outcome");
});
test("failed background work is retained as a failure rather than an unhandled rejection", async (t) => {
    const { manager, pending } = harness(t);
    manager.start(LEAD, "run-failed", { task: "Try a broken route" });
    await tick();
    pending.get("run-failed").reject(new Error("provider is unavailable"));
    await tick();
    const result = await manager.status(LEAD);
    assert.equal(result.status, "failed");
    assert.match(result.text, /FAILED.*provider is unavailable/);
    assert.equal(typeof result.finishedAt, "number");
});
test("run lookup and cancellation are restricted to their owning session", async (t) => {
    const { manager } = harness(t);
    manager.start(LEAD, "lead-run", { task: "Lead task" });
    manager.start(OTHER, "other-run", { task: "Other task" });
    assert.equal((await manager.status(LEAD)).runId, "lead-run");
    assert.equal((await manager.status(OTHER)).runId, "other-run");
    await assert.rejects(manager.status(OTHER, "lead-run"), /No role-team run found in this session/);
    await assert.rejects(manager.status(LEAD, "other-run"), /No role-team run found in this session/);
    assert.throws(() => manager.cancel(OTHER, "lead-run"), /No role-team run found in this session/);
    assert.equal((await manager.status(LEAD)).status, "running");
    assert.throws(() => manager.start({}, "invalid", { task: "No session" }), /calling session/);
});
test("duplicate launches are refused and the latest completed run is selected by default", async (t) => {
    const { manager, pending } = harness(t);
    manager.start(LEAD, "first", { task: "First task" });
    assert.throws(() => manager.start(LEAD, "duplicate", { task: "Duplicate" }), /already active/);
    await tick();
    pending.get("first").resolve(approved("first report"));
    await tick();
    manager.start(LEAD, "second", { task: "Second task" });
    assert.equal((await manager.status(LEAD)).runId, "second");
    assert.equal((await manager.status(LEAD, "first")).text, "first report");
    await tick();
    pending.get("second").resolve(approved("second report"));
    await tick();
    assert.equal((await manager.status(LEAD)).text, "second report");
});
test("background work owns its signal independently of the launching chat turn", async (t) => {
    const foreground = new AbortController();
    const { manager, requests } = harness(t);
    manager.start(LEAD, "independent", {
        task: "Keep working",
        signal: foreground.signal,
    });
    await tick();
    assert.notEqual(requests[0].signal, foreground.signal);
    foreground.abort();
    assert.equal(requests[0].signal.aborted, false);
    assert.equal((await manager.status(LEAD)).status, "running");
    manager.cancel(LEAD);
    assert.equal(requests[0].signal.aborted, true);
});
test("cancellation aborts a running job, prevents a concurrent restart and retains cancellation", async (t) => {
    const { manager, requests } = harness(t);
    manager.start(LEAD, "cancel-me", { task: "Long task" });
    await tick();
    assert.equal(manager.cancel(LEAD).status, "cancelling");
    assert.equal(requests[0].signal.aborted, true);
    assert.throws(() => manager.start(LEAD, "too-early", { task: "Overlap" }), /already active/);
    await tick();
    const cancelled = await manager.status(LEAD);
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.text, /CANCELLED/);
    assert.equal(manager.cancel(LEAD).status, "cancelled", "repeated cancellation preserves a terminal result");
});
test("plugin disposal aborts all sessions and awaits their cleanup before clearing history", async (t) => {
    const cleanup = deferred();
    const started = [];
    const { manager } = harness(t, {
        run: (options) => {
            started.push(options);
            return new Promise((_, reject) => {
                options.signal.addEventListener("abort", () => {
                    void cleanup.promise.then(() => reject(new Error("cleanup finished")));
                }, { once: true });
            });
        },
    });
    manager.start(LEAD, "dispose-lead", { task: "Lead" });
    manager.start(OTHER, "dispose-other", { task: "Other" });
    await tick();
    let disposed = false;
    const disposing = manager.dispose().then(() => {
        disposed = true;
    });
    assert.equal(started.length, 2);
    assert.ok(started.every((options) => options.signal.aborted));
    await tick();
    assert.equal(disposed, false, "dispose waits for role cleanup rather than clearing active state");
    assert.throws(() => manager.start(LEAD, "after-dispose", { task: "No" }), /shutting down/);
    cleanup.resolve();
    await disposing;
    assert.equal(manager.publicState("dispose-lead"), undefined);
    assert.equal(manager.publicState("dispose-other"), undefined);
});
test("status reads live child progress and can send a bounded progress question", async (t) => {
    const messages = [];
    const child = { id: "worker-session", name: "worker-1" };
    const states = new Map([
        [
            "observed-run",
            {
                currentRole: "worker",
                child,
                progress: "Tool: run_tests",
                stages: [{ role: "plan", status: "done" }],
            },
        ],
    ]);
    const { manager, requests } = harness(t, {
        states,
        services: {
            agents: new Map([[child.id, { status: "running" }]]),
            subagents: {
                async sendMessage(...args) {
                    messages.push(args);
                },
            },
        },
    });
    manager.start(LEAD, "observed-run", { task: "Implement it" });
    await tick();
    const stage = new AbortController();
    requests[0].onChild({ id: child.id, signal: stage.signal });
    const observed = await manager.status(LEAD);
    assert.equal(observed.currentRole, "worker");
    assert.equal(observed.child.activity, "running");
    assert.equal(observed.progress, "Tool: run_tests");
    assert.match(observed.text, /worker-1 \(running\)/);
    assert.match(observed.text, /Latest activity: Tool: run_tests/);
    assert.equal(messages.length, 0, "reading progress does not interrupt the child");
    const signal = new AbortController().signal;
    const asked = await manager.status(LEAD, undefined, "Any blockers?", signal);
    assert.equal(asked.questionSent, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][0], LEAD);
    assert.equal(messages[0][1], child.id);
    assert.equal(messages[0][2][0].type, "text");
    assert.match(messages[0][2][0].text, /Any blockers\?/);
    assert.match(messages[0][2][0].text, /continue the assigned role/);
    assert.notEqual(messages[0][3].signal, signal);
    assert.equal(messages[0][3].signal.aborted, false);
    await assert.rejects(manager.status(OTHER, "observed-run", "Read foreign progress"), /No role-team run/);
    assert.equal(messages.length, 1, "foreign-session questions are rejected before delivery");
});
test("progress questions refuse preparing, external, settled and unsupported child targets", async (t) => {
    const states = new Map();
    const { manager, pending, requests } = harness(t, { states });
    manager.start(LEAD, "unmessageable", { task: "Task" });
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /No active native role agent/);
    states.set("unmessageable", {
        currentRole: "worker",
        child: { id: "external", runtime: "cursor" },
    });
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /No active native role agent/);
    states.set("unmessageable", {
        currentRole: "worker",
        child: { id: "native" },
    });
    await tick();
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /No active native role agent/);
    requests[0].onChild({
        id: "outdated-native",
        signal: new AbortController().signal,
    });
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /No active native role agent/);
    requests[0].onChild({ id: "native", signal: new AbortController().signal });
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /Host cannot message role agents/);
    pending.get("unmessageable").resolve(approved("finished"));
    await tick();
    await assert.rejects(manager.status(LEAD, undefined, "Status?"), /No active native role agent/);
    assert.equal((await manager.status(LEAD)).text, "finished");
});
for (const boundary of [
    "run cancellation",
    "stage completion",
    "caller cancellation",
]) {
    test(`pending question admission is aborted by ${boundary} without reviving the child`, async (t) => {
        const admission = deferred();
        const stage = new AbortController();
        const caller = new AbortController();
        const attempted = [];
        const delivered = [];
        const states = new Map([
            ["ask-run", { currentRole: "worker", child: { id: "old-worker" } }],
        ]);
        const { manager, requests } = harness(t, {
            states,
            services: {
                subagents: {
                    async sendMessage(sender, childId, content, { signal }) {
                        attempted.push({ sender, childId, content, signal });
                        await admission.promise;
                        if (signal.aborted)
                            throw new Error("question admission cancelled");
                        delivered.push(childId);
                    },
                },
            },
        });
        manager.start(LEAD, "ask-run", { task: "Continue the work" });
        await tick();
        requests[0].onChild({ id: "old-worker", signal: stage.signal });
        const question = manager.status(LEAD, "ask-run", "Any blockers?", caller.signal);
        const rejected = assert.rejects(question, /question admission cancelled/);
        assert.equal(attempted.length, 1);
        assert.equal(attempted[0].childId, "old-worker");
        assert.equal(attempted[0].signal.aborted, false);
        if (boundary === "run cancellation") {
            assert.equal(manager.cancel(LEAD).status, "cancelling");
            await assert.rejects(manager.status(LEAD, undefined, "Another question?"), /No active native role agent/);
        }
        else if (boundary === "stage completion") {
            stage.abort();
            await assert.rejects(manager.status(LEAD, undefined, "Ask the finished worker"), /No active native role agent/);
            states.set("ask-run", {
                currentRole: "advisor",
                child: { id: "new-advisor" },
            });
            await assert.rejects(manager.status(LEAD, undefined, "Ask a stale handle"), /No active native role agent/);
        }
        else {
            caller.abort();
            assert.equal(requests[0].signal.aborted, false, "a cancelled question leaves the pipeline running");
            assert.equal(stage.signal.aborted, false);
        }
        assert.equal(attempted[0].signal.aborted, true);
        admission.resolve();
        await rejected;
        assert.deepEqual(delivered, [], "no message is accepted into a cancelled or finished child");
        assert.equal(attempted.length, 1, "rejected follow-ups never re-enter child admission");
    });
}
test("failed runs retain their last observed stage after the live state is removed", async (t) => {
    const { manager, requests, pending } = harness(t);
    manager.start(LEAD, "retained-stage", { task: "Implement a feature" });
    await tick();
    const lastState = {
        currentRole: null,
        phase: "failed",
        progress: "Worker stopped during tests",
        stages: [
            { role: "plan", status: "done" },
            { role: "worker", status: "failed" },
        ],
        comments: [{ role: "advisor", approved: true, summary: "Plan approved" }],
        decisions: [],
    };
    requests[0].onState(lastState);
    pending.get("retained-stage").reject(new Error("worker tool failed"));
    await tick();
    const result = await manager.status(LEAD);
    assert.equal(result.status, "failed");
    assert.equal(result.phase, "failed");
    assert.equal(result.progress, lastState.progress);
    assert.deepEqual(result.stages, lastState.stages);
    assert.deepEqual(result.comments, lastState.comments);
    assert.match(result.text, /worker tool failed/);
});
