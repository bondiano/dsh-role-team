import { assign, fromPromise, setup } from "xstate";
import { deduplicateRoutes, formatRoute, messageOf } from "../config.js";
import type { Role, RoleResult, Route } from "../types.js";
import { actorError, actorOutput } from "./actor-events.js";

export interface RoleFallbackInput {
	role: Role;
	primaryRoute: Route | null;
	fallbacks: readonly Route[];
	signal?: AbortSignal;
}

export interface RoleFallbackContext {
	role: Role;
	candidates: (Route | null)[];
	candidateIndex: number;
	signal?: AbortSignal;
	attempts: { route: Route; error: string }[];
	inheritError?: string;
	result?: RoleResult;
	error?: Error;
}

/**
 * Explicit XState v5 state machine for trying a role's primary route and
 * ordered fallback chain.
 *
 * States:
 * - `selectingRoute`: picks the next deduplicated candidate route or fails in `exhausted` / `aborted`.
 * - `validatingRoute`: validates concrete routes (skipped for `null` / inherit).
 * - `executing`: runs the role on the current candidate route.
 * - `succeeded` (final): carries `result` (marked `fallback: true` if earlier routes failed).
 * - `aborted` (final): caller signal aborted; terminates immediately without trying further fallbacks.
 * - `exhausted` (final): all routes failed validation or execution.
 */
export const roleFallbackMachine = setup({
	types: {
		input: {} as RoleFallbackInput,
		context: {} as RoleFallbackContext,
	},
	actors: {
		validateCandidate: fromPromise<
			void,
			{ role: Role; route: Route; signal?: AbortSignal }
		>(async () => {
			throw new Error("validateCandidate actor must be provided");
		}),
		executeCandidate: fromPromise<
			RoleResult,
			{ role: Role; route: Route | null; signal?: AbortSignal }
		>(async () => {
			throw new Error("executeCandidate actor must be provided");
		}),
	},
	guards: {
		isAborted: ({ context }) => context.signal?.aborted === true,
		hasMoreCandidates: ({ context }) =>
			context.candidateIndex < context.candidates.length,
		currentIsInherit: ({ context }) =>
			context.candidates[context.candidateIndex] === null,
	},
	actions: {
		recordAborted: assign({
			error: () => new Error("role team was cancelled"),
		}),
		recordExhausted: assign({
			error: ({ context }) => {
				const failures = [
					...(context.inheritError === undefined
						? []
						: [`inherit session model (${context.inheritError})`]),
					...context.attempts.map(
						(attempt) => `${formatRoute(attempt.route)} (${attempt.error})`,
					),
				];
				return new Error(
					`every route for ${context.role} failed: ${failures.length === 0 ? "no route configured" : failures.join("; ")}`,
				);
			},
		}),
		recordFailureAndAdvance: assign(({ context, event }) => {
			const candidate = context.candidates[context.candidateIndex];
			const errorText = messageOf(actorError(event));
			if (candidate === null || candidate === undefined) {
				return {
					inheritError: errorText,
					candidateIndex: context.candidateIndex + 1,
				};
			}
			return {
				attempts: [...context.attempts, { route: candidate, error: errorText }],
				candidateIndex: context.candidateIndex + 1,
			};
		}),
		recordSuccess: assign({
			result: ({ context, event }) => {
				const output = actorOutput<RoleResult>(event);
				return context.attempts.length === 0
					? output
					: { ...output, fallback: true, attempts: context.attempts };
			},
		}),
	},
}).createMachine({
	id: "roleFallback",
	initial: "selectingRoute",
	context: ({ input }) => ({
		role: input.role,
		candidates: deduplicateRoutes([input.primaryRoute, ...input.fallbacks]),
		candidateIndex: 0,
		signal: input.signal,
		attempts: [],
	}),
	states: {
		selectingRoute: {
			always: [
				{
					guard: "isAborted",
					target: "aborted",
					actions: "recordAborted",
				},
				{
					guard: "hasMoreCandidates",
					target: "dispatching",
				},
				{
					target: "exhausted",
					actions: "recordExhausted",
				},
			],
		},
		dispatching: {
			always: [
				{
					guard: "currentIsInherit",
					target: "executing",
				},
				{
					target: "validatingRoute",
				},
			],
		},
		validatingRoute: {
			invoke: {
				src: "validateCandidate",
				input: ({ context }) => ({
					role: context.role,
					route: context.candidates[context.candidateIndex]!,
					signal: context.signal,
				}),
				onDone: {
					target: "executing",
				},
				onError: [
					{
						guard: "isAborted",
						target: "aborted",
						actions: assign({
							error: ({ event }) =>
								event.error instanceof Error
									? event.error
									: new Error(messageOf(event.error)),
						}),
					},
					{
						target: "selectingRoute",
						actions: "recordFailureAndAdvance",
					},
				],
			},
		},
		executing: {
			invoke: {
				src: "executeCandidate",
				input: ({ context }) => ({
					role: context.role,
					route: context.candidates[context.candidateIndex] ?? null,
					signal: context.signal,
				}),
				onDone: {
					target: "succeeded",
					actions: "recordSuccess",
				},
				onError: [
					{
						guard: "isAborted",
						target: "aborted",
						actions: assign({
							error: ({ event }) =>
								event.error instanceof Error
									? event.error
									: new Error(messageOf(event.error)),
						}),
					},
					{
						target: "selectingRoute",
						actions: "recordFailureAndAdvance",
					},
				],
			},
		},
		succeeded: {
			type: "final",
		},
		aborted: {
			type: "final",
		},
		exhausted: {
			type: "final",
		},
	},
});
