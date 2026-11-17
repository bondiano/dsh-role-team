import { cloneJson, LIMITS, resolveRoleTeamConfig } from "../domain/config.js";
import type {
	Agent,
	BackgroundRunsHandle,
	HostContext,
	Role,
	RoleTeamConfig,
	RunOptions,
	RunState,
	TeamOutcome,
} from "../domain/types.js";

export type BackgroundRuns = BackgroundRunsHandle<
	Agent,
	Omit<RunOptions, "agent">,
	Partial<RunState>,
	TeamOutcome
>;

export interface PluginState {
	rawConfig: unknown;
	config: RoleTeamConfig;
	runStates: Map<string, RunState>;
	planSessions: Map<string, number>;
	workerDoneSessions: Set<string>;
	workerDoneAgents: WeakSet<Agent>;
	childNameCounter: number;
	background?: BackgroundRuns;
}

const instanceStates = new WeakMap<HostContext, PluginState>();
const activeStates = new Set<PluginState>();

/**
 * Retrieve or initialize the isolated state for one HostContext instance.
 */
export function stateFor(
	ctx: HostContext,
	initialRawConfig?: unknown,
): PluginState {
	let state = instanceStates.get(ctx);
	if (!state) {
		const raw = initialRawConfig ?? ctx.fiber?.entry?.options?.config ?? {};
		state = {
			rawConfig: cloneJson(raw),
			config: resolveRoleTeamConfig(raw),
			runStates: new Map<string, RunState>(),
			planSessions: new Map<string, number>(),
			workerDoneSessions: new Set<string>(),
			workerDoneAgents: new WeakSet<Agent>(),
			childNameCounter: 0,
		};
		instanceStates.set(ctx, state);
		activeStates.add(state);
	} else if (initialRawConfig !== undefined) {
		state.rawConfig = cloneJson(initialRawConfig);
		state.config = resolveRoleTeamConfig(initialRawConfig);
	}
	return state;
}

/**
 * Update the live configuration of one HostContext instance so subsequent
 * reads, commands, and HTTP GETs see the persisted change immediately even
 * before a Host reload.
 */
export function updateConfigState(
	ctx: HostContext,
	nextRawConfig: unknown,
): RoleTeamConfig {
	const state = stateFor(ctx);
	state.rawConfig = cloneJson(nextRawConfig);
	state.config = resolveRoleTeamConfig(nextRawConfig);
	return state.config;
}

/**
 * Dispose and clear all in-memory state associated with one HostContext.
 */
export async function disposePluginState(ctx: HostContext): Promise<void> {
	const state = instanceStates.get(ctx);
	if (!state) return;
	activeStates.delete(state);
	try {
		await state.background?.dispose();
	} finally {
		state.runStates.clear();
		state.planSessions.clear();
		state.workerDoneSessions.clear();
		instanceStates.delete(ctx);
	}
}

/** Allocate a unique, valid subagent name for one role child. */
export function roleChildName(ctx: HostContext, role: Role): string {
	const state = stateFor(ctx);
	state.childNameCounter += 1;
	const stamp = Date.now().toString(36).slice(-5);
	return `${role}-${stamp}${state.childNameCounter.toString(36)}`.slice(0, 32);
}

/** Mark that a WORKER has completed work in the given agent's session. */
export function markWorkerDone(
	ctx: HostContext,
	agent: Agent | undefined,
): void {
	if (!agent) return;
	const state = stateFor(ctx);
	state.workerDoneAgents.add(agent);
	const sessionId = agent.session?.id;
	if (typeof sessionId === "string" && sessionId !== "") {
		if (state.workerDoneSessions.size >= 500) {
			const oldest = state.workerDoneSessions.values().next().value;
			if (oldest !== undefined) state.workerDoneSessions.delete(oldest);
		}
		state.workerDoneSessions.add(sessionId);
	}
}

/** Check whether a WORKER has reported completion in the given agent's session. */
export function hasWorkerReportedDone(
	ctx: HostContext,
	agent: Agent | undefined,
): boolean {
	if (!agent) return false;
	const state = stateFor(ctx);
	if (state.workerDoneAgents.has(agent)) return true;
	const sessionId = agent.session?.id;
	return (
		typeof sessionId === "string" &&
		sessionId !== "" &&
		state.workerDoneSessions.has(sessionId)
	);
}

