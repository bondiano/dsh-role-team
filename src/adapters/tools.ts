import { randomUUID } from "node:crypto";
import {
	runRoleTeam,
	runTrackedRole,
	structuredRoleResult,
} from "../application/orchestrator.js";
import {
	type BackgroundRuns,
	hasWorkerReportedDone,
	markWorkerDone,
	stateFor,
} from "../application/state.js";
import {
	clip,
	effectiveConfigWithRounds,
	isPlainObject,
	LIMITS,
	oneLine,
} from "../domain/config.js";
import type {
	HostContext,
	Role,
	RoleTeamConfig,
	TextBlock,
	ToolDefinition,
	ToolOutput,
	ToolValue,
} from "../domain/types.js";
import { parseVerdict, parseWorkerStatus } from "../domain/verdict.js";
import { validateRoute } from "../infrastructure/route-validation.js";
import {
	buildAdvisorPrompt,
	buildPlanPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
} from "./prompts.js";

/** Coerce a tool argument to a bounded string. */
function stringArg(
	args: unknown,
	field: string,
	options: { required: true; max?: number },
): string;
function stringArg(
	args: unknown,
	field: string,
	options?: { required?: boolean; max?: number },
): string | undefined;
function stringArg(
	args: unknown,
	field: string,
	{
		required = false,
		max = LIMITS.toolTaskChars,
	}: { required?: boolean; max?: number } = {},
): string | undefined {
	const value = isPlainObject(args) ? args[field] : undefined;
	if (value === undefined || value === null) {
		if (required) throw new Error(`\`${field}\` is required`);
		return undefined;
	}
	if (typeof value !== "string")
		throw new Error(`\`${field}\` must be a string`);
	const text = value.trim();
	if (text === "" && required)
		throw new Error(`\`${field}\` must be a non-empty string`);
	return text === "" ? undefined : clip(text, max);
}

/** The shared output declaration: every role tool returns one text report. */
function renderText(_args: unknown, value: ToolValue): TextBlock[] {
	return [{ type: "text", text: value.text }];
}

/** A JSON Schema fragment that accepts any value, for nullable optional fields. */
const LOOSE = Object.freeze({});

/** Pre-validate a single-role primary route only when no fallbacks are configured. */
async function prevalidateSingleRole(
	ctx: HostContext,
	config: RoleTeamConfig,
	role: Role,
	signal?: AbortSignal,
): Promise<void> {
	const primary = config.roles[role];
	if (primary !== null && (config.fallbacks[role] ?? []).length === 0) {
		await validateRoute(ctx, role, primary, signal);
	}
}

/** Canonical output of one single-role tool: the report text plus the stage facts. */
function singleRoleOutput(tool: string): ToolOutput {
	return {
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["text"],
			properties: {
				text: { type: "string" },
				role: { type: "string" },
				route: LOOSE,
				status: { type: "string" },
				durationMs: { type: "number" },
				verdict: LOOSE,
			},
		},
		render: renderText,
		presentationMeta: (_args, value) => ({
			v: 1,
			tool,
			role: value.role,
			route: value.route ?? null,
			status: value.status,
			durationMs: value.durationMs,
			...(value.verdict === undefined ? {} : { verdict: value.verdict }),
		}),
	};
}

/** Canonical output of `roles_run`: the report text plus the run's structure. */
const RUN_OUTPUT: ToolOutput = {
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string" },
			status: { type: "string" },
			task: { type: "string" },
			plan: { type: "string" },
			planAudits: { type: "array", items: LOOSE },
			stages: { type: "array", items: LOOSE },
			comments: { type: "array", items: LOOSE },
			decisions: { type: "array", items: LOOSE },
			rounds: { type: "array", items: LOOSE },
		},
	},
	render: renderText,
	presentationMeta: (_args, value) => ({
		v: 1,
		tool: "roles_run",
		status: value.status,
		task: value.task,
		stages: value.stages ?? [],
		comments: value.comments ?? [],
		decisions: value.decisions ?? [],
	}),
};

/** Register one tool with a caller context. */
export function registerTool(
	ctx: HostContext,
	definition: ToolDefinition,
): void {
	ctx.effect(() => ctx.tools.register(definition));
}

