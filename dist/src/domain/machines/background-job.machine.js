import { assign, setup } from "xstate";
import { messageOf } from "../config.js";
/**
 * Explicit XState v5 lifecycle machine for one background role-team job.
 *
 * States:
 * - `running`: active pipeline execution; accepts `CANCEL`, `STATE_UPDATED`, `CHILD_CHANGED`, `SETTLE`, `FAIL`.
 * - `cancelling`: abort signal dispatched; waiting for active child cleanup before finalizing as `cancelled`.
 * - `settled` (final): completed cleanly with `outcome.status` (`approved` | `unapproved` | `continued`).
 * - `cancelled` (final): aborted by caller or plugin disposal.
 * - `failed` (final): unhandled failure outside cancellation.
 */
export function createBackgroundJobMachine() {
    return setup({
        types: {
            input: {},
            context: {},
            events: {},
        },
        guards: {
            wasAborted: ({ context }) => context.controller.signal.aborted,
        },
        actions: {
            abortController: ({ context }) => {
                context.controller.abort();
            },
            recordState: assign({
                lastState: ({ event }) => event.type === "STATE_UPDATED" ? event.state : undefined,
            }),
            recordChild: assign({
                child: ({ event }) => event.type === "CHILD_CHANGED" ? event.child : undefined,
            }),
            recordSettled: assign({
                outcome: ({ event }) => event.type === "SETTLE" ? event.outcome : undefined,
                outcomeStatus: ({ event }) => event.type === "SETTLE" ? event.outcome.status : undefined,
                finishedAt: () => Date.now(),
            }),
            recordCancelled: assign({
                outcome: ({ context, event }) => event.type === "SETTLE" ? event.outcome : context.outcome,
                error: ({ context, event }) => {
                    if (event.type === "FAIL") {
                        return `Role team: CANCELLED · ${messageOf(event.error)}`;
                    }
                    return context.error;
                },
                finishedAt: () => Date.now(),
            }),
            recordFailed: assign({
                error: ({ event }) => event.type === "FAIL"
                    ? `Role team: FAILED · ${messageOf(event.error)}`
                    : "Role team: FAILED · unknown error",
                finishedAt: () => Date.now(),
            }),
        },
    }).createMachine({
        id: "backgroundJob",
        initial: "running",
        context: ({ input }) => ({
            id: input.id,
            owner: input.owner,
            task: input.task,
            startedAt: input.startedAt,
            controller: input.controller,
            lastState: input.initialState,
            outcome: input.initialOutcome,
        }),
        states: {
            running: {
                on: {
                    CANCEL: {
                        target: "cancelling",
                        actions: "abortController",
                    },
                    STATE_UPDATED: {
                        actions: "recordState",
                    },
                    CHILD_CHANGED: {
                        actions: "recordChild",
                    },
                    SETTLE: [
                        {
                            guard: "wasAborted",
                            target: "cancelled",
                            actions: "recordCancelled",
                        },
                        {
                            target: "settled",
                            actions: "recordSettled",
                        },
                    ],
                    FAIL: [
                        {
                            guard: "wasAborted",
                            target: "cancelled",
                            actions: "recordCancelled",
                        },
                        {
                            target: "failed",
                            actions: "recordFailed",
                        },
                    ],
                },
            },
            cancelling: {
                on: {
                    STATE_UPDATED: {
                        actions: "recordState",
                    },
                    CHILD_CHANGED: {
                        actions: "recordChild",
                    },
                    SETTLE: {
                        target: "cancelled",
                        actions: "recordCancelled",
                    },
                    FAIL: {
                        target: "cancelled",
                        actions: "recordCancelled",
                    },
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
}
export const backgroundJobMachine = createBackgroundJobMachine();
/** Derive the public status string from a background job machine snapshot. */
export function backgroundJobPublicStatus(snapshot) {
    if (snapshot.value === "settled") {
        return snapshot.context.outcomeStatus ?? "approved";
    }
    return typeof snapshot.value === "string" ? snapshot.value : "unknown";
}
/** Whether a background job snapshot represents an in-flight run. */
export function isBackgroundJobActive(snapshot) {
    return snapshot.value === "running" || snapshot.value === "cancelling";
}