/** Start the live state of one run. */
export function beginRunState(
	ctx: HostContext,
	callId: string | undefined,
	tool: string,
	task: string,
): RunState | undefined {
	if (callId === undefined) return undefined;
	const runState: RunState = {
		tool,
		task,
		startedAt: Date.now(),
		stages: [],
		currentRole: null,
	};
	stateFor(ctx).runStates.set(callId, runState);
	return runState;
}

/** Mutate the live state of one run if it is tracked. */
export function updateRunState(
	ctx: HostContext,
	callId: string | undefined,
	patch: Partial<RunState>,
): void {
	if (callId === undefined) return;
	const runState = stateFor(ctx).runStates.get(callId);
	if (runState) Object.assign(runState, patch, { updatedAt: Date.now() });
}

/** Mark one stage of a tracked run as running. */
export function beginRunStage(
	ctx: HostContext,
	callId: string | undefined,
	role: Role,
	route: RoleTeamConfig["roles"][Role],
): void {
	if (callId === undefined) return;
	const runState = stateFor(ctx).runStates.get(callId);
	if (runState === undefined) return;
	runState.stages.push({
		role,
		route: route === null ? null : { ...route },
		status: "running",
		startedAt: Date.now(),
	});
	runState.currentRole = role;
	delete runState.child;
	delete runState.progress;
	delete runState.phase;
}

/** Mark the running stage of one role as done. */
export function endRunStage(
	ctx: HostContext,
	callId: string | undefined,
	role: Role,
	roleStatus: string,
	durationMs: number,
	route?: RoleTeamConfig["roles"][Role],
): void {
	if (callId === undefined) return;
	const runState = stateFor(ctx).runStates.get(callId);
	if (runState === undefined) return;
	const stage = [...runState.stages]
		.reverse()
		.find((entry) => entry.role === role && entry.status === "running");
	if (stage !== undefined) {
		stage.status = "done";
		stage.roleStatus = roleStatus;
		stage.durationMs = durationMs;
		if (route !== undefined) stage.route = route === null ? null : { ...route };
	}
	if (runState.currentRole === role) runState.currentRole = null;
	delete runState.child;
}

/** Drop the live state of one run. */
export function endRunState(
	ctx: HostContext,
	callId: string | undefined,
): void {
	if (callId !== undefined) stateFor(ctx).runStates.delete(callId);
}

/**
 * The live state of one run, for tests and the run route.
 * Accepts an optional `ctx` for strict instance isolation while remaining
 * backwards-compatible with single-argument `runStateOf(callId)` calls.
 */
export function runStateOf(
	callId: string | undefined,
	ctx?: HostContext,
): RunState | undefined {
	if (callId === undefined) return undefined;
	if (ctx !== undefined) {
		const scoped = stateFor(ctx).runStates.get(callId);
		return scoped === undefined ? undefined : cloneJson(scoped);
	}
	for (const state of activeStates) {
		const found = state.runStates.get(callId);
		if (found !== undefined) return cloneJson(found);
	}
	return undefined;
}

/** Remember one plan session for auto-opening, dropping expired entries. */
export function rememberPlanSession(ctx: HostContext, sessionId: string): void {
	const planSessions = stateFor(ctx).planSessions;
	const now = Date.now();
	for (const [id, createdAt] of planSessions) {
		if (now - createdAt > LIMITS.planSessionTtlMs) planSessions.delete(id);
	}
	planSessions.set(sessionId, now);
}

/** Drop a plan session marker (e.g. when creation fails). */
export function forgetPlanSession(ctx: HostContext, sessionId: string): void {
	stateFor(ctx).planSessions.delete(sessionId);
}

/** Claim a remembered plan session once (returns true only on first claim). */
export function claimPlanSession(ctx: HostContext, sessionId: string): boolean {
	const planSessions = stateFor(ctx).planSessions;
	const now = Date.now();
	const createdAt = planSessions.get(sessionId);
	if (createdAt !== undefined) {
		planSessions.delete(sessionId);
		return now - createdAt <= LIMITS.planSessionTtlMs;
	}
	// Fallback across active instances if a shared server routes to a sibling ctx
	for (const state of activeStates) {
		const timestamp = state.planSessions.get(sessionId);
		if (timestamp !== undefined) {
			state.planSessions.delete(sessionId);
			return now - timestamp <= LIMITS.planSessionTtlMs;
		}
	}
	return false;
}
