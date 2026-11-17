import { createActor, fromPromise, toPromise } from "xstate";
import { buildAdvisorPrompt, buildPlanAuditPrompt, buildPlanPrompt, buildPlanRevisionPrompt, buildReviewerPrompt, buildWorkerPrompt, } from "../adapters/prompts.js";
import { clip, familyOf, formatDuration, formatFallbackChain, formatRoute, LIMITS, messageOf, normalizeRoute, oneLine, ROLE_LABELS, ROLE_NAMES, } from "../domain/config.js";
import { roleFallbackMachine } from "../domain/machines/role-fallback.machine.js";
import { teamPipelineMachine } from "../domain/machines/team-pipeline.machine.js";
import { parseVerdict, parseWorkerStatus } from "../domain/verdict.js";
import { runNativeRole } from "../infrastructure/native-role.js";
import { validateRoute, validateRoutesParallel, } from "../infrastructure/route-validation.js";
import { runRuntimeRole } from "../infrastructure/runtime-role.js";
import { beginRunStage, beginRunState, endRunStage, endRunState, markWorkerDone, roleChildName, runStateOf, stateFor, updateRunState, } from "./state.js";
/**
 * Start one role child (native subagent or external runtime), await its
 * settlement, and release it.
 */
export async function runRole(ctx, config, { role, prompt, parent, signal, cwd, callId, routeOverride, onChild, }) {
    const update = (patch) => {
        updateRunState(ctx, callId, patch);
    };
    const selectedRoute = routeOverride !== undefined ? routeOverride : config.roles[role];
    if (selectedRoute?.runtime && selectedRoute.runtime !== "native") {
        return runRuntimeRole(ctx, {
            route: selectedRoute,
            role,
            prompt,
            parent,
            signal,
            cwd,
            onActivity: update,
        });
    }
    return runNativeRole(ctx, config, {
        role,
        route: selectedRoute,
        childName: roleChildName(ctx, role),
        prompt,
        parent,
        signal,
        cwd,
        onUpdate: update,
        onChild,
    });
}
/**
 * Run one role against its primary route and then each configured fallback via
 * the explicit `roleFallbackMachine` XState state machine.
 */
