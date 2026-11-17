import type { RuntimeRoute } from "./runtime-role.js";

export interface BackgroundAgent {
	session?: { id?: string };
}

export interface BackgroundChild {
	id: string;
	name?: string;
	runtime?: string;
	activity?: string;
}

export interface BackgroundStage {
	role: string;
	route?: RuntimeRoute | null;
	status: string;
	roleStatus?: string;
	startedAt?: number;
	durationMs?: number;
}

export interface BackgroundComment {
	role: string;
	approved: boolean;
	summary: string;
	issues?: Array<{ severity: string; detail: string }>;
}

export interface BackgroundDecision {
	choice: string;
	route?: RuntimeRoute | null;
	note?: string;
}

export interface BackgroundRunSummary {
	runId: string;
	status: string;
	task: string;
	startedAt: number;
	finishedAt?: number;
	currentRole?: string | null;
	phase?: string;
}

export interface BackgroundRunState {
	tool?: string;
	task?: string;
	startedAt?: number;
	updatedAt?: number;
	stages?: BackgroundStage[];
	currentRole?: string | null;
	child?: BackgroundChild;
	progress?: string;
	phase?: string;
	comments?: BackgroundComment[];
	decisions?: BackgroundDecision[];
}

export interface BackgroundOutcome {
	status: string;
	report: string;
	stages?: BackgroundStage[];
	comments?: BackgroundComment[];
	decisions?: BackgroundDecision[];
}

export interface BackgroundRunOptions {
	task: string;
}

export interface BackgroundChildTarget {
	id: string;
	signal: AbortSignal;
}

export interface BackgroundContext<
	Agent extends BackgroundAgent = BackgroundAgent,
> {
	get(
		name: "agents",
	): { get(id: string): { status?: string } | undefined } | undefined;
	get(name: "subagents"):
		| {
				sendMessage?(
					agent: Agent | undefined,
					id: string,
					content: Array<{ type: "text"; text: string }>,
					options: { signal: AbortSignal },
				): Promise<unknown>;
		  }
		| undefined;
}

interface BackgroundJob<State, Outcome> {
	id: string;
	owner: string;
	task: string;
	status: string;
	startedAt: number;
	finishedAt?: number;
	controller: AbortController;
	lastState?: State;
	outcome?: Outcome;
	child?: BackgroundChildTarget;
	error?: string;
	done: Promise<void>;
}

/** Background work belongs to the plugin lifetime, rather than one chat turn. */
export function createBackgroundRuns<
	Agent extends BackgroundAgent,
	Options extends BackgroundRunOptions,
	State extends BackgroundRunState,
	Outcome extends BackgroundOutcome,
