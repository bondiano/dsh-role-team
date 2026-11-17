import { createActor, fromPromise, toPromise } from "xstate";
import { messageOf } from "../domain/config.js";
import { createRuntimeRoleMachine } from "../domain/machines/runtime-role.machine.js";
import type {
	RuntimeActivity,
	RuntimeContext,
	RuntimeRoleResult,
	RuntimeRoute,
} from "../domain/types.js";

export type {
	RuntimeActivity,
	RuntimeContext,
	RuntimeEvent,
	RuntimeRoleResult,
	RuntimeRoute,
	RuntimeService,
	RuntimeSession,
} from "../domain/types.js";

/** Verify that a configured external agent runtime exists on the host. */
export async function validateRuntimeRoute<Agent extends object>(
	ctx: RuntimeContext<Agent>,
	route: RuntimeRoute,
): Promise<void> {
	const service = ctx.get("agentRuntime");
	if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`);
	const listing = await service.list();
	if (!listing.runtimes.some((runtime) => runtime.id === route.runtime)) {
		throw new Error(`Runtime unavailable: ${route.runtime}`);
	}
}

/**
 * Execute one role inside an isolated external runtime session (`cursor` or
 * `droid`) driven by the explicit `runtimeRoleMachine` XState state machine.
 */
export async function runRuntimeRole<Agent extends object, Role extends string>(
	ctx: RuntimeContext<Agent>,
	{
		route,
		role,
		prompt,
		parent,
		signal,
		cwd,
		onActivity,
	}: {
		route: RuntimeRoute;
		role: Role;
		prompt: string;
		parent: Agent;
		signal?: AbortSignal;
		cwd?: string;
		onActivity?: (activity: RuntimeActivity) => void;
	},
): Promise<RuntimeRoleResult<Role>> {
	if (signal?.aborted) throw new Error("role team was cancelled");
	const service = ctx.get("agentRuntime");
	if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`);

	const machine = createRuntimeRoleMachine<Role>().provide({
		actors: {
			prepareSession: fromPromise(async ({ input }) => {
				if (input.signal?.aborted) throw new Error("role team was cancelled");
				const directory =
					input.cwd ??
					(await ctx.get("workingDirectory")?.ensure(parent, input.signal));
				if (!directory) {
					throw new Error("Role runtime requires a working directory");
				}
				if (input.signal?.aborted) throw new Error("role team was cancelled");
				const startedAt = Date.now();
				const session = await service.create(
					{
						runtime: input.route.runtime,
						cwd: directory,
						model: input.route.model,
						provider: input.route.provider,
						reasoningEffort: input.route.reasoningEffort,
					},
					{ parent, signal: input.signal },
				);
				return { session, directory, startedAt };
			}),
			streamEvents: fromPromise(async ({ input }) => {
				onActivity?.({
					child: {
						id: input.session.id,
						name: input.session.id,
						runtime: input.route.runtime,
					},
					progress: `${input.role.toUpperCase()} started · ${input.route.runtime}:${input.route.provider}/${input.route.model}${input.route.reasoningEffort === undefined ? "" : ` @${input.route.reasoningEffort}`}`,
				});
				const isolatedPrompt = `Execution workspace: ${input.session.cwd}. Work exclusively in this isolated copy; do not edit the source workspace ${input.directory}.\n\n${input.prompt.replace(/^Workspace: .*$/m, `Workspace: ${input.session.cwd}`)}`;
				let text = "";
				let terminalText = "";
				let status = "completed";
				const artifacts: string[] = [];
				for await (const event of service.send(
					input.session.id,
					{ text: isolatedPrompt },
					{ parent, signal: input.signal },
				)) {
					if (input.signal?.aborted) {
						status = "cancelled";
						break;
					}
					if (event.type === "text") {
						text = `${text}${event.text ?? ""}`.slice(-14000);
						onActivity?.({ progress: text.slice(-1800) });
					}
					if (event.type === "completed") {
						status = event.status ?? "completed";
						terminalText = typeof event.text === "string" ? event.text : "";
					}
					if (event.type === "artifact" && event.path) {
						artifacts.push(event.path);
					}
					if (event.type === "settled") {
						status = event.status;
					}
				}
				return { status, text, terminalText, artifacts };
			}),
			closeSession: fromPromise(async ({ input }) => {
				try {
					await service.close(input.sessionId);
				} catch {
					// Disposal failure must not mask the captured runtime result or error.
				}
			}),
		},
	});

	const actor = createActor(machine, {
		input: { route, role, prompt, cwd, signal },
	});
	actor.start();
	await toPromise(actor);
	const snapshot = actor.getSnapshot();
	if (snapshot.value === "completed" && snapshot.context.result) {
		return snapshot.context.result;
	}
	throw (
		snapshot.context.error ??
		new Error(
			`External role ${role} ended unexpectedly (${messageOf(snapshot.value)})`,
		)
	);
}