/** Build every model-facing tool for one resolved configuration. */
export function buildTools(
	ctx: HostContext,
	initialConfig: RoleTeamConfig,
	background: BackgroundRuns,
): ToolDefinition[] {
	const currentConfig = () => stateFor(ctx)?.config ?? initialConfig;
	const tools: ToolDefinition[] = [];
	tools.push({
		name: "roles_run",
		description:
			"Run the full PLAN -> WORKER -> ADVISOR -> REVIEWER team on one self-contained task and wait for the outcome. PLAN writes a rigorous plan, the ADVISOR audits that plan before WORKER starts (a rejected plan is revised from the advisor's issues), WORKER implements it in this shared workspace, ADVISOR audits every attempt from a different model family, and REVIEWER is the final gate whose approval is the only approved outcome. Rejected attempts are sent back to WORKER with the issues, up to the configured round limit; when the rounds run out without approval the run asks the user how to proceed (continue without approval, more rounds, a different worker model, or stop). The roles start as fresh agents without this conversation, so include every task detail, path, constraint and acceptance check they need. This call can take several minutes; it returns the plan, each attempt, each verdict and the final status.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description:
						"The complete task for the team, ideally the user request verbatim plus the exact acceptance criteria.",
				},
				context: {
					type: "string",
					description:
						"Additional facts the roles need: relevant files, constraints, prior decisions, environment notes. The roles do not see this conversation.",
				},
				plan: {
					type: "string",
					description:
						"Optional existing plan. When supplied, PLAN is skipped, the plan is audited by the ADVISOR, and WORKER implements it directly.",
				},
				max_rounds: {
					type: "integer",
					description: "Override the configured worker-attempt limit (1-6).",
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		output: RUN_OUTPUT,
		async execute(args, exec) {
			if (exec.agent === undefined)
				throw new Error("roles_run needs a calling agent");
			const task = stringArg(args, "task", { required: true });
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const effectiveConfig = effectiveConfigWithRounds(currentConfig(), args);
			const outcome = await runRoleTeam(ctx, {
				agent: exec.agent,
				task,
				context,
				plan,
				signal: exec.signal,
				config: effectiveConfig,
				callId: exec.callId,
				tool: "roles_run",
			});
			return {
				text: outcome.report,
				status: outcome.status,
				task: oneLine(task, 300),
				plan: clip(outcome.plan, LIMITS.planChars),
				planAudits: outcome.planAudits.map((audit) => ({
					pass: audit.pass,
					route: audit.route,
					durationMs: audit.durationMs,
					verdict: audit.verdict,
				})),
				stages: outcome.stages,
				comments: outcome.comments,
				decisions: outcome.decisions,
				rounds: outcome.rounds.map((round) => ({
					number: round.number,
					worker: {
						role: "worker",
						route: round.worker.route,
						status: round.worker.status,
						durationMs: round.worker.durationMs,
						...(round.worker.fallback === true ? { fallback: true } : {}),
						...(round.worker.cwd
							? {
									cwd: round.worker.cwd,
									artifacts: round.worker.artifacts ?? [],
									runtimeSessionId: round.worker.runtimeSessionId,
								}
							: {}),
					},
					...(round.advisor === undefined
						? {}
						: {
								advisor: {
									role: "advisor",
									route: round.advisor.route,
									status: round.advisor.status,
									durationMs: round.advisor.durationMs,
									...(round.advisor.fallback === true
										? { fallback: true }
										: {}),
								},
							}),
					...(round.reviewer === undefined
						? {}
						: {
								reviewer: {
									role: "reviewer",
									route: round.reviewer.route,
									status: round.reviewer.status,
									durationMs: round.reviewer.durationMs,
									...(round.reviewer.fallback === true
										? { fallback: true }
										: {}),
								},
							}),
				})),
			};
		},
	});
	const runParameters = tools[0]!.parameters;
	const backgroundOutput: ToolOutput = {
		schema: {
			type: "object",
			required: ["text"],
			properties: {
				text: { type: "string" },
				runId: { type: "string" },
				status: { type: "string" },
				task: { type: "string" },
				tool: { type: "string" },
				startedAt: { type: "number" },
				finishedAt: { type: "number" },
				updatedAt: { type: "number" },
				stages: { type: "array", items: LOOSE },
				comments: { type: "array", items: LOOSE },
				decisions: { type: "array", items: LOOSE },
				recentRuns: { type: "array", items: LOOSE },
				currentRole: { oneOf: [{ type: "string" }, { type: "null" }] },
				child: LOOSE,
				progress: { type: "string" },
				questionSent: { type: "boolean" },
				phase: { type: "string" },
			},
		},
		render: renderText,
		presentationMeta: (_args, value) => ({ v: 1, ...value }),
	};
	tools.push({
		name: "roles_start",
		description:
			"Start the full role-team pipeline in the background and return immediately with a runId. Prefer this for implementation work so you remain available for user questions. Use roles_status to inspect progress or ask the active child a question, and roles_cancel to stop. Include the full task and context; children do not see this conversation. One active background run per session.",
		parameters: runParameters,
		output: backgroundOutput,
		async execute(args, exec) {
			if (exec.signal?.aborted) throw new Error("role team was cancelled");
			const task = stringArg(args, "task", { required: true });
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const effectiveConfig = effectiveConfigWithRounds(currentConfig(), args);
			return background.start(exec.agent, `roles-${randomUUID()}`, {
				task,
				context,
				plan,
				config: effectiveConfig,
				tool: "roles_start",
			});
		},
	});
	const statusParameters = {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				description:
					"Run id returned by roles_start. Omit for the latest run in this session.",
			},
		},
	};
	tools.push({
		name: "roles_status",
		description:
			"Read the latest role-team progress or final report in this session without waiting for completion. Use when the user asks how things are going, including «чё там», «че там», «как там». Returns the active child id/name, latest observed text/tool activity and completed stages. Optionally send a progress question to the current native child; questionSent means delivered, not answered yet. Do not infer success from inactivity.",
		parameters: {
			...statusParameters,
			properties: {
				...statusParameters.properties,
				question: {
					type: "string",
					description:
						"Optional short progress question for the active native role child. Later status reads show its response/activity.",
				},
			},
		},
		output: backgroundOutput,
		async execute(args, exec) {
			const statusResult = await background.status(
				exec.agent,
				stringArg(args, "run_id"),
				stringArg(args, "question", { max: 2000 }),
				exec.signal,
			);
			const recentRuns = background.list(exec.agent, 5);
			if (recentRuns.length <= 1) return statusResult;
			const historyLine = `Recent runs in session: ${recentRuns.map((item) => `${item.runId} (${item.status})`).join(" · ")}`;
			return {
				...statusResult,
				recentRuns,
				text: `${statusResult.text}\n${historyLine}`,
			};
		},
	});
	tools.push({
		name: "roles_cancel",
		description:
			"Cancel this session’s background role-team run and dispose its active child. Already completed runs are returned unchanged.",
		parameters: statusParameters,
		output: backgroundOutput,
		async execute(args, exec) {
			return background.cancel(exec.agent, stringArg(args, "run_id"));
		},
	});
	tools.push({
		name: "role_plan",
		description:
			"Ask the configured PLAN model to produce an implementation plan for one self-contained task. PLAN runs as a fresh agent in this workspace; it does not edit files and does not see this conversation. Waits for the plan and returns it.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "The task to plan, with every fact the planner needs.",
				},
				context: {
					type: "string",
					description:
						"Additional context: files, constraints, prior decisions.",
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		output: singleRoleOutput("role_plan"),
		async execute(args, exec) {
			if (exec.agent === undefined)
				throw new Error("role_plan needs a calling agent");
			const config = currentConfig();
			const task = stringArg(args, "task", { required: true });
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			await prevalidateSingleRole(ctx, config, "plan", exec.signal);
			const result = await runTrackedRole(ctx, config, {
				tool: "role_plan",
				task,
				role: "plan",
				prompt: buildPlanPrompt({
					task,
					context,
					cwd,
					extra: config.prompts.plan,
				}),
				agent: exec.agent,
				signal: exec.signal,
				cwd,
				callId: exec.callId,
			});
			return structuredRoleResult(result);
		},
	});
	tools.push({
		name: "role_worker",
		description:
			"Ask the configured WORKER model to implement one self-contained task in this shared workspace, optionally following a plan and fixing supplied feedback. WORKER runs as a fresh agent with normal editing and shell tools; it does not see this conversation. Waits for its report and returns it.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description:
						"The complete implementation task and acceptance criteria.",
				},
				plan: { type: "string", description: "The plan to follow." },
				feedback: {
					type: "string",
					description:
						"Issues from an advisor or reviewer that the worker must address.",
				},
				context: {
					type: "string",
					description:
						"Additional context: files, constraints, prior decisions.",
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		output: singleRoleOutput("role_worker"),
		async execute(args, exec) {
			if (exec.agent === undefined)
				throw new Error("role_worker needs a calling agent");
			const config = currentConfig();
			const task = stringArg(args, "task", { required: true });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const feedback = stringArg(args, "feedback", { max: 8000 });
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			await prevalidateSingleRole(ctx, config, "worker", exec.signal);
			const result = await runTrackedRole(ctx, config, {
				tool: "role_worker",
				task,
				role: "worker",
				prompt: buildWorkerPrompt({
					task,
					context,
					plan: plan ?? "(no plan supplied; decide and proceed)",
					cwd,
					round: 1,
					feedback: feedback === undefined ? [] : [feedback],
					previous: undefined,
					extra: config.prompts.worker,
				}),
				agent: exec.agent,
				signal: exec.signal,
				cwd,
				callId: exec.callId,
			});
			if (
				result.status === "completed" &&
				!parseWorkerStatus(result.text).blocked
			) {
				markWorkerDone(ctx, exec.agent);
			}
			return structuredRoleResult(result);
		},
	});
	tools.push({
		name: "role_advisor",
		description:
			"Ask the configured ADVISOR model, from a different model family than WORKER, to audit the current workspace and a worker report. ADVISOR runs as a fresh agent, inspects the real diff and files, and returns an approved/changes verdict with issues. It does not edit files.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "The task the work was supposed to complete.",
				},
				plan: { type: "string", description: "The plan the worker followed." },
				worker_report: {
					type: "string",
					description:
						"What the worker says it changed and verified. Omit to ask ADVISOR to inspect the workspace directly.",
				},
				context: {
					type: "string",
					description:
						"Additional context: files, constraints, prior decisions.",
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		output: singleRoleOutput("role_advisor"),
		async execute(args, exec) {
			if (exec.agent === undefined)
				throw new Error("role_advisor needs a calling agent");
			const config = currentConfig();
			const task = stringArg(args, "task", { required: true });
			const plan =
				stringArg(args, "plan", { max: LIMITS.planChars }) ??
				"(no plan supplied)";
			const workerReport =
				stringArg(args, "worker_report", { max: LIMITS.workerChars }) ??
				"(no worker report; inspect the current workspace and judge it against the task)";
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			await prevalidateSingleRole(ctx, config, "advisor", exec.signal);
			const result = await runTrackedRole(ctx, config, {
				tool: "role_advisor",
				task,
				role: "advisor",
				prompt: buildAdvisorPrompt({
					task,
					context,
					plan,
					cwd,
					workerReport,
					round: 1,
					extra: config.prompts.advisor,
				}),
				agent: exec.agent,
				signal: exec.signal,
				cwd,
				callId: exec.callId,
			});
			return structuredRoleResult(result, parseVerdict(result.text));
		},
	});
	tools.push({
		name: "role_reviewer",
		description:
			"Ask the configured REVIEWER model to perform the final independent gate on a completed task. REVIEWER runs only after a WORKER reports completion in this session, verifies the diff and tests from scratch, and returns an approved/changes verdict. The tool refuses before that point; use it as the last check, not as a first reviewer.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "The task that should now be complete.",
				},
				plan: { type: "string", description: "The plan the worker followed." },
				worker_report: {
					type: "string",
					description: "What the worker says it changed and verified.",
				},
				advisor_verdict: {
					type: "string",
					description: "The advisor verdict that preceded this gate.",
				},
				context: {
					type: "string",
					description:
						"Additional context: files, constraints, prior decisions.",
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		output: singleRoleOutput("role_reviewer"),
		async execute(args, exec) {
			if (exec.agent === undefined)
				throw new Error("role_reviewer needs a calling agent");
			if (!hasWorkerReportedDone(ctx, exec.agent)) {
				throw new Error(
					"REVIEWER is the final gate: start a WORKER and let it report completion (role_worker or roles_run) before starting the reviewer",
				);
			}
			const config = currentConfig();
			const task = stringArg(args, "task", { required: true });
			const plan =
				stringArg(args, "plan", { max: LIMITS.planChars }) ??
				"(no plan supplied)";
			const workerReport =
				stringArg(args, "worker_report", { max: LIMITS.workerChars }) ??
				"(no worker report supplied)";
			const advisorVerdict =
				stringArg(args, "advisor_verdict", { max: LIMITS.verdictChars }) ??
				"(no advisor verdict supplied)";
			const context = stringArg(args, "context", { max: LIMITS.contextChars });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			await prevalidateSingleRole(ctx, config, "reviewer", exec.signal);
			const result = await runTrackedRole(ctx, config, {
				tool: "role_reviewer",
				task,
				role: "reviewer",
				prompt: buildReviewerPrompt({
					task,
					context,
					plan,
					cwd,
					workerReport,
					advisorVerdict,
					extra: config.prompts.reviewer,
				}),
				agent: exec.agent,
				signal: exec.signal,
				cwd,
				callId: exec.callId,
			});
			return structuredRoleResult(result, parseVerdict(result.text));
		},
	});
	return tools;
}
