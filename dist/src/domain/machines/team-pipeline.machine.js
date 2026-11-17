import { assign, fromPromise, setup } from "xstate";
import { clip, LIMITS, messageOf } from "../config.js";
import { feedbackLines } from "../verdict.js";
import { actorError, actorOutput } from "./actor-events.js";
/**
 * Explicit XState v5 state machine for the four-role engineering pipeline:
 * `PLAN -> ADVISOR (plan audit) -> PLAN (revision) -> WORKER -> ADVISOR -> REVIEWER`
 * with bounded round budget and interactive exhaustion recovery.
 *
 * All side-effecting role invocations and user prompts are injected as XState
 * actors (`fromPromise`), keeping the machine definition pure and unit-testable.
 */
export const teamPipelineMachine = setup({
    types: {
        input: {},
        context: {},
    },
    actors: {
        validateSetup: fromPromise(async () => {
            throw new Error("validateSetup actor must be provided");
        }),
        runPlan: fromPromise(async () => {
            throw new Error("runPlan actor must be provided");
        }),
        auditPlan: fromPromise(async () => {
            throw new Error("auditPlan actor must be provided");
        }),
        revisePlan: fromPromise(async () => {
            throw new Error("revisePlan actor must be provided");
        }),
        runWorker: fromPromise(async () => {
            throw new Error("runWorker actor must be provided");
        }),
        auditWork: fromPromise(async () => {
            throw new Error("auditWork actor must be provided");
        }),
        reviewWork: fromPromise(async () => {
            throw new Error("reviewWork actor must be provided");
        }),
        askExhaustion: fromPromise(async () => {
            throw new Error("askExhaustion actor must be provided");
        }),
        chooseWorkerModel: fromPromise(async () => {
            throw new Error("chooseWorkerModel actor must be provided");
        }),
    },
    guards: {
        isAborted: ({ context }) => context.signal?.aborted === true,
        hasSuppliedPlan: ({ context }) => context.hasSuppliedPlan,
        isEmptyPlanResult: ({ event }) => actorOutput(event).text.trim() === "",
        isAuditApproved: ({ event }) => actorOutput(event).verdict.approved,
        hasMorePlanPasses: ({ context }) => context.planPass < context.runConfig.maxPlanPasses,
        hasRemainingRounds: ({ context }) => context.round < context.attemptLimit,
        isWorkerBlocked: ({ event }) => actorOutput(event).blocked,
        choseContinue: ({ event }) => actorOutput(event).kind === "continue",
        choseStopOrNone: ({ event }) => {
            const kind = actorOutput(event).kind;
            return kind === "stop" || kind === "none";
        },
        choseModel: ({ event }) => actorOutput(event).kind === "model",
        exceedsMaxWorkerAttempts: ({ context }) => context.attemptLimit + 3 > LIMITS.maxWorkerAttempts,
        isModelChoiceAccepted: ({ event }) => actorOutput(event).accepted,
    },
    actions: {
        enterAwaitingExhaustion: () => { },
        enterAwaitingModel: () => { },
        leaveAwaitingUser: () => { },
        notifyWorkerDone: () => { },
        recordStage: () => { },
        recordAbortedError: assign({
            error: () => new Error("role team was cancelled"),
        }),
        recordActorError: assign({
            error: ({ event }) => {
                const err = actorError(event);
                return err instanceof Error ? err : new Error(messageOf(err));
            },
        }),
        recordEmptyPlanError: assign({
            error: ({ event }) => {
                const result = actorOutput(event);
                const diag = result.diagnostic === undefined
                    ? ""
                    : `: ${clip(result.diagnostic, 1200)}`;
                return new Error(`PLAN finished without a plan (${result.status}${diag}); role team cannot continue`);
            },
        }),
        recordPlanResult: assign(({ context, event }) => {
            const result = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, plan: result.route },
                }
                : context.runConfig;
            return {
                planText: result.text.trim(),
                runConfig: nextConfig,
                stages: [
                    ...context.stages,
                    {
                        role: "plan",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
            };
        }),
        recordPlanAuditApproved: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, advisor: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                planIssues: [],
                feedback: [],
                planAudits: [
                    ...context.planAudits,
                    {
                        pass: context.planPass,
                        route: result.route,
                        durationMs: result.durationMs,
                        verdict,
                    },
                ],
                stages: [
                    ...context.stages,
                    {
                        role: "advisor",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "advisor",
                        stage: `plan audit ${context.planPass}`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordPlanAuditRejected: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const issues = feedbackLines(verdict.issues);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, advisor: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                planIssues: issues,
                feedback: issues,
                planAudits: [
                    ...context.planAudits,
                    {
                        pass: context.planPass,
                        route: result.route,
                        durationMs: result.durationMs,
                        verdict,
                    },
                ],
                stages: [
                    ...context.stages,
                    {
                        role: "advisor",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "advisor",
                        stage: `plan audit ${context.planPass}`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordPlanRevision: assign(({ context, event }) => {
            const result = actorOutput(event);
            const revised = result.text.trim();
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, plan: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                planPass: context.planPass + 1,
                planText: revised !== "" ? revised : context.planText,
                stages: [
                    ...context.stages,
                    {
                        role: "plan",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
            };
        }),
        incrementRound: assign({
            round: ({ context }) => context.round + 1,
        }),
        recordWorkerBlocked: assign(({ context, event }) => {
            const { result, blockedDetail } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, worker: result.route },
                }
                : context.runConfig;
            const blockedIssue = {
                severity: "blocker",
                detail: blockedDetail,
            };
            const blockedVerdict = {
                approved: false,
                summary: "WORKER reported STATUS: blocked",
                issues: [blockedIssue],
                parsed: true,
            };
            return {
                runConfig: nextConfig,
                cwd: result.cwd !== undefined ? result.cwd : context.cwd,
                previousReport: result.text,
                feedback: feedbackLines(blockedVerdict.issues),
                stages: [
                    ...context.stages,
                    {
                        role: "worker",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                rounds: [
                    ...context.rounds,
                    {
                        number: context.round,
                        worker: result,
                        advisorVerdict: blockedVerdict,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "advisor",
                        stage: `round ${context.round} attempt (worker blocked)`,
                        route: result.route,
                        approved: false,
                        summary: blockedVerdict.summary,
                        issues: blockedVerdict.issues,
                    },
                ],
            };
        }),
        recordWorkerDone: assign(({ context, event }) => {
            const { result } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, worker: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                cwd: result.cwd !== undefined ? result.cwd : context.cwd,
                previousReport: result.text,
                currentWorker: result,
                stages: [
                    ...context.stages,
                    {
                        role: "worker",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
            };
        }),
        recordAdvisorApproved: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, advisor: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                currentAdvisor: result,
                currentAdvisorVerdict: verdict,
                stages: [
                    ...context.stages,
                    {
                        role: "advisor",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "advisor",
                        stage: `round ${context.round} attempt`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordAdvisorRejected: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, advisor: result.route },
                }
                : context.runConfig;
            const nextFeedback = feedbackLines(verdict.issues);
            return {
                runConfig: nextConfig,
                feedback: nextFeedback.length > 0
                    ? nextFeedback
                    : [
                        "[major] ADVISOR did not approve and returned no issue details; inspect the workspace and retry.",
                    ],
                stages: [
                    ...context.stages,
                    {
                        role: "advisor",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                rounds: [
                    ...context.rounds,
                    {
                        number: context.round,
                        worker: context.currentWorker,
                        advisor: result,
                        advisorVerdict: verdict,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "advisor",
                        stage: `round ${context.round} attempt`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordReviewerApproved: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, reviewer: result.route },
                }
                : context.runConfig;
            return {
                runConfig: nextConfig,
                outcomeStatus: "approved",
                stages: [
                    ...context.stages,
                    {
                        role: "reviewer",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                rounds: [
                    ...context.rounds,
                    {
                        number: context.round,
                        worker: context.currentWorker,
                        advisor: context.currentAdvisor,
                        advisorVerdict: context.currentAdvisorVerdict,
                        reviewer: result,
                        reviewerVerdict: verdict,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "reviewer",
                        stage: `round ${context.round} final gate`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordReviewerRejected: assign(({ context, event }) => {
            const { result, verdict } = actorOutput(event);
            const nextConfig = result.fallback && result.route !== null
                ? {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, reviewer: result.route },
                }
                : context.runConfig;
            const nextFeedback = feedbackLines(verdict.issues);
            return {
                runConfig: nextConfig,
                feedback: nextFeedback.length > 0
                    ? nextFeedback
                    : [
                        "[major] REVIEWER did not approve and returned no issue details; inspect the workspace and retry.",
                    ],
                stages: [
                    ...context.stages,
                    {
                        role: "reviewer",
                        route: result.route,
                        status: result.status,
                        durationMs: result.durationMs,
                    },
                ],
                rounds: [
                    ...context.rounds,
                    {
                        number: context.round,
                        worker: context.currentWorker,
                        advisor: context.currentAdvisor,
                        advisorVerdict: context.currentAdvisorVerdict,
                        reviewer: result,
                        reviewerVerdict: verdict,
                    },
                ],
                comments: [
                    ...context.comments,
                    {
                        role: "reviewer",
                        stage: `round ${context.round} final gate`,
                        route: result.route,
                        approved: verdict.approved,
                        summary: verdict.summary,
                        issues: verdict.issues,
                    },
                ],
            };
        }),
        recordContinueDecision: assign(({ context }) => ({
            decisions: [...context.decisions, { choice: "continue" }],
            outcomeStatus: "continued",
        })),
        recordStopDecision: assign(({ context, event }) => {
            const { kind, note } = actorOutput(event);
            return {
                decisions: [
                    ...context.decisions,
                    { choice: kind, ...(note === undefined ? {} : { note }) },
                ],
                outcomeStatus: "unapproved",
                ...(note === undefined ? {} : { note }),
            };
        }),
        recordRetryDecision: assign(({ context }) => ({
            decisions: [...context.decisions, { choice: "retry" }],
        })),
        grantMoreRounds: assign({
            attemptLimit: ({ context }) => context.attemptLimit + 3,
        }),
        recordHardCapExhausted: assign({
            outcomeStatus: "unapproved",
            note: () => `the hard cap of ${LIMITS.maxWorkerAttempts} worker attempts was reached, so no more rounds could be granted`,
        }),
        recordAcceptedWorkerModel: assign(({ context, event }) => {
            const output = actorOutput(event);
            return {
                runConfig: {
                    ...context.runConfig,
                    roles: { ...context.runConfig.roles, worker: output.route },
                },
                decisions: [
                    ...context.decisions,
                    { choice: "model", route: output.route },
                ],
            };
        }),
        recordRejectedWorkerModel: assign(({ context, event }) => {
            const output = actorOutput(event);
            return {
                decisions: [
                    ...context.decisions,
                    {
                        choice: "model",
                        ...(output.route === undefined ? {} : { route: output.route }),
                        note: output.note,
                    },
                ],
                outcomeStatus: "unapproved",
                note: output.note,
            };
        }),
    },
}).createMachine({
    id: "teamPipeline",
    initial: "validating",
    context: ({ input }) => {
        const trimmedPlan = typeof input.suppliedPlan === "string" ? input.suppliedPlan.trim() : "";
        return {
            task: input.task.trim(),
            context: input.context,
            planText: trimmedPlan,
            hasSuppliedPlan: trimmedPlan !== "",
            cwd: input.cwd,
            runConfig: {
                ...input.config,
                roles: { ...input.config.roles },
            },
            signal: input.signal,
            startedAt: input.startedAt ?? Date.now(),
            planPass: 1,
            planIssues: [],
            planAudits: [],
            round: 0,
            attemptLimit: Math.max(1, Math.min(input.config.maxRounds, LIMITS.maxRounds)),
            feedback: [],
            rounds: [],
            stages: [],
            comments: [],
            decisions: [],
            outcomeStatus: "unapproved",
        };
    },
    states: {
        validating: {
            invoke: {
                src: "validateSetup",
                input: ({ context }) => ({
                    hasSuppliedPlan: context.hasSuppliedPlan,
                    config: context.runConfig,
                    signal: context.signal,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "hasSuppliedPlan",
                        target: "auditingPlan",
                    },
                    {
                        target: "planning",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        planning: {
            invoke: {
                src: "runPlan",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    cwd: context.cwd,
                    extra: context.runConfig.prompts.plan,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isEmptyPlanResult",
                        target: "failed",
                        actions: ["recordPlanResult", "recordEmptyPlanError"],
                    },
                    {
                        target: "auditingPlan",
                        actions: "recordPlanResult",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        auditingPlan: {
            invoke: {
                src: "auditPlan",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    plan: context.planText,
                    cwd: context.cwd,
                    extra: context.runConfig.prompts.advisor,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isAuditApproved",
                        target: "checkingRoundBudget",
                        actions: "recordPlanAuditApproved",
                    },
                    {
                        guard: "hasMorePlanPasses",
                        target: "revisingPlan",
                        actions: "recordPlanAuditRejected",
                    },
                    {
                        target: "checkingRoundBudget",
                        actions: "recordPlanAuditRejected",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        revisingPlan: {
            invoke: {
                src: "revisePlan",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    plan: context.planText,
                    issues: context.planIssues,
                    cwd: context.cwd,
                    extra: context.runConfig.prompts.plan,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "auditingPlan",
                        actions: "recordPlanRevision",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        checkingRoundBudget: {
            always: [
                {
                    guard: "isAborted",
                    target: "cancelled",
                    actions: "recordAbortedError",
                },
                {
                    guard: "hasRemainingRounds",
                    target: "runningWorker",
                },
                {
                    target: "awaitingExhaustionDecision",
                },
            ],
        },
        awaitingExhaustionDecision: {
            entry: "enterAwaitingExhaustion",
            exit: "leaveAwaitingUser",
            invoke: {
                src: "askExhaustion",
                input: ({ context }) => ({ signal: context.signal }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "choseContinue",
                        target: "settled",
                        actions: "recordContinueDecision",
                    },
                    {
                        guard: "choseStopOrNone",
                        target: "settled",
                        actions: "recordStopDecision",
                    },
                    {
                        guard: "choseModel",
                        target: "awaitingModelChoice",
                    },
                    {
                        guard: "exceedsMaxWorkerAttempts",
                        target: "settled",
                        actions: ["recordRetryDecision", "recordHardCapExhausted"],
                    },
                    {
                        target: "runningWorker",
                        actions: ["recordRetryDecision", "grantMoreRounds"],
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        awaitingModelChoice: {
            entry: "enterAwaitingModel",
            exit: "leaveAwaitingUser",
            invoke: {
                src: "chooseWorkerModel",
                input: ({ context }) => ({
                    runConfig: context.runConfig,
                    signal: context.signal,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isModelChoiceAccepted",
                        target: "checkingModelRetryCap",
                        actions: "recordAcceptedWorkerModel",
                    },
                    {
                        target: "settled",
                        actions: "recordRejectedWorkerModel",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        checkingModelRetryCap: {
            always: [
                {
                    guard: "exceedsMaxWorkerAttempts",
                    target: "settled",
                    actions: "recordHardCapExhausted",
                },
                {
                    target: "runningWorker",
                    actions: "grantMoreRounds",
                },
            ],
        },
        runningWorker: {
            entry: "incrementRound",
            invoke: {
                src: "runWorker",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    plan: context.planText,
                    cwd: context.cwd,
                    round: context.round,
                    feedback: context.feedback,
                    previous: context.previousReport,
                    extra: context.runConfig.prompts.worker,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isWorkerBlocked",
                        target: "checkingRoundBudget",
                        actions: "recordWorkerBlocked",
                    },
                    {
                        target: "auditingWork",
                        actions: ["recordWorkerDone", "notifyWorkerDone"],
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        auditingWork: {
            invoke: {
                src: "auditWork",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    plan: context.planText,
                    cwd: context.cwd,
                    workerReport: context.currentWorker.text,
                    round: context.round,
                    feedback: context.feedback,
                    extra: context.runConfig.prompts.advisor,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isAuditApproved",
                        target: "reviewingWork",
                        actions: "recordAdvisorApproved",
                    },
                    {
                        target: "checkingRoundBudget",
                        actions: "recordAdvisorRejected",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        reviewingWork: {
            invoke: {
                src: "reviewWork",
                input: ({ context }) => ({
                    task: context.task,
                    context: context.context,
                    plan: context.planText,
                    cwd: context.cwd,
                    workerReport: context.currentWorker.text,
                    advisorVerdict: context.currentAdvisor.text,
                    extra: context.runConfig.prompts.reviewer,
                    runConfig: context.runConfig,
                }),
                onDone: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        guard: "isAuditApproved",
                        target: "settled",
                        actions: "recordReviewerApproved",
                    },
                    {
                        target: "checkingRoundBudget",
                        actions: "recordReviewerRejected",
                    },
                ],
                onError: [
                    {
                        guard: "isAborted",
                        target: "cancelled",
                        actions: "recordAbortedError",
                    },
                    {
                        target: "failed",
                        actions: "recordActorError",
                    },
                ],
            },
        },
        settled: {
            type: "final",
        },
        cancelled: {
            type: "final",
        },
        failed: {
            type: "final",
        },
    },
});