export async function runRoleWithFallback(ctx, config, options) {
    const machine = roleFallbackMachine.provide({
        actors: {
            validateCandidate: fromPromise(async ({ input }) => {
                await validateRoute(ctx, input.role, input.route, input.signal);
            }),
            executeCandidate: fromPromise(async ({ input }) => runRole(ctx, config, {
                ...options,
                routeOverride: input.route,
            })),
        },
    });
    const actor = createActor(machine, {
        input: {
            role: options.role,
            primaryRoute: config.roles[options.role] ?? null,
            fallbacks: config.fallbacks[options.role] ?? [],
            signal: options.signal,
        },
    });
    actor.start();
    await toPromise(actor);
    const snapshot = actor.getSnapshot();
    if (snapshot.value === "succeeded" && snapshot.context.result) {
        return snapshot.context.result;
    }
    throw snapshot.context.error ?? new Error(`role ${options.role} failed`);
}
/** Run one role for a single-role tool while tracking it in the live run state. */
export async function runTrackedRole(ctx, config, { tool, task, role, prompt, agent, signal, cwd, callId }) {
    beginRunState(ctx, callId, tool, oneLine(task, 300));
    beginRunStage(ctx, callId, role, config.roles[role] ?? null);
    const stageStartedAt = Date.now();
    try {
        const result = await runRoleWithFallback(ctx, config, {
            role,
            prompt,
            parent: agent,
            signal,
            cwd,
            callId,
        });
        endRunStage(ctx, callId, role, result.status, result.durationMs, result.route);
        return result;
    }
    catch (error) {
        endRunStage(ctx, callId, role, "failed", Date.now() - stageStartedAt);
        throw error;
    }
    finally {
        endRunState(ctx, callId);
    }
}
/** Format one role result for a single-role tool. */
export function formatRoleResult(result) {
    const header = `Role ${ROLE_LABELS[result.role]} (${formatRoute(result.route)}${result.fallback ? ", fallback" : ""}) finished: ${result.status} in ${formatDuration(result.durationMs)}.`;
    const body = result.text === "" ? "(the role returned no text)" : result.text;
    const attempts = result.attempts === undefined || result.attempts.length === 0
        ? ""
        : `\nFailed routes: ${result.attempts.map((attempt) => `${formatRoute(attempt.route)} (${attempt.error})`).join("; ")}`;
    const diagnostic = result.diagnostic === undefined
        ? ""
        : `\n\nDiagnostic: ${result.diagnostic}`;
    return clip(`${header}${attempts}\n\n${body}${diagnostic}`, LIMITS.roleOutputChars);
}
/** Build the structured canonical value of one single-role tool. */
export function structuredRoleResult(result, verdict) {
    return {
        text: formatRoleResult(result),
        role: result.role,
        route: result.route,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.fallback === true ? { fallback: true } : {}),
        ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
        ...(verdict === undefined ? {} : { verdict }),
    };
}
/** The exhaustion choices offered to the user when rounds run out. */
const EXHAUSTION_OPTIONS = Object.freeze([
    {
        label: "Continue without approval",
        description: "End the run now; the work stays as it is with the outstanding feedback listed.",
    },
    {
        label: "Try 3 more rounds",
        description: "Run three more worker attempts with the same models.",
    },
    {
        label: "Change the WORKER model",
        description: "Pick a new worker model first; three more attempts then run on it.",
    },
    { label: "Stop", description: "End the run as not approved." },
]);
/** Ask the user one question through the user-questions service. */
async function askUserChoice(ctx, agent, signal, question) {
    const userQuestions = ctx.get("userQuestions");
    if (userQuestions === undefined ||
        userQuestions === null ||
        typeof userQuestions.ask !== "function")
        return undefined;
    try {
        return await userQuestions.ask({
            questions: [question],
            ...(agent === undefined || agent === null ? {} : { agent }),
            ...(signal === undefined ? {} : { signal }),
        });
    }
    catch {
        return undefined;
    }
}
/** Read the selected label of one answered question. */
function selectedLabel(answers, id) {
    const answer = answers !== undefined && Array.isArray(answers.answers)
        ? answers.answers.find((candidate) => candidate.id === id)
        : undefined;
    if (answer === undefined)
        return undefined;
    if (Array.isArray(answer.selected) &&
        answer.selected.length > 0 &&
        typeof answer.selected[0] === "string") {
        return answer.selected[0];
    }
    if (typeof answer.custom === "string" && answer.custom.trim() !== "")
        return answer.custom.trim();
    return undefined;
}
/** Ask the user how to proceed when the rounds are exhausted without approval. */
async function decideOnExhaustion(ctx, agent, signal) {
    const answers = await askUserChoice(ctx, agent, signal, {
        id: "exhaustion",
        header: "Role team",
        question: "The role team ran out of worker rounds without approval. How should it proceed?",
        options: EXHAUSTION_OPTIONS,
    });
    if (answers === undefined) {
        return {
            kind: "none",
            note: "the user could not be asked (no interactive answerer is available), so the run ended NOT APPROVED",
        };
    }
    const label = selectedLabel(answers, "exhaustion");
    if (label === "Continue without approval")
        return { kind: "continue" };
    if (label === "Try 3 more rounds")
        return { kind: "retry" };
    if (label === "Change the WORKER model")
        return { kind: "model" };
    if (label === "Stop")
        return { kind: "stop" };
    return {
        kind: "none",
        note: `the exhaustion answer "${label ?? "(none)"}" was not recognized, so the run ended NOT APPROVED`,
    };
}
/**
 * Ask the user which model the WORKER should use next.
 * Lists models across all providers in parallel and interleaves them fairly so
 * a single large provider cannot starve the remaining providers.
 */
