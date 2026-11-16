export interface RuntimeRoute {
	provider: string;
	model: string;
	runtime?: string;
	reasoningEffort?: string;
}

export interface RuntimeSession {
	id: string;
	cwd: string;
}

export type RuntimeEvent =
	| { type: "text"; text?: string }
	| { type: "completed"; status?: string; text?: string }
	| { type: "artifact"; path?: string }
	| { type: "settled"; status: string };

export interface RuntimeService<Agent extends object = object> {
	list(): Promise<{ runtimes: Array<{ id: string }> }>;
	create(
		options: RuntimeRoute & { cwd: string },
		context: { parent: Agent; signal?: AbortSignal },
	): Promise<RuntimeSession>;
	send(
		id: string,
		message: { text: string },
		context: { parent: Agent; signal?: AbortSignal },
	): AsyncIterable<RuntimeEvent>;
	close(id: string): Promise<void>;
}

export interface RuntimeContext<Agent extends object = object> {
	get(name: "agentRuntime"): RuntimeService<Agent> | undefined;
	get(
		name: "workingDirectory",
	):
		| { ensure(parent: Agent, signal?: AbortSignal): Promise<string> }
		| undefined;
}

export interface RuntimeActivity {
	child?: { id: string; name: string; runtime?: string };
	progress?: string;
}

export interface RuntimeRoleResult<Role extends string = string> {
	role: Role;
	route: RuntimeRoute;
	childName: string;
	status: string;
	text: string;
	cwd: string;
	runtimeSessionId: string;
	artifacts: string[];
	durationMs: number;
	diagnostic: string;
}

/** Executes external role routes without changing the existing native LLM path. */
export async function validateRuntimeRoute<Agent extends object>(
	ctx: RuntimeContext<Agent>,
	route: RuntimeRoute,
): Promise<void> {
	const service = ctx.get("agentRuntime");
	if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`);
	const listing = await service.list();
	if (!listing.runtimes.some((runtime) => runtime.id === route.runtime))
		throw new Error(`Runtime unavailable: ${route.runtime}`);
}

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
	const service = ctx.get("agentRuntime");
	if (!service) throw new Error(`Runtime unavailable: ${route.runtime}`);
	const directory =
		cwd ?? (await ctx.get("workingDirectory")?.ensure(parent, signal));
	if (!directory) throw new Error("Role runtime requires a working directory");
	const startedAt = Date.now();
	const session = await service.create(
		{
			runtime: route.runtime,
			cwd: directory,
			model: route.model,
			provider: route.provider,
			reasoningEffort: route.reasoningEffort,
		},
		{ parent, signal },
	);
	onActivity?.({
		child: { id: session.id, name: session.id, runtime: route.runtime },
		progress: `${role.toUpperCase()} started`,
	});
	const isolatedPrompt = `Execution workspace: ${session.cwd}. Work exclusively in this isolated copy; do not edit the source workspace ${directory}.\n\n${prompt.replace(/^Workspace: .*$/m, `Workspace: ${session.cwd}`)}`;
	let text = "";
	let terminalText = "";
	let status = "completed";
	const artifacts: string[] = [];
	try {
		for await (const event of service.send(
			session.id,
			{ text: isolatedPrompt },
			{ parent, signal },
		)) {
			if (event.type === "text") {
				text = `${text}${event.text ?? ""}`.slice(-14000);
				onActivity?.({ progress: text.slice(-1800) });
			}
			if (event.type === "completed") {
				status = event.status ?? "completed";
				terminalText = typeof event.text === "string" ? event.text : "";
			}
			if (event.type === "artifact" && event.path) artifacts.push(event.path);
			if (event.type === "settled") status = event.status;
		}
	} finally {
		await service.close(session.id);
	}
	if (signal?.aborted || ["cancelled", "aborted"].includes(status))
		throw new Error("role team was cancelled");
	if (!["completed", "finished"].includes(status))
		throw new Error(`External role ${role} failed: ${status}`);
	return {
		role,
		route,
		childName: session.id,
		status,
		text: text || terminalText.slice(-14000),
		cwd: session.cwd,
		runtimeSessionId: session.id,
		artifacts,
		durationMs: Date.now() - startedAt,
		diagnostic: `Isolated result: ${session.cwd}${artifacts.length ? `; artifacts: ${artifacts.join(", ")}` : ""}. Changes have not been applied to the source workspace.`,
	};
}
