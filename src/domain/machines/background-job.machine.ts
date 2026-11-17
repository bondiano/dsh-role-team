import { assign, setup } from "xstate";
import { messageOf } from "../config.js";
import type {
	BackgroundChildTarget,
	BackgroundOutcome,
	BackgroundRunState,
} from "../types.js";

export interface BackgroundJobInput<
	State extends BackgroundRunState = BackgroundRunState,
	Outcome extends BackgroundOutcome = BackgroundOutcome,
> {
	id: string;
	owner: string;
	task: string;
	startedAt: number;
	controller: AbortController;
	initialState?: State;
	initialOutcome?: Outcome;
}

export interface BackgroundJobContext<
	State extends BackgroundRunState = BackgroundRunState,
	Outcome extends BackgroundOutcome = BackgroundOutcome,
> {
	id: string;
	owner: string;
	task: string;
	startedAt: number;
	finishedAt?: number;
	controller: AbortController;
	lastState?: State;
	outcome?: Outcome;
	outcomeStatus?: string;
	child?: BackgroundChildTarget;
	error?: string;
}

export type BackgroundJobEvent<
	State extends BackgroundRunState = BackgroundRunState,
	Outcome extends BackgroundOutcome = BackgroundOutcome,
> =
	| { type: "CANCEL" }
	| { type: "STATE_UPDATED"; state: State }
	| { type: "CHILD_CHANGED"; child: BackgroundChildTarget | undefined }
	| { type: "SETTLE"; outcome: Outcome }
	| { type: "FAIL"; error: unknown };

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
export function createBackgroundJobMachine<
	State extends BackgroundRunState = BackgroundRunState,
	Outcome extends BackgroundOutcome = BackgroundOutcome,
>() {
	return setup({
		types: {
			input: {} as BackgroundJobInput<State, Outcome>,
			context: {} as BackgroundJobContext<State, Outcome>,
			events: {} as BackgroundJobEvent<State, Outcome>,
		},
		guards: {
			wasAborted: ({ context }) => context.controller.signal.aborted,
		},
		actions: {
			abortController: ({ context }) => {
				context.controller.abort();
			},
			recordState: assign({
				lastState: ({ event }) =>
					event.type === "STATE_UPDATED" ? event.state : undefined,
			}),
			recordChild: assign({
				child: ({ event }) =>
					event.type === "CHILD_CHANGED" ? event.child : undefined,
			}),
			recordSettled: assign({
				outcome: ({ event }) =>
					event.type === "SETTLE" ? event.outcome : undefined,
				outcomeStatus: ({ event }) =>
					event.type === "SETTLE" ? event.outcome.status : undefined,
				finishedAt: () => Date.now(),
			}),
			recordCancelled: assign({
				outcome: ({ context, event }) =>
					event.type === "SETTLE" ? event.outcome : context.outcome,
				error: ({ context, event }) => {
					if (event.type === "FAIL") {
						return `Role team: CANCELLED · ${messageOf(event.error)}`;
					}
					return context.error;
				},
				finishedAt: () => Date.now(),
			}),
			recordFailed: assign({
				error: ({ event }) =>
					event.type === "FAIL"
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
export function backgroundJobPublicStatus(snapshot: {
	value: unknown;
	context: { outcomeStatus?: string };
}): string {
	if (snapshot.value === "settled") {
		return snapshot.context.outcomeStatus ?? "approved";
	}
	return typeof snapshot.value === "string" ? snapshot.value : "unknown";
}

/** Whether a background job snapshot represents an in-flight run. */
export function isBackgroundJobActive(snapshot: { value: unknown }): boolean {
	return snapshot.value === "running" || snapshot.value === "cancelling";
}