async function askWorkerModelRoute(ctx, agent, signal, config) {
    const llm = ctx.get("llm");
    if (llm === undefined ||
        llm === null ||
        typeof llm.listProviders !== "function" ||
        typeof llm.listModels !== "function") {
        return undefined;
    }
    let providers = [];
    try {
        providers = llm.listProviders();
    }
    catch {
        return undefined;
    }
    const settled = await Promise.allSettled(providers.map(async (provider) => {
        const models = await llm.listModels(provider.id);
        return {
            provider,
            models: Array.isArray(models) ? models : [],
        };
    }));
    const buckets = settled
        .filter((item) => item.status === "fulfilled" && item.value.models.length > 0)
        .map((item) => item.value);
    if (buckets.length === 0)
        return undefined;
    const avoidFamilies = new Set();
    if (config) {
        for (const role of ["advisor", "reviewer"]) {
            const fam = familyOf(config.roles[role]);
            if (fam)
                avoidFamilies.add(fam);
        }
    }
    const candidates = [];
    const maxLen = Math.max(...buckets.map((b) => b.models.length));
    for (let idx = 0; idx < maxLen && candidates.length < 40; idx += 1) {
        for (const bucket of buckets) {
            if (candidates.length >= 40)
                break;
            const model = bucket.models[idx];
            if (!model)
                continue;
            const route = { provider: bucket.provider.id, model: model.id };
            const fam = familyOf(route);
            const providerLabel = bucket.provider.name ?? bucket.provider.id;
            const modelLabel = model.name ?? model.id;
            candidates.push({
                label: `${bucket.provider.id}/${model.id}`,
                description: providerLabel && modelLabel !== `${providerLabel} ${model.id}`
                    ? `${modelLabel} (${providerLabel})`
                    : modelLabel,
                independent: fam === null || !avoidFamilies.has(fam),
            });
        }
    }
    candidates.sort((a, b) => Number(b.independent) - Number(a.independent));
    const options = candidates.map(({ label, description }) => ({
        label,
        description,
    }));
    if (options.length === 0)
        return undefined;
    const answers = await askUserChoice(ctx, agent, signal, {
        id: "worker-model",
        header: "WORKER model",
        question: "Which model should the WORKER use for the next attempts?",
        options,
    });
    const label = selectedLabel(answers, "worker-model");
    if (label === undefined)
        return undefined;
    const parsed = normalizeRoute(label);
    return parsed.error !== undefined || parsed.route === null
        ? undefined
        : parsed.route;
}
/**
 * Build the final report handed back to the lead: verdicts first, then the
 * plan, then the round-by-round detail and the user's exhaustion decisions.
 */
