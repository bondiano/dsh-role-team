import { type ActorRefFrom, createActor } from "xstate";
import { formatRoute } from "../domain/config.js";
import {
	backgroundJobPublicStatus,
	createBackgroundJobMachine,
	isBackgroundJobActive,
} from "../domain/machines/background-job.machine.js";
import type {
	BackgroundAgent,
	BackgroundChildTarget,
	BackgroundContext,
	BackgroundOutcome,
	BackgroundRunOptions,
	BackgroundRunState,
	BackgroundRunSummary,
} from "../domain/types.js";

export type {
	BackgroundAgent,
	BackgroundChild,
	BackgroundChildTarget,
	BackgroundComment,
	BackgroundContext,
	BackgroundDecision,
	BackgroundOutcome,
	BackgroundRunOptions,
	BackgroundRunState,
	BackgroundRunSummary,
	BackgroundStage,
} from "../domain/types.js";

interface ManagedJob<
	State extends BackgroundRunState,
	Outcome extends BackgroundOutcome,
> {
	actor: ActorRefFrom<
		ReturnType<typeof createBackgroundJobMachine<State, Outcome>>
	>;
	done: Promise<void>;
}

/**
 * Background work belongs to the plugin lifetime rather than one chat turn.
 * Each run's lifecycle is governed by an explicit `backgroundJobMachine` actor.
 */
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
	const machine = createBackgroundJobMachine<State, Outcome>();
	const jobs = new Map<string, ManagedJob<State, Outcome>>();
	let closed = false;

	const jobSnapshot = (job: ManagedJob<State, Outcome>) =>
		job.actor.getSnapshot();
	const isActive = (job: ManagedJob<State, Outcome>) =>
		isBackgroundJobActive(jobSnapshot(job));

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
			: [...jobs.values()]
					.reverse()
					.find((item) => jobSnapshot(item).context.owner === owner);
		if (!job || jobSnapshot(job).context.owner !== owner)
			throw new Error("No role-team run found in this session");
		return job;
	};

	function summarize(job: ManagedJob<State, Outcome>): BackgroundRunSummary {
		const snap = jobSnapshot(job);
		const jobCtx = snap.context;
		const status = backgroundJobPublicStatus(snap);
		const live = stateOf(jobCtx.id) ?? jobCtx.lastState;
		return {
			runId: jobCtx.id,
			status,
			task: jobCtx.task,
			startedAt: jobCtx.startedAt,
			...(jobCtx.finishedAt ? { finishedAt: jobCtx.finishedAt } : {}),
			currentRole: live?.currentRole ?? null,
			...(live?.phase ? { phase: live.phase } : {}),
		};
	}

	function snapshot(job: ManagedJob<State, Outcome>) {
		const snap = jobSnapshot(job);
		const jobCtx = snap.context;
		const status = backgroundJobPublicStatus(snap);
		const active = isBackgroundJobActive(snap);
		const live = stateOf(jobCtx.id) ?? jobCtx.lastState;
		const child = live?.child;
		const activity = child?.id
			? ctx.get("agents")?.get(child.id)?.status
			: undefined;
		const stages = live?.stages ?? jobCtx.outcome?.stages ?? [];
		const comments = jobCtx.outcome?.comments ?? live?.comments ?? [];
		const latestComment = comments.at(-1);
		const route = stages.at(-1)?.route;
		return {
			...live,
			runId: jobCtx.id,
			tool: "roles_start",
			task: jobCtx.task,
			status,
			startedAt: jobCtx.startedAt,
			...(jobCtx.finishedAt ? { finishedAt: jobCtx.finishedAt } : {}),
			stages,
			currentRole: live?.currentRole ?? null,
			...(child
				? { child: { ...child, ...(activity ? { activity } : {}) } }
				: {}),
			comments,
			decisions: jobCtx.outcome?.decisions ?? live?.decisions ?? [],
			text:
				jobCtx.outcome?.report ??
				[
					jobCtx.error ?? `Role team: ${status.toUpperCase()} · ${jobCtx.id}`,
					`Task: ${jobCtx.task}`,
					`Stage: ${live?.currentRole ?? live?.phase ?? (active ? "preparing" : (stages.at(-1)?.role ?? status))}`,
					...(stages.length > 0
						? stages
								.filter(
									(stage) => stage.route !== null && stage.route !== undefined,
								)
								.map(
									(stage) =>
										`Routes: ${stage.role} · ${formatRoute(stage.route)} · ${stage.roleStatus ?? stage.status}${stage.durationMs === undefined ? "" : ` · ${Math.round(stage.durationMs / 1000)}s`}`,
								)
						: route
							? [`Routes: ${formatRoute(route)}`]
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
				[...jobs.values()].some(
					(job) => jobSnapshot(job).context.owner === owner && isActive(job),
				)
			) {
				throw new Error(
					"A role-team run is already active in this session; use roles_status",
				);
			}
			// Retain recent outcomes for follow-up questions without unbounded growth.
			for (const [key, job] of jobs) {
				if (jobs.size < 100) break;
				if (!isActive(job)) {
					job.actor.stop();
					jobs.delete(key);
				}
			}
			const controller = new AbortController();
			const actor = createActor(machine, {
				input: {
					id,
					owner,
					task: options.task.replace(/\s+/g, " ").slice(0, 300),
					startedAt: Date.now(),
					controller,
				},
			});
			actor.start();
			const job: ManagedJob<State, Outcome> = {
				actor,
				done: Promise.resolve(),
			};
			jobs.set(id, job);
			job.done = Promise.resolve()
				.then(() =>
					run({
						...options,
						agent: agent as Agent,
						callId: id,
						signal: controller.signal,
						onState: (state) => {
							actor.send({ type: "STATE_UPDATED", state });
						},
						onChild: (child) => {
							actor.send({ type: "CHILD_CHANGED", child });
						},
					}),
				)
				.then((outcome) => {
					actor.send({ type: "SETTLE", outcome });
				})
				.catch((error) => {
					actor.send({ type: "FAIL", error });
				})
				.finally(() => {
					const settledSnap = actor.getSnapshot();
					const settledCtx = settledSnap.context;
					try {
						onComplete?.({
							runId: settledCtx.id,
							owner: settledCtx.owner,
							status: backgroundJobPublicStatus(settledSnap),
							task: settledCtx.task,
							report: settledCtx.outcome?.report ?? settledCtx.error,
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
				.filter((item) => jobSnapshot(item).context.owner === owner)
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
			const snap = jobSnapshot(job);
			const jobCtx = snap.context;
			if (question) {
				const child = stateOf(jobCtx.id)?.child;
				const target = jobCtx.child;
				if (
					snap.value !== "running" ||
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
					jobCtx.controller.signal,
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
			if (isActive(job)) job.actor.send({ type: "CANCEL" });
			return snapshot(job);
		},
		cancelById(id: string) {
			const job = jobs.get(id);
			if (!job) return undefined;
			if (isActive(job)) job.actor.send({ type: "CANCEL" });
			return snapshot(job);
		},
		publicState(id: string) {
			const job = jobs.get(id);
			return job ? snapshot(job) : undefined;
		},
		async dispose() {
			closed = true;
			for (const job of jobs.values()) {
				if (isActive(job)) job.actor.send({ type: "CANCEL" });
			}
			await Promise.all([...jobs.values()].map((job) => job.done));
			for (const job of jobs.values()) {
				job.actor.stop();
			}
			jobs.clear();
		},
	};
}
