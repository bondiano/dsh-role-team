/**
 * Role team for DeepSeek Harness.
 *
 * Ports the four-role working model of omp (oh-my-pi) to DSH: a smart PLAN
 * produces the plan, WORKER implements it in the shared workspace, ADVISOR
 * audits each worker attempt from a different model family, and REVIEWER is
 * the final independent gate that runs only after WORKER reports completion
 * and ADVISOR approves. Every role is a real DSH subagent, so it has its own
 * context, tools and model route; the route for each role is configurable and
 * may use any registered provider.
 *
 * @module @local/dsh-role-team
 */

import { createBackgroundRuns } from "./background-runs.js";
import {
	handleRolePlanCommand,
	registerRolePlanCommand,
	registerRolesCommand,
	saveRoleRoute,
	saveTeamSettings,
} from "./commands.js";
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
} from "./config.js";
import {
	handlePlanSessionRequest,
	handleRolesHttp,
	handleRolesRoute,
	handleRunStateRequest,
} from "./http.js";
import { runRoleTeam } from "./orchestrator.js";
import {
	buildAdvisorPrompt,
	buildPlanAuditPrompt,
	buildPlanPrompt,
	buildPlanRevisionPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
} from "./prompts.js";
import { disposePluginState, runStateOf, stateFor } from "./state.js";
import { buildTools, registerTool } from "./tools.js";
import type {
	Agent,
	HostContext,
	RunOptions,
	RunState,
	TeamOutcome,
} from "./types.js";
import {
	normalizeSeverity,
	parseVerdict,
	parseWorkerStatus,
} from "./verdict.js";
import { authenticatedWebServer } from "./web-route-auth.js";

export {
	buildAdvisorPrompt,
	buildPlanAuditPrompt,
	buildPlanPrompt,
	buildPlanRevisionPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
	familyOf,
	formatRoute,
	handlePlanSessionRequest,
	handleRolePlanCommand,
	handleRolesRoute,
	handleRunStateRequest,
	normalizeRoute,
	normalizeSeverity,
	parseVerdict,
	parseWorkerStatus,
	ROLE_NAMES,
	resolveRoleTeamConfig,
	roleTeamSnapshot,
	runRoleTeam,
	runStateOf,
	saveRoleRoute,
	saveTeamSettings,
	structuredFamilyWarnings,
};

/**
 * Services this plugin requires. Everything else (`subagents`, `llm`,
 * `commands`, `configEditor`, `workingDirectory`) is optional and read with
 * `ctx.get()`, so the plugin still loads in a minimal composition.
 */
export const inject = ["tools", "systemPrompt"];

/**
 * Install the role team surface.
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
		const webServer = authenticatedWebServer(routeCtx, routeCtx.webServer);
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
			? ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT") + 10
			: 2810;
	ctx.effect(() =>
		ctx.systemPrompt.section({
			name: "tool:role-team",
			order,
			text: ROLE_GUIDANCE,
		}),
	);
}