export function buildTeamReport({ status, config, plan, rounds, comments, decisions, startedAt, task, note, }) {
    const lines = [];
    const headline = status === "approved"
        ? "APPROVED"
        : status === "continued"
            ? "CONTINUED WITHOUT APPROVAL"
            : "NOT APPROVED";
    lines.push(`Role team: ${headline} after ${rounds.length} round(s) in ${formatDuration(Date.now() - startedAt)}.`);
    lines.push(`Roles: ${ROLE_NAMES.map((role) => `${role}=${formatRoute(config.roles[role])}`).join(" · ")}`);
    const chains = ROLE_NAMES.filter((role) => (config.fallbacks[role] ?? []).length > 0).map((role) => `${role}=${formatFallbackChain(config.fallbacks[role] ?? [])}`);
    if (chains.length > 0)
        lines.push(`Fallbacks: ${chains.join(" · ")}`);
    lines.push(`Task: ${oneLine(task, 300)}`);
    if (rounds.some((round) => round.worker.cwd))
        lines.push("Source workspace is unchanged. Apply worker patches in round order: later patches are relative to the preceding candidate, or integrate the final candidate workspace manually.");
    if (comments.length > 0) {
        lines.push("");
        lines.push("ADVISOR AND REVIEWER COMMENTS");
        for (const comment of comments) {
            const label = comment.role === "reviewer" ? "REVIEWER" : "ADVISOR";
            lines.push(`${label} (${formatRoute(comment.route)}) — ${comment.stage} — ${comment.approved ? "APPROVED" : "CHANGES REQUIRED"}`);
            if (comment.summary !== "")
                lines.push(clip(comment.summary, LIMITS.verdictChars));
            for (const issue of comment.issues)
                lines.push(`- [${issue.severity}] ${issue.detail}`);
            lines.push("");
        }
    }
    lines.push("PLAN");
    lines.push(clip(plan, LIMITS.planChars));
    for (const round of rounds) {
        lines.push("");
        lines.push(`ROUND ${round.number}`);
        lines.push(`WORKER (${formatRoute(round.worker.route)}${round.worker.fallback ? ", fallback" : ""}, ${round.worker.status}, ${formatDuration(round.worker.durationMs)})`);
        if (round.worker.cwd)
            lines.push(`Candidate workspace: ${round.worker.cwd}`);
        for (const artifact of round.worker.artifacts ?? [])
            lines.push(`Result artifact: ${artifact}`);
        lines.push(clip(round.worker.text === "" ? "(no report)" : round.worker.text, LIMITS.workerChars));
        if (round.worker.diagnostic !== undefined)
            lines.push(`Diagnostic: ${clip(round.worker.diagnostic, 1500)}`);
        if (round.advisor !== undefined) {
            lines.push(`ADVISOR (${formatRoute(round.advisor.route)}${round.advisor.fallback ? ", fallback" : ""}, ${round.advisor.status}, ${formatDuration(round.advisor.durationMs)}) — ${round.advisorVerdict.approved ? "APPROVED" : "CHANGES REQUIRED"}`);
            if (round.advisor.diagnostic !== undefined)
                lines.push(`Diagnostic: ${clip(round.advisor.diagnostic, 1500)}`);
        }
        else {
            lines.push("ADVISOR — skipped because WORKER reported STATUS: blocked");
        }
        if (round.reviewer !== undefined) {
            lines.push(`REVIEWER (${formatRoute(round.reviewer.route)}${round.reviewer.fallback ? ", fallback" : ""}, ${round.reviewer.status}, ${formatDuration(round.reviewer.durationMs)}) — ${round.reviewerVerdict.approved ? "APPROVED" : "CHANGES REQUIRED"}`);
            if (round.reviewer.diagnostic !== undefined)
                lines.push(`Diagnostic: ${clip(round.reviewer.diagnostic, 1500)}`);
        }
    }
    if (decisions.length > 0) {
        lines.push("");
        lines.push("DECISIONS");
        for (const decision of decisions) {
            const route = decision.route === undefined ? "" : ` → ${formatRoute(decision.route)}`;
            const extra = decision.note === undefined ? "" : ` (${decision.note})`;
            lines.push(`- ${decision.choice}${route}${extra}`);
        }
    }
    const last = rounds.at(-1);
    if (status !== "approved" && last !== undefined) {
        lines.push("");
        lines.push("OUTSTANDING FEEDBACK");
        const issues = last.reviewerVerdict?.approved === false
            ? last.reviewerVerdict.issues
            : last.advisorVerdict.issues;
        if (issues.length === 0)
            lines.push("No structured issues were returned; inspect the round reports above.");
        else
            for (const issue of issues)
                lines.push(`- [${issue.severity}] ${issue.detail}`);
    }
    if (status !== "approved" && note !== undefined) {
        lines.push("");
        lines.push(note);
    }
    if (status === "continued") {
        lines.push("");
        lines.push("The user chose to continue without approval; the outstanding feedback above remains unaddressed.");
    }
    if (status === "unapproved") {
        lines.push("");
        lines.push("The task is not approved. Address the outstanding feedback and run the team again, or grant more rounds through the exhaustion question.");
    }
    return clip(lines.join("\n"), LIMITS.reportChars);
}
/**
 * Run the full PLAN -> plan audit -> WORKER -> ADVISOR -> REVIEWER loop,
 * driven by the explicit `teamPipelineMachine` XState state machine.
 */