>(
	ctx: BackgroundContext<Agent>,
	run: (
		options: Options & {
			agent: Agent;
			callId: string;
			signal: AbortSignal;
			onState: (state: State) => void;
			onChild: (child: BackgroundChildTarget | undefined) => void;
		},
	) => Promise<Outcome>,
	stateOf: (id: string) => State | undefined,
	onComplete?: (info: {
		runId: string;
		owner: string;
		status: string;
		task: string;
		report?: string;
	}) => void,
) {
	const jobs = new Map<string, BackgroundJob<State, Outcome>>();
	let closed = false;
	const active = (job: BackgroundJob<State, Outcome>) =>
		job.status === "running" || job.status === "cancelling";
	const ownerOf = (agent: Agent | undefined) => {
		const id = agent?.session?.id;
		if (typeof id !== "string" || !id)
			throw new Error("role team needs a calling session");
		return id;
	};
	const find = (agent: Agent | undefined, id?: string) => {
		const owner = ownerOf(agent);
		const job = id
			? jobs.get(id)
			: [...jobs.values()].reverse().find((item) => item.owner === owner);
		if (!job || job.owner !== owner)
			throw new Error("No role-team run found in this session");
		return job;
	};
	function summarize(job: BackgroundJob<State, Outcome>): BackgroundRunSummary {
		const live = stateOf(job.id) ?? job.lastState;
		return {
			runId: job.id,
			status: job.status,
			task: job.task,
			startedAt: job.startedAt,
			...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
			currentRole: live?.currentRole ?? null,
			...(live?.phase ? { phase: live.phase } : {}),
		};
	}
	function snapshot(job: BackgroundJob<State, Outcome>) {
		const live = stateOf(job.id) ?? job.lastState;
		const child = live?.child;
		const activity = child?.id
			? ctx.get("agents")?.get(child.id)?.status
			: undefined;
		const stages = live?.stages ?? job.outcome?.stages ?? [];
		const comments = job.outcome?.comments ?? live?.comments ?? [];
		const latestComment = comments.at(-1);
		const routeText = (route: RuntimeRoute | null | undefined) =>
			route === null || route === undefined
				? ""
				: `${route.runtime && route.runtime !== "native" ? `${route.runtime}:` : ""}${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : ` @${route.reasoningEffort}`}`;
		const route = stages.at(-1)?.route;
		return {
			...live,
			runId: job.id,
			tool: "roles_start",
			task: job.task,
			status: job.status,
			startedAt: job.startedAt,
			...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
			stages,
			currentRole: live?.currentRole ?? null,
			...(child
				? { child: { ...child, ...(activity ? { activity } : {}) } }
				: {}),
			comments,
			decisions: job.outcome?.decisions ?? live?.decisions ?? [],
			text:
				job.outcome?.report ??
				[
					job.error ?? `Role team: ${job.status.toUpperCase()} · ${job.id}`,
					`Task: ${job.task}`,
					`Stage: ${live?.currentRole ?? live?.phase ?? (active(job) ? "preparing" : (stages.at(-1)?.role ?? job.status))}`,
					...(stages.length > 0
						? stages
								.filter(
									(stage) => stage.route !== null && stage.route !== undefined,
								)
								.map(
									(stage) =>
										`Routes: ${stage.role} · ${routeText(stage.route)} · ${stage.roleStatus ?? stage.status}${stage.durationMs === undefined ? "" : ` · ${Math.round(stage.durationMs / 1000)}s`}`,
								)
						: route
							? [`Routes: ${routeText(route)}`]
							: []),
					...(stages.length
						? [
								`Stages: ${stages.map((stage) => `${stage.role} (${stage.roleStatus ?? stage.status})`).join(" → ")}`,
							]
						: []),
					...(child
						? [
								`Agent: ${child.name ?? child.id}${activity ? ` (${activity})` : ""}`,
							]
						: []),
					...(live?.progress ? [`Latest activity: ${live.progress}`] : []),
					...(latestComment
						? [
								`Latest ${latestComment.role}: ${latestComment.approved ? "approved" : "changes required"} · ${latestComment.summary}`,
								...(latestComment.issues ?? [])
									.slice(0, 3)
									.map((issue) => `[${issue.severity}] ${issue.detail}`),
							]
						: []),
				].join("\n"),
		};
	}
	return {
		start(agent: Agent | undefined, id: string, options: Options) {
			if (closed) throw new Error("role team is shutting down");
			const owner = ownerOf(agent);
			if (
				[...jobs.values()].some((job) => job.owner === owner && active(job))
			) {
				throw new Error(
					"A role-team run is already active in this session; use roles_status",
				);
			}
			// Retain recent outcomes for follow-up questions, without an unbounded history.
			for (const [key, job] of jobs) {
				if (jobs.size < 100) break;
				if (!active(job)) jobs.delete(key);
			}
			const job: BackgroundJob<State, Outcome> = {
				id,
				owner,
				task: options.task.replace(/\s+/g, " ").slice(0, 300),
				status: "running",
				startedAt: Date.now(),
				controller: new AbortController(),
				done: Promise.resolve(),
			};
			jobs.set(id, job);
			job.done = Promise.resolve()
				.then(() =>
					run({
						...options,
						agent: agent as Agent,
						callId: id,
						signal: job.controller.signal,
						onState: (state) => {
							job.lastState = state;
						},
						onChild: (child) => {
							job.child = child;
						},
					}),
				)
				.then((outcome) => {
					job.outcome = outcome;
					job.status = job.controller.signal.aborted
						? "cancelled"
						: outcome.status;
				})
				.catch((error) => {
					job.status = job.controller.signal.aborted ? "cancelled" : "failed";
					job.error = `Role team: ${job.status.toUpperCase()} · ${error instanceof Error ? error.message : String(error)}`;
				})
				.finally(() => {
					job.finishedAt = Date.now();
					try {
						onComplete?.({
							runId: job.id,
							owner: job.owner,
							status: job.status,
							task: job.task,
							report: job.outcome?.report ?? job.error,
						});
					} catch {
						// Completion listeners must not fail background settlement.
					}
				});
			return snapshot(job);
		},
		list(agent: Agent | undefined, limit = 10): BackgroundRunSummary[] {
			const owner = ownerOf(agent);
			return [...jobs.values()]
				.filter((item) => item.owner === owner)
				.reverse()
				.slice(0, Math.max(1, limit))
				.map(summarize);
		},
		async status(
			agent: Agent | undefined,
			id?: string,
			question?: string,
			signal?: AbortSignal,
		) {
			const job = find(agent, id);
			if (question) {
				const child = stateOf(job.id)?.child;
				const target = job.child;
				if (
					job.status !== "running" ||
					!child?.id ||
					child.runtime ||
					target?.id !== child.id ||
					target.signal.aborted
				) {
					throw new Error(
						"No active native role agent to ask; read its latest progress instead",
					);
				}
				const subagents = ctx.get("subagents");
				if (typeof subagents?.sendMessage !== "function")
					throw new Error("This Host cannot message role agents");
				const admissionSignal = AbortSignal.any([
					job.controller.signal,
					target.signal,
					...(signal ? [signal] : []),
				]);
				await subagents.sendMessage(
					agent,
					child.id,
					[
						{
							type: "text",
							text: `The orchestrator requests a brief progress update: ${question}\nReport progress and blockers, then continue the assigned role. Preserve the required final output format.`,
						},
					],
					{ signal: admissionSignal },
				);
			}
			const result = snapshot(job);
			return {
				...result,
				...(question
					? {
							questionSent: true,
							text: `${result.text}\nProgress question accepted by the child's inbox; read status again for its response.`,
						}
					: {}),
			};
		},
		cancel(agent: Agent | undefined, id?: string) {
			const job = find(agent, id);
			if (active(job)) {
				job.status = "cancelling";
				job.controller.abort();
			}
			return snapshot(job);
		},
		cancelById(id: string) {
			const job = jobs.get(id);
			if (!job) return undefined;
			if (active(job)) {
				job.status = "cancelling";
				job.controller.abort();
			}
			return snapshot(job);
		},
		publicState(id: string) {
			const job = jobs.get(id);
			return job ? snapshot(job) : undefined;
		},
		async dispose() {
			closed = true;
			for (const job of jobs.values()) if (active(job)) job.controller.abort();
			await Promise.all([...jobs.values()].map((job) => job.done));
			jobs.clear();
		},
	};
}
