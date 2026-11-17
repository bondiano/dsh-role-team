import { assign, fromPromise, setup } from "xstate";
import { messageOf } from "../config.js";
import type {
	RuntimeRoleResult,
	RuntimeRoute,
	RuntimeSession,
} from "../types.js";
import { actorError, actorOutput } from "./actor-events.js";

export interface RuntimeRoleInput<TRole extends string = string> {
	route: RuntimeRoute;
	role: TRole;
	prompt: string;
	cwd?: string;
	signal?: AbortSignal;
}

export interface RuntimeRolePrepared {
	session: RuntimeSession;
	directory: string;
	startedAt: number;
}

export interface RuntimeRoleStreamOutput {
	status: string;
	text: string;
	terminalText: string;
	artifacts: string[];
}

export interface RuntimeRoleContext<TRole extends string = string> {
	route: RuntimeRoute;
	role: TRole;
	prompt: string;
	cwd?: string;
	signal?: AbortSignal;
	startedAt: number;
	directory: string;
	session?: RuntimeSession;
	status: string;
	text: string;
	terminalText: string;
	artifacts: string[];
	streamError?: unknown;
	result?: RuntimeRoleResult<TRole>;
	error?: Error;
}

/**
 * Explicit XState v5 state machine for an external agent-runtime session
 * (`cursor` or `droid`).
 *
 * States:
 * - `preparing`: resolves working directory and creates the isolated runtime session.
 * - `streaming`: sends the isolated prompt and collects `text`, `completed`, `artifact`, `settled` events.
 * - `closing`: unconditionally closes the runtime session (ignoring close errors so primary errors surface).
 * - `completed` (final): produces `RuntimeRoleResult`.
 * - `cancelled` (final): signal aborted or runtime settled with `cancelled` / `aborted`.
 * - `failed` (final): preparation, streaming, or terminal status failure.
 */
export function createRuntimeRoleMachine<TRole extends string = string>() {
	return setup({
		types: {
			input: {} as RuntimeRoleInput<TRole>,
			context: {} as RuntimeRoleContext<TRole>,
		},
		actors: {
			prepareSession: fromPromise<
				RuntimeRolePrepared,
				{
					route: RuntimeRoute;
					role: TRole;
					cwd?: string;
					signal?: AbortSignal;
				}
			>(async () => {
				throw new Error("prepareSession actor must be provided");
			}),
			streamEvents: fromPromise<
				RuntimeRoleStreamOutput,
				{
					route: RuntimeRoute;
					role: TRole;
					prompt: string;
					directory: string;
					session: RuntimeSession;
					signal?: AbortSignal;
				}
			>(async () => {
				throw new Error("streamEvents actor must be provided");
			}),
			closeSession: fromPromise<void, { sessionId: string }>(async () => {}),
		},
		guards: {
			isAborted: ({ context }) => context.signal?.aborted === true,
			hasStreamError: ({ context }) => context.streamError !== undefined,
			isCancelledOutcome: ({ context }) =>
				context.signal?.aborted === true ||
				["cancelled", "aborted"].includes(context.status),
			isFailedOutcome: ({ context }) =>
				!["completed", "finished"].includes(context.status),
		},
		actions: {
			recordPrepared: assign(({ event }) => {
				const output = actorOutput<RuntimeRolePrepared>(event);
				return {
					session: output.session,
					directory: output.directory,
					startedAt: output.startedAt,
				};
			}),
			recordStreamed: assign(({ event }) => {
				const output = actorOutput<RuntimeRoleStreamOutput>(event);
				return {
					status: output.status,
					text: output.text,
					terminalText: output.terminalText,
					artifacts: output.artifacts,
				};
			}),
			recordStreamError: assign({
				streamError: ({ event }) => actorError(event),
			}),
			recordPrepareError: assign({
				error: ({ event }) => {
					const err = actorError(event);
					return err instanceof Error ? err : new Error(messageOf(err));
				},
			}),
			recordFinalFailure: assign({
				error: ({ context }) => {
					if (context.streamError !== undefined) {
						return context.streamError instanceof Error
							? context.streamError
							: new Error(messageOf(context.streamError));
					}
					return new Error(
						`External role ${context.role} failed: ${context.status}`,
					);
				},
			}),
			recordCancelled: assign({
				error: () => new Error("role team was cancelled"),
			}),
			recordCompleted: assign({
				result: ({ context }) => {
					const session = context.session!;
					const captured = context.text.trim()
						? context.text
						: context.terminalText.slice(-14000);
					return {
						role: context.role,
						route: context.route,
						childName: session.id,
						status: context.status,
						text: captured,
						cwd: session.cwd,
						runtimeSessionId: session.id,
						artifacts: context.artifacts,
						durationMs: Date.now() - context.startedAt,
						diagnostic: `Isolated result: ${session.cwd}${context.artifacts.length ? `; artifacts: ${context.artifacts.join(", ")}` : ""}. Changes have not been applied to the source workspace.`,
					};
				},
			}),
		},
	}).createMachine({
		id: "runtimeRole",
		initial: "preparing",
		context: ({ input }) => ({
			route: input.route,
			role: input.role,
			prompt: input.prompt,
			cwd: input.cwd,
			signal: input.signal,
			startedAt: Date.now(),
			directory: input.cwd ?? "",
			status: "completed",
			text: "",
			terminalText: "",
			artifacts: [],
		}),
		states: {
			preparing: {
				invoke: {
					src: "prepareSession",
					input: ({ context }) => ({
						route: context.route,
						role: context.role,
						cwd: context.cwd,
						signal: context.signal,
					}),
					onDone: [
						{
							guard: "isAborted",
							target: "closing",
							actions: ["recordPrepared", "recordCancelled"],
						},
						{
							target: "streaming",
							actions: "recordPrepared",
						},
					],
					onError: [
						{
							guard: "isAborted",
							target: "cancelled",
							actions: "recordCancelled",
						},
						{
							target: "failed",
							actions: "recordPrepareError",
						},
					],
				},
			},
			streaming: {
				invoke: {
					src: "streamEvents",
					input: ({ context }) => ({
						route: context.route,
						role: context.role,
						prompt: context.prompt,
						directory: context.directory,
						session: context.session!,
						signal: context.signal,
					}),
					onDone: {
						target: "closing",
						actions: "recordStreamed",
					},
					onError: {
						target: "closing",
						actions: "recordStreamError",
					},
				},
			},
			closing: {
				invoke: {
					src: "closeSession",
					input: ({ context }) => ({ sessionId: context.session!.id }),
					onDone: [
						{
							guard: "isCancelledOutcome",
							target: "cancelled",
							actions: "recordCancelled",
						},
						{
							guard: "hasStreamError",
							target: "failed",
							actions: "recordFinalFailure",
						},
						{
							guard: "isFailedOutcome",
							target: "failed",
							actions: "recordFinalFailure",
						},
						{
							target: "completed",
							actions: "recordCompleted",
						},
					],
					onError: [
						{
							guard: "isCancelledOutcome",
							target: "cancelled",
							actions: "recordCancelled",
						},
						{
							guard: "hasStreamError",
							target: "failed",
							actions: "recordFinalFailure",
						},
						{
							guard: "isFailedOutcome",
							target: "failed",
							actions: "recordFinalFailure",
						},
						{
							target: "completed",
							actions: "recordCompleted",
						},
					],
				},
			},
			completed: {
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

export const runtimeRoleMachine = createRuntimeRoleMachine();
