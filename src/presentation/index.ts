/**
 * Role team for DeepSeek Harness — Cordis Plugin Entrypoint.
 *
 * Ports the four-role working model of omp (oh-my-pi) to DSH: a smart PLAN
 * produces the plan, WORKER implements it in the shared workspace, ADVISOR
 * audits the plan and each worker attempt from a different model family, and
 * REVIEWER is the final independent gate. Lifecycle orchestration, fallback
 * resolution, background jobs, and external runtime sessions are modeled as
 * explicit XState v5 state machines.
 *
 * @module @local/dsh-role-team/presentation
 */

import {
	handleRolePlanCommand,
	registerRolePlanCommand,
	registerRolesCommand,
	saveRoleFallbacks,
	saveRoleRoute,
	saveTeamSettings,
} from "../adapters/commands.js";
import {
	handlePlanSessionRequest,
	handleRolesHttp,
	handleRolesRoute,
	handleRunStateRequest,
} from "../adapters/http.js";
import {
	buildAdvisorPrompt,
	buildPlanAuditPrompt,
	buildPlanPrompt,
	buildPlanRevisionPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
} from "../adapters/prompts.js";
import { buildTools, registerTool } from "../adapters/tools.js";
import { createBackgroundRuns } from "../application/background-runs.js";
import { runRoleTeam } from "../application/orchestrator.js";
import {
	disposePluginState,
	runStateOf,
	stateFor,
} from "../application/state.js";
import {
	familyOf,
	formatRoute,
	normalizeRoute,
	PLAN_SESSION_ROUTE,
	ROLE_GUIDANCE,
	ROLE_NAMES,
	ROLES_SETTINGS_ROUTE,
	resolveRoleTeamConfig,
	roleTeamSnapshot,
	RUN_STATE_ROUTE,
	structuredFamilyWarnings,
} from "../domain/config.js";
import {
	backgroundJobMachine,
	backgroundJobPublicStatus,
	createBackgroundJobMachine,
	createRuntimeRoleMachine,
	isBackgroundJobActive,
	roleFallbackMachine,
	runtimeRoleMachine,
	teamPipelineMachine,
} from "../domain/machines/index.js";
import type {
	Agent,
	HostContext,
	RunOptions,
	RunState,
	TeamOutcome,
} from "../domain/types.js";
import {
	normalizeSeverity,
	parseVerdict,
	parseWorkerStatus,
} from "../domain/verdict.js";
import { authenticatedWebServer } from "../infrastructure/web-route-auth.js";

export {
	backgroundJobMachine,
	backgroundJobPublicStatus,
	buildAdvisorPrompt,
	buildPlanAuditPrompt,
	buildPlanPrompt,
	buildPlanRevisionPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
	createBackgroundJobMachine,
	createRuntimeRoleMachine,
	familyOf,
	formatRoute,
	handlePlanSessionRequest,
	handleRolePlanCommand,
	handleRolesRoute,
	handleRunStateRequest,
	isBackgroundJobActive,
	normalizeRoute,
	normalizeSeverity,
	parseVerdict,
	parseWorkerStatus,
	ROLE_NAMES,
	roleFallbackMachine,
	resolveRoleTeamConfig,
	roleTeamSnapshot,
	runRoleTeam,
	runStateOf,
	runtimeRoleMachine,
	saveRoleFallbacks,
	saveRoleRoute,
	saveTeamSettings,
	structuredFamilyWarnings,
	teamPipelineMachine,
};

/**
 * Services this plugin requires. Everything else (`subagents`, `llm`,
 * `commands`, `configEditor`, `workingDirectory`) is optional and read with
 * `ctx.get()`, so the plugin still loads in a minimal composition.
 */
export const inject = ["tools", "systemPrompt"];

/** Fallback system prompt order when `getSectionOrder` returns undefined. */
const FALLBACK_SUBAGENT_ORDER = 2800;

/**
 * Install the role team surface onto a Cordis HostContext.
 */
export function apply(ctx: HostContext, rawConfig: unknown = {}): void {
	const state = stateFor(ctx, rawConfig);
	const config = state.config;
	const background = createBackgroundRuns<
		Agent,
		Omit<RunOptions, "agent">,
		Partial<RunState>,
		TeamOutcome
	>(
		ctx,
		(options) => runRoleTeam(ctx, options),
		(id) => runStateOf(id, ctx),
		(info) => {
			ctx.logger?.info?.(
				`role-team: background run ${info.runId} (${info.owner}) settled with status=${info.status}`,
			);
		},
	);
	state.background = background;
	ctx.effect(() => () => disposePluginState(ctx));
	for (const problem of config.problems) {
		ctx.logger?.warn?.(`role-team: role ${problem.role} ${problem.message}`);
	}
	for (const tool of buildTools(ctx, config, background))
		registerTool(ctx, tool);
	registerRolesCommand(ctx, config, background);
	registerRolePlanCommand(ctx, config);
	ctx.inject(["webServer"], (routeCtx) => {
		const rawServer = routeCtx.webServer;
		if (!rawServer) return;
		const webServer = authenticatedWebServer(routeCtx, rawServer);
		routeCtx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: ROLES_SETTINGS_ROUTE,
					handler: (req, res) =>
						handleRolesHttp(ctx, req, res, stateFor(ctx).rawConfig),
				}),
			"role-team: settings route",
		);
		routeCtx.effect(
			() =>
				webServer.register({
					kind: "prefix",
					path: RUN_STATE_ROUTE,
					resource: (request) => handleRunStateRequest(ctx, request),
				}),
			"role-team: run state route",
		);
		routeCtx.effect(
			() =>
				webServer.register({
					kind: "prefix",
					path: PLAN_SESSION_ROUTE,
					resource: (request) => handlePlanSessionRequest(ctx, request),
				}),
			"role-team: plan session route",
		);
	});
	const order =
		typeof ctx.systemPrompt?.getSectionOrder === "function"
			? (ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") ??
					FALLBACK_SUBAGENT_ORDER) + 10
			: FALLBACK_SUBAGENT_ORDER + 10;
	ctx.effect(() =>
		ctx.systemPrompt.section({
			name: "tool:role-team",
			order,
			text: ROLE_GUIDANCE,
		}),
	);
}