export async function runRoleTeam(ctx, { agent, task, context, plan, signal, config, callId, tool = "roles_run", onState, onChild, }) {
    if (agent === undefined || agent === null)
        throw new Error("role team needs a calling agent");
    const taskText = typeof task === "string" ? task.trim() : "";
    if (taskText === "")
        throw new Error("role team needs a non-empty task");
    const initialCwd = ctx.get("workingDirectory")?.get?.(agent.session);
    const startedAt = Date.now();
    let liveStarted = false;
    const ensureLiveState = () => {
        if (liveStarted)
            return;
        liveStarted = true;
        beginRunState(ctx, callId, tool, oneLine(taskText, 300));
    };
    const runStage = async (role, prompt, runConfig, cwd) => {
        ensureLiveState();
        beginRunStage(ctx, callId, role, runConfig.roles[role] ?? null);
        const stageStartedAt = Date.now();
        try {
            const result = await runRoleWithFallback(ctx, runConfig, {
                role,
                prompt,
                parent: agent,
                signal,
                cwd,
                callId,
                onChild,
            });
            endRunStage(ctx, callId, role, result.status, result.durationMs, result.route);
            return result;
        }
        catch (error) {
            endRunStage(ctx, callId, role, "failed", Date.now() - stageStartedAt);
            throw error;
        }
    };
    const setAwaitingUser = (progress) => {
        if (callId === undefined)
            return;
        const waiting = stateFor(ctx).runStates.get(callId);
        if (waiting) {
            waiting.phase = "awaiting_user";
            waiting.progress = progress;
            waiting.updatedAt = Date.now();
        }
    };
    const clearAwaitingUser = () => {
        if (callId === undefined)
            return;
        const waiting = stateFor(ctx).runStates.get(callId);
        if (waiting) {
            delete waiting.phase;
            delete waiting.progress;
        }
    };
    const machine = teamPipelineMachine.provide({
        actors: {
            validateSetup: fromPromise(async ({ input }) => {
                const usedRoles = input.hasSuppliedPlan
                    ? ["worker", "advisor", "reviewer"]
                    : ROLE_NAMES;
                const configProblems = input.config.problems.filter((problem) => usedRoles.includes(problem.role));
                if (configProblems.length > 0) {
                    throw new Error(`role team configuration is invalid: ${configProblems.map((problem) => `${problem.role}: ${problem.message}`).join("; ")}`);
                }
                await validateRoutesParallel(ctx, usedRoles.filter((role) => (input.config.fallbacks[role] ?? []).length === 0), input.config, input.signal);
                ensureLiveState();
            }),
            runPlan: fromPromise(async ({ input }) => runStage("plan", buildPlanPrompt({
                task: input.task,
                context: input.context,
                cwd: input.cwd,
                extra: input.extra,
            }), input.runConfig, input.cwd)),
            auditPlan: fromPromise(async ({ input }) => {
                const result = await runStage("advisor", buildPlanAuditPrompt({
                    task: input.task,
                    context: input.context,
                    plan: input.plan,
                    cwd: input.cwd,
                    extra: input.extra,
                }), input.runConfig, input.cwd);
                return { result, verdict: parseVerdict(result.text) };
            }),
            revisePlan: fromPromise(async ({ input }) => runStage("plan", buildPlanRevisionPrompt({
                task: input.task,
                context: input.context,
                plan: input.plan,
                issues: input.issues,
                cwd: input.cwd,
                extra: input.extra,
            }), input.runConfig, input.cwd)),
            runWorker: fromPromise(async ({ input }) => {
                const result = await runStage("worker", buildWorkerPrompt({
                    task: input.task,
                    context: input.context,
                    plan: input.plan,
                    cwd: input.cwd,
                    round: input.round,
                    feedback: input.feedback,
                    previous: input.previous,
                    extra: input.extra,
                }), input.runConfig, input.cwd);
                const workerStatus = parseWorkerStatus(result.text);
                return {
                    result,
                    blocked: workerStatus.blocked,
                    blockedDetail: workerStatus.detail,
                };
            }),
            auditWork: fromPromise(async ({ input }) => {
                const result = await runStage("advisor", buildAdvisorPrompt({
                    task: input.task,
                    context: input.context,
                    plan: input.plan,
                    cwd: input.cwd,
                    workerReport: input.workerReport,
                    round: input.round,
                    feedback: input.feedback,
                    extra: input.extra,
                }), input.runConfig, input.cwd);
                return { result, verdict: parseVerdict(result.text) };
            }),
            reviewWork: fromPromise(async ({ input }) => {
                const result = await runStage("reviewer", buildReviewerPrompt({
                    task: input.task,
                    context: input.context,
                    plan: input.plan,
                    cwd: input.cwd,
                    workerReport: input.workerReport,
                    advisorVerdict: input.advisorVerdict,
                    extra: input.extra,
                }), input.runConfig, input.cwd);
                return { result, verdict: parseVerdict(result.text) };
            }),
            askExhaustion: fromPromise(async ({ input }) => decideOnExhaustion(ctx, agent, input.signal)),
            chooseWorkerModel: fromPromise(async ({ input }) => {
                const route = await askWorkerModelRoute(ctx, agent, input.signal, input.runConfig);
                if (route === undefined) {
                    return {
                        accepted: false,
                        note: "no worker model was chosen, so the run ended NOT APPROVED",
                    };
                }
                try {
                    await validateRoute(ctx, "worker", route, input.signal);
                }
                catch (error) {
                    return {
                        accepted: false,
                        route,
                        note: `the chosen route is not usable: ${messageOf(error)}`,
                    };
                }
                return { accepted: true, route };
            }),
        },
        actions: {
            enterAwaitingExhaustion: () => {
                setAwaitingUser("Waiting for your decision after the worker round limit");
            },
            enterAwaitingModel: () => {
                setAwaitingUser("Waiting for your worker model choice");
            },
            leaveAwaitingUser: () => {
                clearAwaitingUser();
            },
            notifyWorkerDone: ({ context: pipeCtx }) => {
                if (pipeCtx.currentWorker?.status === "completed") {
                    markWorkerDone(ctx, agent);
                }
            },
        },
    });
    const actor = createActor(machine, {
        input: {
            task: taskText,
            context,
            suppliedPlan: plan,
            cwd: initialCwd,
            config,
            signal,
            startedAt,
        },
    });
    const subscription = actor.subscribe((snap) => {
        if (!liveStarted || callId === undefined)
            return;
        const live = stateFor(ctx).runStates.get(callId);
        if (live) {
            live.comments = snap.context.comments;
            live.decisions = snap.context.decisions;
        }
    });
    try {
        actor.start();
        await toPromise(actor);
        const snap = actor.getSnapshot();
        if (snap.value !== "settled") {
            throw snap.context.error ?? new Error("role team did not settle");
        }
        const pipe = snap.context;
        const report = buildTeamReport({
            status: pipe.outcomeStatus,
            config: pipe.runConfig,
            plan: pipe.planText,
            rounds: pipe.rounds,
            comments: pipe.comments,
            decisions: pipe.decisions,
            startedAt: pipe.startedAt,
            task: pipe.task,
            note: pipe.note,
        });
        return {
            status: pipe.outcomeStatus,
            plan: pipe.planText,
            planAudits: pipe.planAudits,
            rounds: pipe.rounds,
            stages: pipe.stages,
            comments: pipe.comments,
            decisions: pipe.decisions,
            report,
        };
    }
    finally {
        subscription.unsubscribe();
        const finalCtx = actor.getSnapshot().context;
        onState?.({
            ...runStateOf(callId, ctx),
            comments: finalCtx.comments,
            decisions: finalCtx.decisions,
        });
        endRunState(ctx, callId);
    }
}
