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
 * The deterministic orchestration is shared by `roles_start` and `roles_run`; the `role_*` tools
 * expose a single role for manual work, and `/roles` inspects and edits the
 * routes through the profile configuration editor. The plugin deliberately
 * imports no DSH packages: it is resolved from the profile and consumes the
 * live Host services through `ctx.get()`.
 *
 * @module @local/dsh-role-team
 */

import { authenticatedWebServer } from "./web-route-auth.js";

import { runRuntimeRole, validateRuntimeRoute } from "./runtime-role.js";
import { createBackgroundRuns } from "./background-runs.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	Agent,
	Role,
	Route,
	HostContext,
	RoleTeamConfig,
	Issue,
	Verdict,
	RoleResult,
	Stage,
	Comment,
	Decision,
	Round,
	TeamOutcome,
	RunState,
	RunOptions,
	ChildTarget,
	PromptInputs,
	PlanPromptInputs,
	WorkerPromptInputs,
	AdvisorPromptInputs,
	ReviewerPromptInputs,
	Question,
	Answers,
	CommandInvocation,
	CommandResult,
	ToolDefinition,
	ToolOutput,
	ToolValue,
	TextBlock,
} from "./types.js";

type BackgroundRuns = ReturnType<
	typeof createBackgroundRuns<
		Agent,
		Omit<RunOptions, "agent">,
		Partial<RunState>,
		TeamOutcome
	>
>;
interface RoleRunOptions {
	role: Role;
	prompt: string;
	parent: Agent;
	signal?: AbortSignal;
	cwd?: string;
	callId?: string;
	onChild?: (child: ChildTarget | undefined) => void;
}
interface TrackedRoleOptions extends Omit<RoleRunOptions, "parent"> {
	tool: string;
	task: string;
	agent: Agent;
}
interface ReportInputs {
	status: TeamOutcome["status"];
	config: RoleTeamConfig;
	plan: string;
	rounds: Round[];
	comments: Comment[];
	decisions: Decision[];
	startedAt: number;
	task: string;
	note?: string;
}

/** The four roles, in pipeline order. */
export const ROLE_NAMES = Object.freeze([
	"plan",
	"worker",
	"advisor",
	"reviewer",
] as const);

/**
 * Services this plugin requires. Everything else (`subagents`, `llm`,
 * `commands`, `configEditor`, `workingDirectory`) is optional and read with
 * `ctx.get()`, so the plugin still loads in a minimal composition.
 */
export const inject = ["tools", "systemPrompt"];

/** Human-facing role names used in prompts and reports. */
const ROLE_LABELS = Object.freeze({
	plan: "PLAN",
	worker: "WORKER",
	advisor: "ADVISOR",
	reviewer: "REVIEWER",
});

/**
 * Recommended cross-family defaults. They match the roles described by the
 * user: a strong planner (GPT-6 Astra), a fast implementer (DeepSeek V4.1
 * Flash), a GLM advisor, and an independent GPT-6 Sol final reviewer.
 */
const DEFAULT_ROLES = Object.freeze({
	plan: { provider: "opencode-go", model: "gpt-6-luna" },
	worker: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
	advisor: { provider: "opencode-go", model: "glm-5.3" },
	reviewer: { provider: "opencode-go", model: "qwen3.8-max" },
});

/** Bound every model-facing piece of the report so one round cannot flood the lead. */
const LIMITS = Object.freeze({
	planChars: 8000,
	workerChars: 5000,
	verdictChars: 3000,
	issueChars: 1200,
	reportChars: 32_000,
	roleOutputChars: 14_000,
	toolTaskChars: 60_000,
	maxRounds: 6,
	maxChildDepth: 8,
	/** Upper bound of the `maxPlanPasses` configuration (audit → revise cycles before WORKER). */
	maxPlanPasses: 3,
	/** Hard cap on total WORKER attempts per run, including rounds granted by the user's exhaustion choice. */
	maxWorkerAttempts: 12,
	/** A plan file larger than this is refused instead of read. */
	planFileMaxChars: 200_000,
	/** Characters of the task used in the title of a `/role-plan` session. */
	planSessionTitleChars: 60,
	/** How long the browser may claim a freshly created `/role-plan` session for auto-opening. */
	planSessionTtlMs: 10 * 60 * 1000,
});

/** Same-origin settings route served to the browser half. */
const ROLES_SETTINGS_ROUTE = "/plugin-api/role-team/roles";

/** The section that tells the lead what the team is for. */
const ROLE_GUIDANCE = `Role team (PLAN -> WORKER -> ADVISOR -> REVIEWER) is available. Prefer \`roles_start\` for substantial work: it starts the pipeline in the background so you remain available to the user. PLAN drafts a plan, ADVISOR audits it before WORKER implements, then audits each attempt; REVIEWER is the final gate. Pass the task verbatim and all relevant context: children do not see this conversation. On progress questions such as “чё там”, “че там”, “как там” or “how is it going”, call \`roles_status\` and report the observed stage, child activity and blockers. Its optional question argument asks the active native child for clarification; inbox acceptance is not an answer. Never launch another run for a progress question. Use \`roles_cancel\` to stop. \`roles_run\` waits for the final report when foreground execution is explicitly needed; \`role_*\` tools run single roles. Never start REVIEWER before WORKER reports completion. The user can use \`/roles run <task>\` here or \`/role-plan <task or plan.md>\` to open a dedicated conversational orchestrator session. Role routes are configured with \`/roles\` or Settings → Models. Background results are kept in memory until plugin reload; use runId to select an older run.`;

/* ------------------------------------------------------------------------- *
 * Small utilities
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is a plain data object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Truncate text to a character budget with an explicit marker.
 */
function clip(
	value: string | number | boolean | null | undefined,
	max: number,
): string {
	const text =
		typeof value === "string" ? value : value == null ? "" : String(value);
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 24))}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Collapse whitespace for a one-line summary.
 */
function oneLine(
	value: string | number | boolean | null | undefined,
	max = 200,
): string {
	return clip(
		String(value ?? "")
			.replace(/\s+/g, " ")
			.trim(),
		max,
	);
}

/**
 * Extract the text blocks of a child's final output.
 */
function textOf(blocks: readonly unknown[] | undefined): string {
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter(
			(block): block is TextBlock =>
				isPlainObject(block) &&
				block.type === "text" &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/**
 * Render one thrown value without trusting its coercion.
 */
function messageOf(error: unknown): string {
	if (error instanceof Error && typeof error.message === "string")
		return error.message;
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

/**
 * Format a duration in coarse units.
 */
function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Clone plain configuration data without assuming structuredClone exists.
 */
function cloneJson<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Clamp a positive integer configuration value.
 */
function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed =
		typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isInteger(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

/* ------------------------------------------------------------------------- *
 * Role routes and configuration
 * ------------------------------------------------------------------------- */

/**
 * Parse one configured role route.
 *
 * Accepted forms are `{ provider, model, reasoningEffort? }`, the compact
 * string `provider/model[:effort]`, and `null`/`"inherit"` to follow the
 * session model. Model ids may contain `/`; only the first slash splits the
 * provider, and a trailing `:effort` is recognised only when it looks like an
 * effort id.
 *
 */
export function normalizeRoute(
	value: unknown,
):
	| { route: Route | null; error?: undefined }
	| { route?: undefined; error: string } {
	if (value === null || value === false || value === undefined)
		return { route: null };
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "" || text.toLowerCase() === "inherit") return { route: null };
		const slash = text.indexOf("/");
		if (slash <= 0 || slash === text.length - 1) {
			return { error: `"${text}" is not a <provider>/<model> route` };
		}
		const provider = text.slice(0, slash).trim();
		let model = text.slice(slash + 1).trim();
		let reasoningEffort;
		const colon = model.lastIndexOf(":");
		if (colon > 0 && colon < model.length - 1) {
			const candidate = model.slice(colon + 1);
			if (/^[a-z][a-z0-9_-]*$/.test(candidate)) {
				reasoningEffort = candidate;
				model = model.slice(0, colon).trim();
			}
		}
		if (provider === "" || model === "")
			return { error: `"${text}" is not a <provider>/<model> route` };
		return {
			route: {
				provider,
				model,
				...(reasoningEffort === undefined ? {} : { reasoningEffort }),
			},
		};
	}
	if (isPlainObject(value)) {
		if (value.inherit === true) return { route: null };
		const runtime = value.runtime;
		if (
			runtime !== undefined &&
			(typeof runtime !== "string" ||
				!["native", "cursor", "droid"].includes(runtime))
		)
			return { error: "runtime must be native, cursor, or droid" };
		const provider =
			typeof value.provider === "string"
				? value.provider.trim()
				: runtime && runtime !== "native"
					? runtime
					: "";
		const model = typeof value.model === "string" ? value.model.trim() : "";
		if (provider === "" || model === "") {
			return {
				error: "a route object needs non-empty provider and model strings",
			};
		}
		const effort = value.reasoningEffort ?? value.effort;
		if (
			effort !== undefined &&
			(typeof effort !== "string" || effort.trim() === "")
		) {
			return { error: "reasoningEffort must be a non-empty string" };
		}
		return {
			route: {
				provider,
				model,
				...(runtime === undefined ? {} : { runtime }),
				...(typeof effort === "string"
					? { reasoningEffort: effort.trim() }
					: {}),
			},
		};
	}
	return {
		error:
			"expected a provider/model string, a route object, or null to inherit the session model",
	};
}

/**
 * Format a route for display.
 */
export function formatRoute(route: Route | null): string {
	if (route === null) return "inherit session model";
	return `${route.runtime && route.runtime !== "native" ? `${route.runtime}:` : ""}${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : ` @${route.reasoningEffort}`}`;
}

/**
 * Best-effort model family, used only for independence warnings.
 */
export function familyOf(route: Route | null): string | null {
	if (route === null) return null;
	const id = `${route.provider}/${route.model}`.toLowerCase();
	if (/claude|anthropic/.test(id)) return "anthropic";
	if (/gemini|google/.test(id)) return "google";
	if (/glm|zai|z-ai|bigmodel/.test(id)) return "zai";
	if (/deepseek/.test(id)) return "deepseek";
	if (/qwen|tongyi/.test(id)) return "qwen";
	if (/kimi|moonshot/.test(id)) return "moonshot";
	if (/grok|xai/.test(id)) return "xai";
	if (/minimax/.test(id)) return "minimax";
	if (/llama|meta-llama/.test(id)) return "meta";
	if (/mistral/.test(id)) return "mistral";
	if (/gpt|openai|codex|o[1-9](?:-|$)/.test(id)) return "openai";
	return route.provider.toLowerCase();
}

/**
 * Resolve the plugin's raw configuration.
 *
 * Missing role entries use the recommended defaults. An explicit `null` or
 * `"inherit"` makes that role follow the caller's session model, which is
 * useful when a provider is not configured.
 *
 */
export function resolveRoleTeamConfig(raw: unknown): RoleTeamConfig {
	const input = isPlainObject(raw) ? raw : {};
	const configuredRoles = isPlainObject(input.roles) ? input.roles : {};
	const roles = {} as Record<Role, Route | null>;
	const sources = {} as RoleTeamConfig["sources"];
	const problems = [];
	for (const role of ROLE_NAMES) {
		const hasOwn = Object.hasOwn(configuredRoles, role);
		const value = hasOwn ? configuredRoles[role] : DEFAULT_ROLES[role];
		const parsed = normalizeRoute(value);
		if (parsed.error !== undefined) {
			roles[role] = null;
			sources[role] = "inherit";
			problems.push({ role, message: parsed.error });
			continue;
		}
		roles[role] = parsed.route;
		sources[role] =
			parsed.route === null ? "inherit" : hasOwn ? "config" : "default";
	}
	const promptsInput = isPlainObject(input.prompts) ? input.prompts : {};
	const prompts: RoleTeamConfig["prompts"] = {};
	for (const role of ROLE_NAMES) {
		const value = promptsInput[role];
		if (typeof value === "string" && value.trim() !== "")
			prompts[role] = value.trim();
	}
	return {
		roles,
		sources,
		problems,
		maxRounds: clampInt(input.maxRounds, 1, LIMITS.maxRounds, 3),
		maxPlanPasses: clampInt(input.maxPlanPasses, 1, LIMITS.maxPlanPasses, 2),
		childMaxDepth: clampInt(input.childMaxDepth, 0, LIMITS.maxChildDepth, 2),
		prompts,
	};
}

/**
 * Validate one configured route against the live LLM runtime.
 */
async function validateRoute(
	ctx: HostContext,
	role: Role,
	route: Route,
	signal?: AbortSignal,
): Promise<void> {
	if (route.runtime && route.runtime !== "native")
		return validateRuntimeRoute(ctx, route);
	const llm = ctx.get("llm");
	if (llm === undefined || llm === null) {
		throw new Error(
			"the LLM service is unavailable, so role routes cannot be validated",
		);
	}
	try {
		await llm.resolveCallConfig(
			{
				provider: route.provider,
				model: route.model,
				...(route.reasoningEffort === undefined
					? {}
					: { reasoningEffort: route.reasoningEffort }),
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`role ${role} route ${formatRoute(route)} is not usable: ${messageOf(error)}`,
		);
	}
}

/* ------------------------------------------------------------------------- *
 * Prompts
 * ------------------------------------------------------------------------- */

/** Shared behavioural rules for one role child. */
const COMMON_ROLE_RULES = `You are one role in a four-role engineering team (PLAN, WORKER, ADVISOR, REVIEWER). Every role runs as a separate agent but shares one workspace. Do not call role tools or delegate to other agents: do this role's own work directly. Be concrete; another model reads your output, not a human. Never claim a check passed unless you ran it.`;

/**
 * Workspace line for prompts.
 */
function isRole(value: string): value is Role {
	return ROLE_NAMES.some((role) => role === value);
}

function workspaceLine(cwd: string | undefined): string {
	return cwd === undefined || cwd === "" ? "" : `Workspace: ${cwd}\n`;
}

/** The four labeled parts every PLAN output must carry. */
const PLAN_PARTS = `STEPS:
1. … numbered steps; each step names the exact file or module path it changes and the concrete change it makes.
RISKS:
- … named risks and edge cases; for each, state what must be verified rather than assumed.
VERIFY:
- … the exact commands that prove completion (tests, builds, linters, checks).
ACCEPT:
- … acceptance checks, each phrased so an independent reviewer can verify it without the plan's author.`;

/**
 * Build the PLAN prompt.
 */
export function buildPlanPrompt({
	task,
	context,
	cwd,
	extra,
}: PromptInputs): string {
	return `You are PLAN, the planner of a four-role engineering team. You do not edit files; this phase only produces the plan.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 20_000)}\n`}
Produce an implementation plan with exactly these four labeled parts:
${PLAN_PARTS}
Keep it under 100 lines. Return only the plan.${extra === undefined ? "" : `\n\n${extra}`}`;
}

/**
 * Build the ADVISOR prompt that audits a plan before implementation starts.
 */
export function buildPlanAuditPrompt({
	task,
	context,
	plan,
	cwd,
	extra,
}: PlanPromptInputs): string {
	return `You are ADVISOR, an independent senior reviewer from a different model family than WORKER. Do not edit files. You are auditing the PLAN before any implementation starts: judge the plan itself, not the workspace.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 12_000)}\n`}
Plan to audit:
${clip(plan, LIMITS.planChars)}

Judge whether this plan is good enough to implement as it is: does it cover the whole task, name the exact files or modules to change, order the steps correctly, name the real risks and edge cases, and include commands and acceptance checks an independent reviewer can verify? Be adversarial about gaps and wrong assumptions, but do not invent scope the task did not ask for. Set approved=true only when no blocker or major issue remains.
Return STRICT JSON only, with no markdown fence:
{"approved": true|false, "summary": "one paragraph", "issues": [{"severity": "blocker|major|minor", "detail": "specific, actionable, with file or line when possible"}]}${extra === undefined ? "" : `\n\n${extra}`}`;
}

/**
 * Build the PLAN prompt that revises a rejected plan from the advisor's issues.
 */
export function buildPlanRevisionPrompt({
	task,
	context,
	plan,
	issues,
	cwd,
	extra,
}: PlanPromptInputs & { issues: string[] }): string {
	const issueText =
		issues.length === 0
			? "(the advisor rejected the plan without concrete issues; find and fix the weaknesses yourself)"
			: issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n");
	return `You are PLAN, the planner of a four-role engineering team. The ADVISOR rejected your plan. Rewrite it so every advisor issue is addressed. You do not edit files.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 12_000)}\n`}
Advisor issues to address:
${issueText}

Plan to revise:
${clip(plan, LIMITS.planChars)}

Produce the revised plan with exactly these four labeled parts:
${PLAN_PARTS}
Keep it under 100 lines. Return only the plan.${extra === undefined ? "" : `\n\n${extra}`}`;
}

/**
 * Build the WORKER prompt for one attempt.
 */
export function buildWorkerPrompt({
	task,
	context,
	plan,
	cwd,
	round,
	feedback,
	previous,
	extra,
}: WorkerPromptInputs): string {
	const feedbackText =
		feedback.length === 0
			? "None outstanding."
			: feedback.map((issue, index) => `${index + 1}. ${issue}`).join("\n");
	return `You are WORKER, the implementer of a four-role engineering team. You own the workspace: edit files, run commands, and verify your own work. Do not merely describe changes.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 20_000)}\n`}
Plan from PLAN:
${clip(plan, LIMITS.planChars)}

Attempt ${round}. Feedback you must address (every blocker and major issue):
${feedbackText}
${previous === undefined || previous.trim() === "" ? "" : `\nYour previous report:\n${clip(previous, 3000)}\n`}
Requirements:
- Implement the whole task, not a sketch. Make reasonable decisions and state assumptions instead of asking questions.
- Run the relevant tests/checks and fix failures you cause. Do not break unrelated behaviour.
- Keep the change scoped to the task.
- Your final message is the only thing the team sees. Include exactly these sections:
  CHANGES: files and what changed
  EVIDENCE: commands run and their results
  STATUS: done | blocked
  NOTES: risks, follow-ups, or what is missing
If blocked, say exactly what is missing; do not claim done.${extra === undefined ? "" : `\n\n${extra}`}`;
}

/**
 * Build the ADVISOR prompt for one worker attempt.
 */
export function buildAdvisorPrompt({
	task,
	context,
	plan,
	cwd,
	workerReport,
	round,
	feedback = [],
	extra,
}: AdvisorPromptInputs): string {
	return `You are ADVISOR, an independent senior reviewer from a different model family than WORKER. Do not edit files. Inspect the actual workspace and diff, run read-only checks if useful, and audit the attempt rather than trusting the report.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 12_000)}\n`}
Plan:
${clip(plan, LIMITS.planChars)}

WORKER attempt ${round} report:
${clip(workerReport, LIMITS.workerChars)}

Feedback the worker was asked to address in this attempt:
${feedback.length === 0 ? "None outstanding." : feedback.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}

Judge whether the task is complete and correct. Be adversarial about correctness, but do not invent scope or style work the task did not ask for. Set approved=true only when no blocker or major issue remains.
Return STRICT JSON only, with no markdown fence:
{"approved": true|false, "summary": "one paragraph", "issues": [{"severity": "blocker|major|minor", "detail": "specific, actionable, with file or line when possible"}]}${extra === undefined ? "" : `\n\n${extra}`}`;
}

/**
 * Build the REVIEWER prompt for the final gate.
 */
export function buildReviewerPrompt({
	task,
	context,
	plan,
	cwd,
	workerReport,
	advisorVerdict,
	extra,
}: ReviewerPromptInputs): string {
	return `You are REVIEWER, the final independent gate of the team. WORKER says the task is done and ADVISOR approved; verify from scratch. Do not edit files. Inspect the diff, run the tests, and check every acceptance check yourself; do not trust the reports.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === "" ? "" : `\nContext:\n${clip(context, 12_000)}\n`}
Plan:
${clip(plan, LIMITS.planChars)}

WORKER report:
${clip(workerReport, LIMITS.workerChars)}

ADVISOR verdict:
${clip(advisorVerdict, LIMITS.verdictChars)}

Return STRICT JSON only, with no markdown fence:
{"approved": true|false, "summary": "one paragraph", "issues": [{"severity": "blocker|major|minor", "detail": "specific, actionable, with file or line when possible"}]}${extra === undefined ? "" : `\n\n${extra}`}`;
}

/* ------------------------------------------------------------------------- *
 * Verdict parsing
 * ------------------------------------------------------------------------- */

/**
 * Scan text for balanced JSON objects, ignoring braces inside strings.
 */
function jsonObjectCandidates(text: string): string[] {
	const candidates = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (char === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(text.slice(start, index + 1));
				start = -1;
				if (candidates.length >= 12) break;
			}
		}
	}
	return candidates;
}

/**
 * Normalise one issue value from a verdict.
 */
function normalizeIssue(issue: unknown, fallback: string): Issue {
	if (typeof issue === "string" && issue.trim() !== "") {
		return { severity: "major", detail: clip(issue.trim(), LIMITS.issueChars) };
	}
	if (isPlainObject(issue)) {
		const severity =
			typeof issue.severity === "string"
				? issue.severity.toLowerCase()
				: "major";
		const detail =
			issue.detail ?? issue.message ?? issue.description ?? issue.title;
		if (typeof detail === "string" && detail.trim() !== "") {
			return { severity, detail: clip(detail.trim(), LIMITS.issueChars) };
		}
	}
	return { severity: "major", detail: clip(fallback, LIMITS.issueChars) };
}

/**
 * Parse an ADVISOR/REVIEWER verdict.
 *
 * The preferred form is strict JSON. A missing or malformed object falls back
 * to a conservative text heuristic: an explicit approval without a rejection
 * word approves, everything else is treated as changes required. The fallback
 * is deliberately biased toward another worker round, never toward a false
 * approval.
 *
 */
export function parseVerdict(text: string): Verdict {
	const source = String(text ?? "");
	for (const candidate of jsonObjectCandidates(source)) {
		try {
			const value = JSON.parse(candidate);
			if (!isPlainObject(value) || typeof value.approved !== "boolean")
				continue;
			const rawIssues = Array.isArray(value.issues) ? value.issues : [];
			const issues = rawIssues.map((issue) =>
				normalizeIssue(issue, "unspecified issue"),
			);
			// A verdict that claims approval while listing a blocker or major issue
			// is contradictory; the gate stays closed.
			const blocking = issues.some(
				(issue) => issue.severity === "blocker" || issue.severity === "major",
			);
			return {
				approved: value.approved && !blocking,
				summary:
					typeof value.summary === "string"
						? clip(value.summary, LIMITS.verdictChars)
						: "",
				issues,
				parsed: true,
			};
		} catch {
			// Not JSON, or a non-verdict object: continue scanning.
		}
	}
	const lower = source.toLowerCase();
	const rejected =
		/\bnot approved\b|\bchanges required\b|\brejected\b|\bblocker\b/.test(
			lower,
		);
	// Only a declared approval counts in the fallback; a stray "approved" inside
	// a sentence such as "it would be approved after X" must not release the gate.
	const declared =
		/^\s*(?:final\s+)?(?:verdict\s*:\s*)?approved\b/im.test(source) ||
		/\bapproved\s*:\s*true\b/i.test(source);
	const approved = declared && !rejected;
	return {
		approved,
		summary: clip(source.trim(), LIMITS.verdictChars),
		issues: approved
			? []
			: [
					{
						severity: "major",
						detail: clip(
							source.trim() === ""
								? "the role returned no verdict"
								: source.trim(),
							LIMITS.issueChars * 2,
						),
					},
				],
		parsed: false,
	};
}

/**
 * Render issues as numbered worker feedback.
 */
function feedbackLines(issues: Issue[]): string[] {
	return issues.map((issue) => `[${issue.severity}] ${issue.detail}`);
}

/* ------------------------------------------------------------------------- *
 * Role execution through the subagent service
 * ------------------------------------------------------------------------- */

let childNameCounter = 0;

/**
 * Sessions in which a WORKER has reported completion. The REVIEWER is the
 * final gate, so the standalone `role_reviewer` tool refuses to run before
 * that. `roles_run` calls the reviewer internally and does not need the flag.
 */
const workerReportedDone = new WeakSet();

/**
 * Allocate a unique, valid subagent name for one role child.
 */
function roleChildName(role: Role): string {
	childNameCounter += 1;
	const stamp = Date.now().toString(36).slice(-5);
	return `${role}-${stamp}${childNameCounter.toString(36)}`.slice(0, 32);
}

/**
 * Start one role child, await its settlement, and release it.
 *
 * Caller delivery is used because the orchestrator awaits the result itself;
 * this avoids competing completion notices in the lead's inbox.
 *
 */
async function runRole(
	ctx: HostContext,
	config: RoleTeamConfig,
	{ role, prompt, parent, signal, cwd, callId, onChild }: RoleRunOptions,
): Promise<RoleResult> {
	const update = (patch: Partial<RunState>) => {
		const state = runStates.get(callId);
		if (state) Object.assign(state, patch, { updatedAt: Date.now() });
	};
	const selectedRoute = config.roles[role];
	if (selectedRoute?.runtime && selectedRoute.runtime !== "native") {
		return runRuntimeRole(ctx, {
			route: selectedRoute,
			role,
			prompt,
			parent,
			signal,
			cwd,
			onActivity: update,
		});
	}
	const subagents = ctx.get("subagents");
	if (subagents === undefined || subagents === null) {
		throw new Error(
			"role team needs the subagent service; mount @deepseek-ai/dsh-subagent and @deepseek-ai/dsh-subagent-spawn-in-process",
		);
	}
	const provider = subagents.getProvider("spawn");
	if (provider === undefined || provider === null) {
		throw new Error(
			'role team needs the "spawn" subagent provider; mount @deepseek-ai/dsh-subagent-spawn-in-process',
		);
	}
	if (signal !== undefined && signal.aborted)
		throw new Error("role team was cancelled");
	const route = config.roles[role] ?? null;
	const startedAt = Date.now();
	const name = roleChildName(role);
	const agentOptions =
		route === null
			? undefined
			: {
					provider: route.provider,
					model: route.model,
					...(route.reasoningEffort === undefined
						? {}
						: { reasoningEffort: route.reasoningEffort }),
				};
	let started;
	try {
		started = await subagents.startActivation({
			provider: "spawn",
			label: `role ${role}`,
			name,
			parent,
			signal,
			delivery: "caller",
			...(cwd === undefined ? {} : { cwd }),
			prompt: [{ type: "text", text: prompt }],
			...(agentOptions === undefined ? {} : { agentOptions }),
			...(provider.capabilities !== undefined &&
			provider.capabilities.depthLimit &&
			Number.isInteger(config.childMaxDepth)
				? { maxDepth: config.childMaxDepth }
				: {}),
		});
	} catch (error) {
		throw new Error(`could not start the ${role} role: ${messageOf(error)}`);
	}
	update({
		child: { id: started.childId, name: started.name },
		progress: `${ROLE_LABELS[role]} started`,
	});
	const childLifetime = new AbortController();
	onChild?.({ id: started.childId, signal: childLifetime.signal });
	const unsubscribeEnd =
		typeof ctx.on === "function"
			? ctx.on("subagent/end", (info) => {
					if (info.id === started.childId) childLifetime.abort();
				})
			: undefined;
	const unsubscribe =
		typeof ctx.on === "function"
			? ctx.on("session/event", (session, event) => {
					if (session.id !== started.childId) return;
					if (event.type === "tool/call")
						update({ progress: `Tool: ${oneLine(event.data?.name, 100)}` });
					if (event.type === "assistant/message") {
						const text = textOf(event.data?.message?.content);
						if (text) update({ progress: clip(text, 1800) });
					}
				})
			: undefined;
	let result;
	let onAbort: () => void = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("role team was cancelled"));
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		result = await Promise.race([started.result, aborted]);
	} catch (error) {
		throw new Error(`the ${role} role failed: ${messageOf(error)}`);
	} finally {
		childLifetime.abort();
		onChild?.(undefined);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
		unsubscribeEnd?.();
		try {
			await started.dispose();
		} catch {
			// Disposal failure must not replace a captured child result.
		}
	}
	if (
		result.stopReason === "aborted" ||
		(signal !== undefined && signal.aborted)
	) {
		throw new Error("role team was cancelled");
	}
	return {
		role,
		route,
		childName: started.name,
		status: result.stopReason,
		text: textOf(result.output),
		diagnostic:
			typeof result.diagnostic === "string" ? result.diagnostic : undefined,
		durationMs: Date.now() - startedAt,
	};
}

/**
 * Format one role result for a single-role tool.
 */
function formatRoleResult(result: RoleResult): string {
	const header = `Role ${ROLE_LABELS[result.role]} (${formatRoute(result.route)}) finished: ${result.status} in ${formatDuration(result.durationMs)}.`;
	const body = result.text === "" ? "(the role returned no text)" : result.text;
	const diagnostic =
		result.diagnostic === undefined
			? ""
			: `\n\nDiagnostic: ${result.diagnostic}`;
	return clip(`${header}\n\n${body}${diagnostic}`, LIMITS.roleOutputChars);
}

/**
 * Build the structured canonical value of one single-role tool.
 */
function structuredRoleResult(
	result: RoleResult,
	verdict?: Verdict,
): ToolValue {
	return {
		text: formatRoleResult(result),
		role: result.role,
		route: result.route,
		status: result.status,
		durationMs: result.durationMs,
		...(verdict === undefined ? {} : { verdict }),
	};
}

/* ------------------------------------------------------------------------- *
 * The orchestrated team loop
 * ------------------------------------------------------------------------- */

/**
 * Build the final report handed back to the lead: verdicts first, then the
 * plan, then the round-by-round detail and the user's exhaustion decisions.
 */
function buildTeamReport({
	status,
	config,
	plan,
	rounds,
	comments,
	decisions,
	startedAt,
	task,
	note,
}: ReportInputs): string {
	const lines = [];
	const headline =
		status === "approved"
			? "APPROVED"
			: status === "continued"
				? "CONTINUED WITHOUT APPROVAL"
				: "NOT APPROVED";
	lines.push(
		`Role team: ${headline} after ${rounds.length} round(s) in ${formatDuration(Date.now() - startedAt)}.`,
	);
	lines.push(
		`Roles: ${ROLE_NAMES.map((role) => `${role}=${formatRoute(config.roles[role])}`).join(" · ")}`,
	);
	lines.push(`Task: ${oneLine(task, 300)}`);
	if (rounds.some((round) => round.worker.cwd))
		lines.push(
			"Source workspace is unchanged. Apply worker patches in round order: later patches are relative to the preceding candidate, or integrate the final candidate workspace manually.",
		);
	if (comments.length > 0) {
		lines.push("");
		lines.push("ADVISOR AND REVIEWER COMMENTS");
		for (const comment of comments) {
			const label = comment.role === "reviewer" ? "REVIEWER" : "ADVISOR";
			lines.push(
				`${label} (${formatRoute(comment.route)}) — ${comment.stage} — ${comment.approved ? "APPROVED" : "CHANGES REQUIRED"}`,
			);
			if (comment.summary !== "")
				lines.push(clip(comment.summary, LIMITS.verdictChars));
			for (const issue of comment.issues)
				lines.push(`- [${issue.severity}] ${issue.detail}`);
			lines.push("");
		}
	}
	lines.push("PLAN");
	lines.push(clip(plan, LIMITS.planChars));
	for (const round of rounds) {
		lines.push("");
		lines.push(`ROUND ${round.number}`);
		lines.push(
			`WORKER (${formatRoute(round.worker.route)}, ${round.worker.status}, ${formatDuration(round.worker.durationMs)})`,
		);
		if (round.worker.cwd)
			lines.push(`Candidate workspace: ${round.worker.cwd}`);
		for (const artifact of round.worker.artifacts ?? [])
			lines.push(`Result artifact: ${artifact}`);
		lines.push(
			clip(
				round.worker.text === "" ? "(no report)" : round.worker.text,
				LIMITS.workerChars,
			),
		);
		if (round.worker.diagnostic !== undefined)
			lines.push(`Diagnostic: ${clip(round.worker.diagnostic, 1500)}`);
		lines.push(
			`ADVISOR (${formatRoute(round.advisor.route)}, ${round.advisor.status}, ${formatDuration(round.advisor.durationMs)}) — ${round.advisorVerdict.approved ? "APPROVED" : "CHANGES REQUIRED"}`,
		);
		if (round.advisor.diagnostic !== undefined)
			lines.push(`Diagnostic: ${clip(round.advisor.diagnostic, 1500)}`);
		if (round.reviewer !== undefined) {
			lines.push(
				`REVIEWER (${formatRoute(round.reviewer.route)}, ${round.reviewer.status}, ${formatDuration(round.reviewer.durationMs)}) — ${round.reviewerVerdict!.approved ? "APPROVED" : "CHANGES REQUIRED"}`,
			);
			if (round.reviewer.diagnostic !== undefined)
				lines.push(`Diagnostic: ${clip(round.reviewer.diagnostic, 1500)}`);
		}
	}
	if (decisions.length > 0) {
		lines.push("");
		lines.push("DECISIONS");
		for (const decision of decisions) {
			const route =
				decision.route === undefined ? "" : ` → ${formatRoute(decision.route)}`;
			const extra = decision.note === undefined ? "" : ` (${decision.note})`;
			lines.push(`- ${decision.choice}${route}${extra}`);
		}
	}
	const last = rounds.at(-1);
	if (status !== "approved" && last !== undefined) {
		lines.push("");
		lines.push("OUTSTANDING FEEDBACK");
		const issues =
			last.reviewerVerdict?.approved === false
				? last.reviewerVerdict.issues
				: last.advisorVerdict.issues;
		if (issues.length === 0)
			lines.push(
				"No structured issues were returned; inspect the round reports above.",
			);
		else
			for (const issue of issues)
				lines.push(`- [${issue.severity}] ${issue.detail}`);
	}
	if (status !== "approved" && note !== undefined) {
		lines.push("");
		lines.push(note);
	}
	if (status === "continued") {
		lines.push("");
		lines.push(
			"The user chose to continue without approval; the outstanding feedback above remains unaddressed.",
		);
	}
	if (status === "unapproved") {
		lines.push("");
		lines.push(
			"The task is not approved. Address the outstanding feedback and run the team again, or grant more rounds through the exhaustion question.",
		);
	}
	return clip(lines.join("\n"), LIMITS.reportChars);
}

/* ------------------------------------------------------------------------- *
 * Live run state and the exhaustion question
 * ------------------------------------------------------------------------- */

/** Live run states keyed by the tool call id, served to the browser half. */
const runStates = new Map<string | undefined, RunState>();
/** One controller per plugin instance; session ownership is checked on every tool call. */
const backgroundControllers = new WeakMap<HostContext, BackgroundRuns>();

/**
 * Start the live state of one run. Programmatic callers without a call id are
 * simply not tracked.
 */
function beginRunState(
	callId: string | undefined,
	tool: string,
	task: string,
): void {
	if (callId === undefined) return;
	runStates.set(callId, {
		tool,
		task,
		startedAt: Date.now(),
		stages: [],
		currentRole: null,
	});
}

/**
 * Mark one stage of a tracked run as running.
 */
function beginRunStage(
	callId: string | undefined,
	role: Role,
	route: Route | null,
): void {
	const state = callId === undefined ? undefined : runStates.get(callId);
	if (state === undefined) return;
	state.stages.push({
		role,
		route: route === null ? null : { ...route },
		status: "running",
		startedAt: Date.now(),
	});
	state.currentRole = role;
	delete state.child;
	delete state.progress;
	delete state.phase;
}

/**
 * Mark the running stage of one role as done.
 */
function endRunStage(
	callId: string | undefined,
	role: Role,
	roleStatus: string,
	durationMs: number,
): void {
	const state = callId === undefined ? undefined : runStates.get(callId);
	if (state === undefined) return;
	const stage = [...state.stages]
		.reverse()
		.find((entry) => entry.role === role && entry.status === "running");
	if (stage !== undefined) {
		stage.status = "done";
		stage.roleStatus = roleStatus;
		stage.durationMs = durationMs;
	}
	if (state.currentRole === role) state.currentRole = null;
	delete state.child;
}

/** Drop the live state of one run. */
function endRunState(callId: string | undefined): void {
	if (callId !== undefined) runStates.delete(callId);
}

/**
 * The live state of one run, for tests and the run route.
 */
export function runStateOf(callId: string | undefined): RunState | undefined {
	const state = runStates.get(callId);
	return state === undefined ? undefined : cloneJson(state);
}

/** The exhaustion choices offered to the user when rounds run out. */
const EXHAUSTION_OPTIONS = Object.freeze([
	{
		label: "Continue without approval",
		description:
			"End the run now; the work stays as it is with the outstanding feedback listed.",
	},
	{
		label: "Try 3 more rounds",
		description: "Run three more worker attempts with the same models.",
	},
	{
		label: "Change the WORKER model",
		description:
			"Pick a new worker model first; three more attempts then run on it.",
	},
	{ label: "Stop", description: "End the run as not approved." },
]);

/**
 * Ask the user one question through the user-questions service.
 */
async function askUserChoice(
	ctx: HostContext,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	question: Question,
): Promise<Answers | undefined> {
	const userQuestions = ctx.get("userQuestions");
	if (
		userQuestions === undefined ||
		userQuestions === null ||
		typeof userQuestions.ask !== "function"
	)
		return undefined;
	try {
		return await userQuestions.ask({
			questions: [question],
			...(agent === undefined || agent === null ? {} : { agent }),
			...(signal === undefined ? {} : { signal }),
		});
	} catch {
		return undefined;
	}
}

/**
 * Read the selected label of one answered question.
 */
function selectedLabel(
	answers: Answers | undefined,
	id: string,
): string | undefined {
	const answer =
		answers !== undefined && Array.isArray(answers.answers)
			? answers.answers.find((candidate) => candidate.id === id)
			: undefined;
	if (answer === undefined) return undefined;
	if (
		Array.isArray(answer.selected) &&
		answer.selected.length > 0 &&
		typeof answer.selected[0] === "string"
	) {
		return answer.selected[0];
	}
	if (typeof answer.custom === "string" && answer.custom.trim() !== "")
		return answer.custom.trim();
	return undefined;
}

/**
 * Ask the user how to proceed when the rounds are exhausted without approval.
 */
async function decideOnExhaustion(
	ctx: HostContext,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
): Promise<{ kind: Decision["choice"]; note?: string }> {
	const answers = await askUserChoice(ctx, agent, signal, {
		id: "exhaustion",
		header: "Role team",
		question:
			"The role team ran out of worker rounds without approval. How should it proceed?",
		options: EXHAUSTION_OPTIONS,
	});
	if (answers === undefined) {
		return {
			kind: "none",
			note: "the user could not be asked (no interactive answerer is available), so the run ended NOT APPROVED",
		};
	}
	const label = selectedLabel(answers, "exhaustion");
	if (label === "Continue without approval") return { kind: "continue" };
	if (label === "Try 3 more rounds") return { kind: "retry" };
	if (label === "Change the WORKER model") return { kind: "model" };
	if (label === "Stop") return { kind: "stop" };
	return {
		kind: "none",
		note: `the exhaustion answer "${label ?? "(none)"}" was not recognized, so the run ended NOT APPROVED`,
	};
}

/**
 * Ask the user which model the WORKER should use next.
 */
async function askWorkerModelRoute(
	ctx: HostContext,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
): Promise<Route | undefined> {
	const llm = ctx.get("llm");
	if (
		llm === undefined ||
		llm === null ||
		typeof llm.listProviders !== "function" ||
		typeof llm.listModels !== "function"
	) {
		return undefined;
	}
	const options = [];
	try {
		for (const provider of llm.listProviders()) {
			let models = [];
			try {
				models = await llm.listModels(provider.id);
			} catch {
				continue;
			}
			for (const model of Array.isArray(models) ? models : []) {
				if (options.length >= 40) break;
				options.push({
					label: `${provider.id}/${model.id}`,
					description: model.name ?? model.id,
				});
			}
			if (options.length >= 40) break;
		}
	} catch {
		return undefined;
	}
	if (options.length === 0) return undefined;
	const answers = await askUserChoice(ctx, agent, signal, {
		id: "worker-model",
		header: "WORKER model",
		question: "Which model should the WORKER use for the next attempts?",
		options,
	});
	const label = selectedLabel(answers, "worker-model");
	if (label === undefined) return undefined;
	const parsed = normalizeRoute(label);
	return parsed.error !== undefined || parsed.route === null
		? undefined
		: parsed.route;
}

/* ------------------------------------------------------------------------- *
 * The orchestrated team loop
 * ------------------------------------------------------------------------- */

/**
 * Run the full PLAN -> plan audit -> WORKER -> ADVISOR -> REVIEWER loop.
 *
 * The loop is deterministic and every role invocation passes through one
 * `stage` helper, so the fixed order cannot be bypassed: the ADVISOR audits
 * the plan before WORKER starts (a rejected plan is revised from the
 * advisor's issues), ADVISOR audits every WORKER attempt, REVIEWER runs only
 * after ADVISOR approves, and the only approved outcome is the REVIEWER's
 * verdict. When the rounds are exhausted without approval, the user decides
 * how to proceed.
 *
 */
export async function runRoleTeam(
	ctx: HostContext,
	{
		agent,
		task,
		context,
		plan,
		signal,
		config,
		callId,
		onState,
		onChild,
	}: RunOptions,
): Promise<TeamOutcome> {
	if (agent === undefined || agent === null)
		throw new Error("role team needs a calling agent");
	const taskText = typeof task === "string" ? task.trim() : "";
	if (taskText === "") throw new Error("role team needs a non-empty task");
	let cwd = ctx.get("workingDirectory")?.get?.(agent.session);
	const usedRoles: readonly Role[] =
		plan === undefined || plan.trim() === ""
			? ROLE_NAMES
			: ["worker", "advisor", "reviewer"];
	const configProblems = config.problems.filter((problem) =>
		usedRoles.includes(problem.role),
	);
	if (configProblems.length > 0) {
		throw new Error(
			`role team configuration is invalid: ${configProblems.map((problem) => `${problem.role}: ${problem.message}`).join("; ")}`,
		);
	}
	for (const role of usedRoles) {
		const route = config.roles[role] ?? null;
		if (route !== null) await validateRoute(ctx, role, route, signal);
	}
	// A local copy of the routes: a worker model chosen through the exhaustion
	// question changes later attempts without mutating the plugin's config.
	const runConfig = { ...config, roles: { ...config.roles } };
	const startedAt = Date.now();
	const stages: Stage[] = [];
	const comments: Comment[] = [];
	const decisions: Decision[] = [];
	const planAudits: TeamOutcome["planAudits"] = [];
	beginRunState(callId, "roles_run", oneLine(taskText, 300));
	const liveState = runStates.get(callId);
	if (liveState) {
		liveState.comments = comments;
		liveState.decisions = decisions;
	}
	/**
	 * Every role invocation of this run passes through here, so the stage
	 * order is one code path and no stage can run outside it.
	 */
	const stage = async (role: Role, prompt: string) => {
		beginRunStage(callId, role, runConfig.roles[role] ?? null);
		try {
			const result = await runRole(ctx, runConfig, {
				role,
				prompt,
				parent: agent,
				signal,
				cwd,
				callId,
				onChild,
			});
			stages.push({
				role,
				route: result.route,
				status: result.status,
				durationMs: result.durationMs,
			});
			endRunStage(callId, role, result.status, result.durationMs);
			return result;
		} catch (error) {
			endRunStage(callId, role, "failed", 0);
			throw error;
		}
	};
	try {
		let planText = typeof plan === "string" ? plan.trim() : "";
		if (planText === "") {
			const planResult = await stage(
				"plan",
				buildPlanPrompt({
					task: taskText,
					context,
					cwd,
					extra: runConfig.prompts.plan,
				}),
			);
			planText = planResult.text.trim();
			if (planText === "") {
				throw new Error(
					`PLAN finished without a plan (${planResult.status}${planResult.diagnostic === undefined ? "" : `: ${clip(planResult.diagnostic, 1200)}`}); role team cannot continue`,
				);
			}
		}
		// Plan audit: the ADVISOR judges the plan itself before WORKER starts;
		// a rejected plan is revised from the advisor's issues, and whatever
		// still stands when the passes run out reaches the WORKER prompt.
		let planIssues: string[] = [];
		for (let pass = 1; pass <= runConfig.maxPlanPasses; pass += 1) {
			if (signal !== undefined && signal.aborted)
				throw new Error("role team was cancelled");
			const audit = await stage(
				"advisor",
				buildPlanAuditPrompt({
					task: taskText,
					context,
					plan: planText,
					cwd,
					extra: runConfig.prompts.advisor,
				}),
			);
			const auditVerdict = parseVerdict(audit.text);
			planAudits.push({
				pass,
				route: audit.route,
				durationMs: audit.durationMs,
				verdict: auditVerdict,
			});
			comments.push({
				role: "advisor",
				stage: `plan audit ${pass}`,
				route: audit.route,
				approved: auditVerdict.approved,
				summary: auditVerdict.summary,
				issues: auditVerdict.issues,
			});
			if (auditVerdict.approved) {
				planIssues = [];
				break;
			}
			planIssues = feedbackLines(auditVerdict.issues);
			if (pass < runConfig.maxPlanPasses) {
				const revision = await stage(
					"plan",
					buildPlanRevisionPrompt({
						task: taskText,
						context,
						plan: planText,
						issues: planIssues,
						cwd,
						extra: runConfig.prompts.plan,
					}),
				);
				const revised = revision.text.trim();
				if (revised !== "") planText = revised;
			}
		}
		const rounds: Round[] = [];
		let feedback = [...planIssues];
		let previousReport;
		let attemptLimit = Math.max(
			1,
			Math.min(runConfig.maxRounds, LIMITS.maxRounds),
		);
		let number = 0;
		let status: TeamOutcome["status"] = "unapproved";
		let note;
		// The round loop. The only exits are the REVIEWER's approval, the user's
		// exhaustion decision, and the hard attempt cap.
		for (;;) {
			if (signal !== undefined && signal.aborted)
				throw new Error("role team was cancelled");
			if (number >= attemptLimit) {
				const waiting = runStates.get(callId);
				if (waiting) {
					waiting.phase = "awaiting_user";
					waiting.progress =
						"Waiting for your decision after the worker round limit";
				}
				const decision = await decideOnExhaustion(ctx, agent, signal);
				if (waiting) {
					delete waiting.phase;
					delete waiting.progress;
				}
				if (decision.kind === "model") {
					if (waiting) {
						waiting.phase = "awaiting_user";
						waiting.progress = "Waiting for your worker model choice";
					}
					const route = await askWorkerModelRoute(ctx, agent, signal);
					if (waiting) {
						delete waiting.phase;
						delete waiting.progress;
					}
					if (route === undefined) {
						decisions.push({
							choice: "model",
							note: "no worker model was chosen",
						});
						status = "unapproved";
						note = "no worker model was chosen, so the run ended NOT APPROVED";
						break;
					}
					try {
						await validateRoute(ctx, "worker", route, signal);
					} catch (error) {
						decisions.push({
							choice: "model",
							route,
							note: `the chosen route is not usable: ${messageOf(error)}`,
						});
						status = "unapproved";
						note =
							"the chosen worker route is not usable, so the run ended NOT APPROVED";
						break;
					}
					runConfig.roles.worker = route;
					decisions.push({ choice: "model", route });
				} else {
					decisions.push({
						choice: decision.kind,
						...(decision.note === undefined ? {} : { note: decision.note }),
					});
				}
				if (decision.kind === "continue") {
					status = "continued";
					break;
				}
				if (decision.kind === "stop" || decision.kind === "none") {
					status = "unapproved";
					if (decision.note !== undefined) note = decision.note;
					break;
				}
				if (attemptLimit + 3 > LIMITS.maxWorkerAttempts) {
					status = "unapproved";
					note = `the hard cap of ${LIMITS.maxWorkerAttempts} worker attempts was reached, so no more rounds could be granted`;
					break;
				}
				attemptLimit += 3;
				continue;
			}
			number += 1;
			const workerPrompt = buildWorkerPrompt({
				task: taskText,
				context,
				plan: planText,
				cwd,
				round: number,
				feedback,
				previous: previousReport,
				extra: runConfig.prompts.worker,
			});
			const worker = await stage("worker", workerPrompt);
			if (worker.cwd !== undefined) cwd = worker.cwd;
			previousReport = worker.text;
			const advisorPrompt = buildAdvisorPrompt({
				task: taskText,
				context,
				plan: planText,
				cwd,
				workerReport: worker.text,
				round: number,
				feedback,
				extra: runConfig.prompts.advisor,
			});
			const advisor = await stage("advisor", advisorPrompt);
			const advisorVerdict = parseVerdict(advisor.text);
			const round: Round = { number, worker, advisor, advisorVerdict };
			comments.push({
				role: "advisor",
				stage: `round ${number} attempt`,
				route: advisor.route,
				approved: advisorVerdict.approved,
				summary: advisorVerdict.summary,
				issues: advisorVerdict.issues,
			});
			if (!advisorVerdict.approved) {
				rounds.push(round);
				feedback = feedbackLines(advisorVerdict.issues);
				if (feedback.length === 0)
					feedback = [
						"[major] ADVISOR did not approve and returned no issue details; inspect the workspace and retry.",
					];
				continue;
			}
			const reviewerPrompt = buildReviewerPrompt({
				task: taskText,
				context,
				plan: planText,
				cwd,
				workerReport: worker.text,
				advisorVerdict: advisor.text,
				extra: runConfig.prompts.reviewer,
			});
			const reviewer = await stage("reviewer", reviewerPrompt);
			const reviewerVerdict = parseVerdict(reviewer.text);
			round.reviewer = reviewer;
			round.reviewerVerdict = reviewerVerdict;
			rounds.push(round);
			comments.push({
				role: "reviewer",
				stage: `round ${number} final gate`,
				route: reviewer.route,
				approved: reviewerVerdict.approved,
				summary: reviewerVerdict.summary,
				issues: reviewerVerdict.issues,
			});
			if (reviewerVerdict.approved) {
				status = "approved";
				break;
			}
			feedback = feedbackLines(reviewerVerdict.issues);
			if (feedback.length === 0)
				feedback = [
					"[major] REVIEWER did not approve and returned no issue details; inspect the workspace and retry.",
				];
		}
		const report = buildTeamReport({
			status,
			config: runConfig,
			plan: planText,
			rounds,
			comments,
			decisions,
			startedAt,
			task: taskText,
			note,
		});
		return {
			status,
			plan: planText,
			planAudits,
			rounds,
			stages,
			comments,
			decisions,
			report,
		};
	} finally {
		onState?.({ ...runStateOf(callId), comments, decisions });
		endRunState(callId);
	}
}

/* ------------------------------------------------------------------------- *
 * Tool definitions
 * ------------------------------------------------------------------------- */

/**
 * Coerce a tool argument to a bounded string.
 */
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

/**
 * The shared output declaration: every role tool returns one text report.
 */
function renderText(_args: unknown, value: ToolValue): TextBlock[] {
	return [{ type: "text", text: value.text }];
}

/** A JSON Schema fragment that accepts any value, for nullable optional fields. */
const LOOSE = Object.freeze({});

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

/**
 * Run one role for a single-role tool while tracking it in the live run state.
 */
async function runTrackedRole(
	ctx: HostContext,
	config: RoleTeamConfig,
	{ tool, task, role, prompt, agent, signal, cwd, callId }: TrackedRoleOptions,
): Promise<RoleResult> {
	beginRunState(callId, tool, oneLine(task, 300));
	beginRunStage(callId, role, config.roles[role] ?? null);
	try {
		const result = await runRole(ctx, config, {
			role,
			prompt,
			parent: agent,
			signal,
			cwd,
			callId,
		});
		endRunStage(callId, role, result.status, result.durationMs);
		return result;
	} catch (error) {
		endRunStage(callId, role, "failed", 0);
		throw error;
	} finally {
		endRunState(callId);
	}
}

/**
 * Register one tool with a caller context.
 */
function registerTool(ctx: HostContext, definition: ToolDefinition): void {
	ctx.effect(() => ctx.tools.register(definition));
}

/**
 * Build every model-facing tool for one resolved configuration.
 */
function buildTools(
	ctx: HostContext,
	config: RoleTeamConfig,
	background: BackgroundRuns,
): ToolDefinition[] {
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
			const context = stringArg(args, "context", { max: 30_000 });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const rounds = isPlainObject(args) ? args.max_rounds : undefined;
			const effectiveConfig =
				rounds === undefined
					? config
					: {
							...config,
							maxRounds: clampInt(
								rounds,
								1,
								LIMITS.maxRounds,
								config.maxRounds,
							),
						};
			const outcome = await runRoleTeam(ctx, {
				agent: exec.agent,
				task,
				context,
				plan,
				signal: exec.signal,
				config: effectiveConfig,
				callId: exec.callId,
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
						...(round.worker.cwd
							? {
									cwd: round.worker.cwd,
									artifacts: round.worker.artifacts ?? [],
									runtimeSessionId: round.worker.runtimeSessionId,
								}
							: {}),
					},
					advisor: {
						role: "advisor",
						route: round.advisor.route,
						status: round.advisor.status,
						durationMs: round.advisor.durationMs,
					},
					...(round.reviewer === undefined
						? {}
						: {
								reviewer: {
									role: "reviewer",
									route: round.reviewer.route,
									status: round.reviewer.status,
									durationMs: round.reviewer.durationMs,
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
			const context = stringArg(args, "context", { max: 30_000 });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const rounds = isPlainObject(args) ? args.max_rounds : undefined;
			const effectiveConfig =
				rounds === undefined
					? config
					: {
							...config,
							maxRounds: clampInt(
								rounds,
								1,
								LIMITS.maxRounds,
								config.maxRounds,
							),
						};
			return background.start(exec.agent, `roles-${randomUUID()}`, {
				task,
				context,
				plan,
				config: effectiveConfig,
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
			return background.status(
				exec.agent,
				stringArg(args, "run_id"),
				stringArg(args, "question", { max: 2000 }),
				exec.signal,
			);
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
			const task = stringArg(args, "task", { required: true });
			const context = stringArg(args, "context", { max: 30_000 });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			if (config.roles.plan !== null)
				await validateRoute(ctx, "plan", config.roles.plan, exec.signal);
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
			const task = stringArg(args, "task", { required: true });
			const plan = stringArg(args, "plan", { max: LIMITS.planChars });
			const feedback = stringArg(args, "feedback", { max: 8000 });
			const context = stringArg(args, "context", { max: 30_000 });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			if (config.roles.worker !== null)
				await validateRoute(ctx, "worker", config.roles.worker, exec.signal);
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
			if (result.status === "completed") workerReportedDone.add(exec.agent);
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
			const task = stringArg(args, "task", { required: true });
			const plan =
				stringArg(args, "plan", { max: LIMITS.planChars }) ??
				"(no plan supplied)";
			const workerReport =
				stringArg(args, "worker_report", { max: LIMITS.workerChars }) ??
				"(no worker report; inspect the current workspace and judge it against the task)";
			const context = stringArg(args, "context", { max: 20_000 });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			if (config.roles.advisor !== null)
				await validateRoute(ctx, "advisor", config.roles.advisor, exec.signal);
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
			if (!workerReportedDone.has(exec.agent)) {
				throw new Error(
					"REVIEWER is the final gate: start a WORKER and let it report completion (role_worker or roles_run) before starting the reviewer",
				);
			}
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
			const context = stringArg(args, "context", { max: 20_000 });
			const cwd = ctx.get("workingDirectory")?.get?.(exec.agent.session);
			if (config.roles.reviewer !== null)
				await validateRoute(
					ctx,
					"reviewer",
					config.roles.reviewer,
					exec.signal,
				);
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

/* ------------------------------------------------------------------------- *
 * /roles command
 * ------------------------------------------------------------------------- */

/**
 * Persist one role route through the profile configuration editor.
 */
async function saveRoleRoute(
	ctx: HostContext,
	role: Role,
	route: Route | null,
): Promise<unknown> {
	const editor = ctx.get("configEditor");
	if (editor === undefined || editor === null) {
		throw new Error(
			"the configuration editor is unavailable; edit the role-team row in the profile cordis.patch.yml instead",
		);
	}
	const entry = ctx.fiber?.entry;
	if (entry === undefined || entry === null) {
		throw new Error(
			"the role-team plugin is not mounted through the Loader; its configuration cannot be persisted",
		);
	}
	let nextConfig;
	await editor.edit(entry, (current) => {
		const next = isPlainObject(current) ? cloneJson(current) : {};
		const roles = isPlainObject(next.roles) ? next.roles : {};
		if (route === null) Reflect.deleteProperty(roles, role);
		else
			roles[role] = {
				provider: route.provider,
				model: route.model,
				...(route.runtime === undefined ? {} : { runtime: route.runtime }),
				...(route.reasoningEffort === undefined
					? {}
					: { reasoningEffort: route.reasoningEffort }),
			};
		if (Object.keys(roles).length === 0) Reflect.deleteProperty(next, "roles");
		else next.roles = roles;
		nextConfig = next;
		return next;
	});
	return nextConfig;
}

/**
 * Build the client-safe role snapshot served to the settings page.
 */
export function roleTeamSnapshot(rawConfig: unknown) {
	const config = resolveRoleTeamConfig(rawConfig);
	const roles = {} as Record<
		Role,
		{
			route: Route | null;
			source: RoleTeamConfig["sources"][Role];
			family: string | null;
			problem?: string;
		}
	>;
	for (const role of ROLE_NAMES) {
		const route = config.roles[role] ?? null;
		const problem = config.problems.find(
			(candidate) => candidate.role === role,
		);
		roles[role] = {
			route: route === null ? null : { ...route },
			source: config.sources[role],
			family: familyOf(route),
			...(problem === undefined ? {} : { problem: problem.message }),
		};
	}
	return {
		ok: true,
		roles,
		warnings: familyWarnings(config.roles),
		maxRounds: config.maxRounds,
		childMaxDepth: config.childMaxDepth,
	};
}

/**
 * Report whether the browser half is present in the composed client graph.
 */
function clientModuleStatus(ctx: HostContext) {
	try {
		const graph = ctx.get("clientModules")?.graph?.();
		if (graph === undefined) return { clientModule: false };
		const entry = graph.entries.find(
			(candidate) => candidate.id === "@local/dsh-role-team",
		);
		return {
			clientModule: entry !== undefined,
			...(entry === undefined ? {} : { url: entry.url }),
			rev: graph.rev,
		};
	} catch {
		return { clientModule: false };
	}
}

/**
 * Whether a hostname names this machine.
 */
function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

/**
 * Whether a Host header names a loopback authority.
 */
function isLoopbackAuthority(authority: string): boolean {
	try {
		return isLoopbackHostname(new URL(`http://${authority}`).hostname);
	} catch {
		return false;
	}
}

/**
 * Admit only same-origin loopback requests to the settings route.
 */
function trustedRoleRouteRequest(request: Request): boolean {
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	if (!isLoopbackAuthority(request.headers.get("host") ?? "")) return false;
	const origin = request.headers.get("origin");
	if (origin === null || origin === "") return true;
	try {
		return isLoopbackHostname(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/**
 * Render one settings-route response.
 */
function roleRouteJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/**
 * Serve GET and POST for the role settings page.
 *
 * GET returns the effective role table. POST sets one role route or resets it
 * to the recommended default. Mutations validate the route against the live
 * adapter and persist through the profile configuration editor.
 *
 */
export async function handleRolesRoute(
	ctx: HostContext,
	request: Request,
	rawConfig: unknown,
): Promise<Response> {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	const method = request.method.toUpperCase();
	if (method === "GET")
		return roleRouteJson({
			...roleTeamSnapshot(rawConfig),
			client: clientModuleStatus(ctx),
		});
	if (method === "HEAD")
		return new Response(null, {
			status: 200,
			headers: { "cache-control": "no-store" },
		});
	if (method !== "POST") {
		return new Response("method not allowed", {
			status: 405,
			headers: { allow: "GET, HEAD, POST" },
		});
	}
	if (request.headers.get("x-role-team-request") !== "1") {
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	}
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > 8192) {
		return roleRouteJson({ ok: false, error: "payload too large" }, 413);
	}
	let body;
	try {
		const text = await request.text();
		if (text.length > 8192)
			return roleRouteJson({ ok: false, error: "payload too large" }, 413);
		body = JSON.parse(text);
	} catch {
		return roleRouteJson({ ok: false, error: "invalid JSON body" }, 400);
	}
	if (!isPlainObject(body))
		return roleRouteJson({ ok: false, error: "invalid request body" }, 400);
	const role = typeof body.role === "string" ? body.role.toLowerCase() : "";
	if (!isRole(role))
		return roleRouteJson({ ok: false, error: "unknown role" }, 400);
	try {
		if (body.action === "reset") {
			const next = await saveRoleRoute(ctx, role, null);
			return roleRouteJson(roleTeamSnapshot(next));
		}
		const parsed = normalizeRoute(body.route);
		if (parsed.error !== undefined || parsed.route === null) {
			return roleRouteJson(
				{
					ok: false,
					error: parsed.error ?? "a concrete provider/model route is required",
				},
				400,
			);
		}
		await validateRoute(ctx, role, parsed.route, request.signal);
		const next = await saveRoleRoute(ctx, role, parsed.route);
		return roleRouteJson(roleTeamSnapshot(next));
	} catch (error) {
		return roleRouteJson({ ok: false, error: messageOf(error) }, 400);
	}
}

/**
 * Read one HTTP request body with a hard size limit.
 */
function readRoleRouteBody(
	req: IncomingMessage,
	limit: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				const error = Object.assign(new Error("payload too large"), {
					code: "ROLE_TEAM_PAYLOAD_TOO_LARGE",
				});
				reject(error);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", reject);
	});
}

/**
 * Adapt the settings route to the Node HTTP carrier.
 *
 * Resource routes only answer GET and HEAD, so the page's mutations use an
 * exact WebRoute handler and the shared Fetch-shaped handler above.
 *
 */
async function handleRolesHttp(
	ctx: HostContext,
	req: IncomingMessage,
	res: ServerResponse,
	rawConfig: unknown,
): Promise<void> {
	try {
		const method = (req.method ?? "GET").toUpperCase();
		const body =
			method === "GET" || method === "HEAD"
				? undefined
				: await readRoleRouteBody(req, 8192);
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (value !== undefined)
				headers.set(name, Array.isArray(value) ? value.join(",") : value);
		}
		const request = new Request(
			`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? ROLES_SETTINGS_ROUTE}`,
			{
				method,
				headers,
				...(body === undefined ? {} : { body }),
			},
		);
		const response = await handleRolesRoute(ctx, request, rawConfig);
		res.statusCode = response.status;
		response.headers.forEach((value, name) => {
			res.setHeader(name, value);
		});
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		const status =
			error instanceof Error &&
			"code" in error &&
			error.code === "ROLE_TEAM_PAYLOAD_TOO_LARGE"
				? 413
				: 400;
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify({ ok: false, error: messageOf(error) }));
	}
}

/**
 * Render the current role table.
 */
function roleTable(config: RoleTeamConfig): string {
	const lines = ["Role team routes:"];
	for (const role of ROLE_NAMES) {
		const route = config.roles[role];
		const source = config.sources[role];
		const label = route === null ? "inherit session model" : formatRoute(route);
		const suffix =
			source === "default"
				? " (recommended default)"
				: source === "inherit"
					? " (inherited)"
					: "";
		lines.push(`  ${role.padEnd(8)} ${label}${suffix}`);
	}
	const warnings = familyWarnings(config.roles);
	if (warnings.length > 0) {
		lines.push("");
		for (const warning of warnings) lines.push(`Warning: ${warning}`);
	}
	lines.push("");
	lines.push(
		"Commands: /roles set <role> <provider>/<model>[:effort] · /roles reset <role> · /roles models [provider] · /roles doctor · /roles run <task> · /roles status [run-id] · /roles cancel [run-id] · /role-plan <task or plan.md>",
	);
	return lines.join("\n");
}

/**
 * Family-independence warnings for the configured routes.
 */
function familyWarnings(roles: Record<Role, Route | null>): string[] {
	const warnings = [];
	const worker = familyOf(roles.worker ?? null);
	const advisor = familyOf(roles.advisor ?? null);
	const reviewer = familyOf(roles.reviewer ?? null);
	if (worker !== null && advisor !== null && worker === advisor) {
		warnings.push(
			`WORKER and ADVISOR both use the ${worker} family; the advisor's independence is weaker. Choose a different family for one of them.`,
		);
	}
	if (worker !== null && reviewer !== null && worker === reviewer) {
		warnings.push(
			`WORKER and REVIEWER both use the ${worker} family; the final gate is not independent.`,
		);
	}
	if (advisor !== null && reviewer !== null && advisor === reviewer) {
		warnings.push(
			`ADVISOR and REVIEWER both use the ${advisor} family; the final gate is not independent from the advisor.`,
		);
	}
	if (worker === null || advisor === null || reviewer === null) {
		warnings.push(
			"At least one of WORKER, ADVISOR or REVIEWER inherits the session model, so cross-family independence is not guaranteed.",
		);
	}
	return warnings;
}

/**
 * Validate every configured route and report independence warnings.
 */
async function doctorReport(
	ctx: HostContext,
	config: RoleTeamConfig,
	signal?: AbortSignal,
): Promise<string> {
	const lines = ["Role team doctor:"];
	for (const role of ROLE_NAMES) {
		const route = config.roles[role];
		if (route === null) {
			lines.push(`  ${role.padEnd(8)} inherit session model`);
			continue;
		}
		try {
			await validateRoute(ctx, role, route, signal);
			lines.push(
				`  ${role.padEnd(8)} ok — ${formatRoute(route)} (${familyOf(route) ?? "unknown"} family; credentials are verified on the first run)`,
			);
		} catch (error) {
			lines.push(
				`  ${role.padEnd(8)} FAILED — ${formatRoute(route)}: ${messageOf(error)}`,
			);
		}
	}
	for (const problem of config.problems) {
		lines.push(
			`  ${problem.role.padEnd(8)} config problem: ${problem.message}`,
		);
	}
	const warnings = familyWarnings(config.roles);
	if (warnings.length > 0) {
		lines.push("");
		for (const warning of warnings) lines.push(`Warning: ${warning}`);
	}
	return lines.join("\n");
}

/**
 * List registered providers and their advertised models.
 */
async function modelsReport(
	ctx: HostContext,
	providerArg: string | undefined,
): Promise<string> {
	const llm = ctx.get("llm");
	if (llm === undefined || llm === null)
		throw new Error("the LLM service is unavailable");
	const providers =
		typeof llm.listProviders === "function" ? llm.listProviders() : [];
	if (providerArg !== undefined) {
		const provider = providers.find(
			(candidate) => candidate.id === providerArg,
		);
		if (provider === undefined) {
			const available =
				providers.map((candidate) => candidate.id).join(", ") || "(none)";
			throw new Error(
				`provider "${providerArg}" is not registered; available providers: ${available}`,
			);
		}
		let models = [];
		try {
			models = await llm.listModels(providerArg);
		} catch (error) {
			throw new Error(
				`provider "${providerArg}" could not list models: ${messageOf(error)}`,
			);
		}
		const lines = [
			`Models for ${provider.name ?? providerArg} (${providerArg}):`,
		];
		for (const model of models)
			lines.push(
				`  ${model.id}${model.name === undefined || model.name === model.id ? "" : ` — ${model.name}`}`,
			);
		if (models.length === 0) lines.push("  (the adapter advertises no models)");
		return clip(lines.join("\n"), LIMITS.reportChars);
	}
	const lines = ["Registered providers:"];
	for (const provider of providers) {
		let count = "?";
		try {
			const models = await llm.listModels(provider.id);
			count = String(models.length);
		} catch {
			count = "unavailable";
		}
		lines.push(
			`  ${provider.id} — ${provider.name ?? provider.id} (${count} models)`,
		);
	}
	if (providers.length === 0) lines.push("  (none)");
	lines.push("");
	lines.push("Use /roles models <provider> to list model ids.");
	return lines.join("\n");
}

/**
 * Execute one `/roles` command line.
 */
async function handleRolesCommand(
	ctx: HostContext,
	config: RoleTeamConfig,
	invocation: CommandInvocation,
	background: BackgroundRuns,
): Promise<CommandResult> {
	const raw =
		typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
	if (raw === "") return { kind: "success", text: roleTable(config) };
	const space = raw.search(/\s/);
	const verb = (space < 0 ? raw : raw.slice(0, space)).toLowerCase();
	const rest = space < 0 ? "" : raw.slice(space + 1).trim();
	try {
		if (verb === "set") {
			const [roleToken, ...routeTokens] = rest.split(/\s+/).filter(Boolean);
			if (roleToken === undefined || routeTokens.length === 0) {
				throw new Error(
					"usage: /roles set <plan|worker|advisor|reviewer> <provider>/<model>[:effort]",
				);
			}
			const role = roleToken.toLowerCase();
			if (!isRole(role))
				throw new Error(
					`unknown role "${roleToken}"; choose one of ${ROLE_NAMES.join(", ")}`,
				);
			const parsed = normalizeRoute(routeTokens.join(" "));
			if (parsed.error !== undefined || parsed.route === null) {
				throw new Error(
					parsed.error ??
						"a concrete provider/model route is required; use /roles reset to inherit the session model",
				);
			}
			await validateRoute(ctx, role, parsed.route, invocation.signal);
			await saveRoleRoute(ctx, role, parsed.route);
			return {
				kind: "success",
				text: `Role ${role} now uses ${formatRoute(parsed.route)}. The route resolves; credentials are verified by the first role run. Applied and saved to the profile patch.`,
			};
		}
		if (verb === "reset") {
			const role = rest.toLowerCase();
			if (!isRole(role))
				throw new Error(
					`unknown role "${rest}"; choose one of ${ROLE_NAMES.join(", ")}`,
				);
			await saveRoleRoute(ctx, role, null);
			return {
				kind: "success",
				text: `Role ${role} reset to the recommended default (or the inherited session model when no default is configured).`,
			};
		}
		if (verb === "models") {
			return {
				kind: "success",
				text: await modelsReport(ctx, rest === "" ? undefined : rest),
			};
		}
		if (verb === "doctor") {
			return {
				kind: "success",
				text: await doctorReport(ctx, config, invocation.signal),
			};
		}
		if (verb === "status") {
			return {
				kind: "success",
				text: (await background.status(invocation.agent, rest || undefined))
					.text,
			};
		}
		if (verb === "cancel") {
			return {
				kind: "success",
				text: background.cancel(invocation.agent, rest || undefined).text,
			};
		}
		if (verb === "run") {
			if (rest === "") throw new Error("usage: /roles run <task>");
			if (invocation.signal?.aborted)
				throw new Error("role team was cancelled");
			const run = background.start(invocation.agent, `roles-${randomUUID()}`, {
				task: rest,
				config,
			});
			return {
				kind: "success",
				text: `${run.text}\nUse /roles status for progress or /roles cancel to stop.`,
			};
		}
		throw new Error(
			`unknown /roles subcommand "${verb}"; use set, reset, models, doctor, run, status or cancel`,
		);
	} catch (error) {
		return { kind: "error", text: messageOf(error) };
	}
}

/**
 * Register the `/roles` command when the commands service is available.
 */
function registerRolesCommand(
	ctx: HostContext,
	config: RoleTeamConfig,
	background: BackgroundRuns,
): void {
	const commands = ctx.get("commands");
	if (
		commands === undefined ||
		commands === null ||
		typeof commands.register !== "function"
	)
		return;
	ctx.effect(() =>
		commands.register({
			name: "roles",
			description:
				"Show or change the role team models, check role routes, or run the full role team.",
			input: {
				hint: "[set <role> <provider>/<model>[:effort] | reset <role> | models [provider] | doctor | run <task> | status [run-id] | cancel [run-id]]",
			},
			handler: (invocation) =>
				handleRolesCommand(ctx, config, invocation, background),
		}),
	);
}

/**
 * Execute one `/role-plan` command line: a task, or a Markdown plan file.
 *
 * A `.md` argument is read as the plan (absolute, or relative to the session
 * workspace, e.g. a Jev plan artifact) and PLAN is skipped; anything else is
 * the task text and PLAN writes the plan.
 *
 * The run never happens in the session that typed the command. The command
 * creates a dedicated session in the same working directory, hands it one
 * deterministic prompt that calls `roles_start` with the exact task and plan, and
 * returns at once; the browser half opens that session, so the pipeline and its
 * live roles card live there while the current session stays free.
 *
 */
export async function handleRolePlanCommand(
	ctx: HostContext,
	_config: RoleTeamConfig,
	invocation: CommandInvocation,
): Promise<CommandResult> {
	const raw =
		typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
	if (raw === "") {
		return {
			kind: "error",
			text: "usage: /role-plan <task or plan.md> — with a task, PLAN writes the plan; with a path to a .md plan file (for example a Jev plan artifact), the plan is read from the file and PLAN is skipped.",
		};
	}
	let plan;
	let task = raw;
	if (/\.md$/i.test(raw)) {
		const session = invocation.agent?.session;
		const base = ctx.get("workingDirectory")?.get?.(session);
		const path = isAbsolute(raw)
			? raw
			: resolvePath(base ?? process.cwd(), raw);
		let content;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			return {
				kind: "error",
				text: `could not read the plan file "${raw}": ${messageOf(error)}; give an absolute path or a path relative to the session workspace`,
			};
		}
		if (content.trim() === "")
			return { kind: "error", text: `the plan file "${raw}" is empty` };
		if (content.length > LIMITS.planFileMaxChars) {
			return {
				kind: "error",
				text: `the plan file "${raw}" is larger than ${LIMITS.planFileMaxChars} characters; split it or pass the essential part as text`,
			};
		}
		plan = clip(content, LIMITS.planChars);
		task = `Execute the plan in ${raw} exactly.`;
	}
	const controller = ctx.get("sessionController");
	if (
		controller === undefined ||
		controller === null ||
		typeof controller.create !== "function" ||
		typeof controller.prompt !== "function"
	) {
		return {
			kind: "error",
			text: "this Host mounts no session controller, so /role-plan cannot open a separate session; call roles_start in a normal session instead.",
		};
	}
	const parentSession = invocation.agent?.session;
	let cwd = "";
	try {
		cwd = ctx.get("workingDirectory")?.get?.(parentSession) ?? "";
	} catch {
		cwd = "";
	}
	const sessionId = `session-${randomUUID()}`;
	rememberPlanSession(sessionId);
	try {
		await controller.create({
			sessionId,
			...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}),
		});
	} catch (error) {
		planSessions.delete(sessionId);
		return {
			kind: "error",
			text: `could not create the role-team session: ${messageOf(error)}`,
		};
	}
	if (typeof cwd === "string" && cwd !== "") {
		try {
			const registry = ctx.get("workspaceRegistry");
			const workspace =
				typeof registry?.resolveByPath === "function"
					? await registry.resolveByPath(cwd)
					: undefined;
			await workspace?.attachSession?.(sessionId);
		} catch (error) {
			ctx.logger?.warn?.(
				`role-team: session ${sessionId} was created but not attached to "${cwd}": ${messageOf(error)}`,
			);
		}
	}
	try {
		await controller.rename({ sessionId, title: planSessionTitle(task) });
	} catch (error) {
		ctx.logger?.warn?.(
			`role-team: session ${sessionId} keeps its default title: ${messageOf(error)}`,
		);
	}
	try {
		await controller.prompt(
			{
				requestId: `role-plan-${randomUUID()}`,
				sessionId,
				mode: "queue",
				content: [{ type: "text", text: planSessionPrompt(task, plan) }],
			},
			invocation.signal ?? new AbortController().signal,
		);
	} catch (error) {
		return {
			kind: "error",
			text: `the role-team session ${sessionId} was created, but the run could not be started: ${messageOf(error)}`,
		};
	}
	return {
		kind: "success",
		text: [
			"Role team run started in a new session.",
			`Session: ${sessionId}`,
			`Task: ${oneLine(task, 240)}`,
			...(plan === undefined
				? []
				: [
						`Plan: passed verbatim to the role team (${plan.length} characters).`,
					]),
			"That session starts roles_start in the background and stays available for progress questions; the workspace opens it automatically.",
		].join("\n"),
	};
}

/**
 * Register the `/role-plan` command when the commands service is available.
 */
function registerRolePlanCommand(
	ctx: HostContext,
	config: RoleTeamConfig,
): void {
	const commands = ctx.get("commands");
	if (
		commands === undefined ||
		commands === null ||
		typeof commands.register !== "function"
	)
		return;
	ctx.effect(() =>
		commands.register({
			name: "role-plan",
			description:
				"Run the full role team on a task or a plan file in a new session: the ADVISOR audits the plan, WORKER implements it, ADVISOR checks every attempt, and REVIEWER gives the final verdict.",
			input: { hint: "<task or plan.md>" },
			handler: (invocation) => handleRolePlanCommand(ctx, config, invocation),
		}),
	);
}

/* ------------------------------------------------------------------------- *
 * Live run-state route
 * ------------------------------------------------------------------------- */

/** Same-origin prefix route serving the live state of one run. */
const RUN_STATE_ROUTE = "/plugin-api/role-team/run";

/**
 * Serve the live run state of one tool call over the plugin API.
 *
 * GET-only (the webserver answers anything else itself), loopback-guarded,
 * never cached; unknown ids answer 404 so a settled or replayed call stops
 * polling immediately.
 *
 */
export function handleRunStateRequest(
	ctx: HostContext,
	request: Request,
): Response {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	let callId = "";
	try {
		const url = new URL(request.url);
		const rest = url.pathname.slice(RUN_STATE_ROUTE.length);
		callId = rest === "" ? "" : decodeURIComponent(rest.replace(/^\//, ""));
	} catch {
		return roleRouteJson({ ok: false, error: "bad request" }, 400);
	}
	if (callId === "" || callId.includes("/"))
		return roleRouteJson({ ok: false, error: "unknown run" }, 404);
	const run =
		backgroundControllers.get(ctx)?.publicState(callId) ??
		runStates.get(callId);
	if (run === undefined)
		return roleRouteJson({ ok: false, error: "unknown run" }, 404);
	return roleRouteJson({ ok: true, run: cloneJson(run) });
}

/* ------------------------------------------------------------------------- *
 * Plan sessions
 * ------------------------------------------------------------------------- */

/** Same-origin prefix route the browser polls for a freshly created plan session. */
const PLAN_SESSION_ROUTE = "/plugin-api/role-team/plan-session";

/**
 * Sessions `/role-plan` created and the browser has not opened yet.
 * Registering the identity before the session exists closes the race with the
 * `api-session/added` event the new session publishes.
 */
const planSessions = new Map<string, number>();

/**
 * Remember one plan session for auto-opening, dropping expired entries.
 */
function rememberPlanSession(sessionId: string): void {
	const now = Date.now();
	for (const [id, createdAt] of planSessions) {
		if (now - createdAt > LIMITS.planSessionTtlMs) planSessions.delete(id);
	}
	planSessions.set(sessionId, now);
}

/**
 * One-line title for a plan session, from its task.
 */
function planSessionTitle(task: string): string {
	const text = String(task).replace(/\s+/g, " ").trim();
	const max = LIMITS.planSessionTitleChars;
	return `Role plan: ${text.length <= max ? text : `${text.slice(0, max - 1)}…`}`;
}

/**
 * Build the single deterministic prompt a plan session receives: run the team
 * with the exact task and plan, then remain available for progress questions.
 */
function planSessionPrompt(task: string, plan: string | undefined): string {
	return [
		"The /role-plan command opened this session to orchestrate the role team and stay available to the user.",
		"",
		`Task (pass this text verbatim as the task argument):\n<<<TASK\n${task}\nTASK>>>`,
		...(plan === undefined
			? []
			: [
					"",
					`Plan (pass this text verbatim as the plan argument):\n<<<PLAN\n${plan}\nPLAN>>>`,
				]),
		"",
		"Call the `roles_start` tool exactly once with the task and, when present, the plan copied verbatim. Do not implement anything yourself. Confirm the background launch briefly, then remain available for follow-up questions. When the user asks how things are going (including «чё там», «че там», «как там»), call `roles_status` and report the observed stage, latest child activity and any blockers. Use its question argument to ask the active child for clarification when needed. Never start a duplicate run on a status question. Use `roles_cancel` when the user asks to stop.",
	].join("\n");
}

/**
 * Serve the browser's claim of one freshly created plan session.
 *
 * GET-only (the webserver answers anything else itself), loopback-guarded, and
 * one-shot: the first reader takes the marker, so a replayed request stops
 * opening the session again. Unknown ids answer 404.
 *
 */
export function handlePlanSessionRequest(
	_ctx: HostContext,
	request: Request,
): Response {
	if (!trustedRoleRouteRequest(request))
		return roleRouteJson({ ok: false, error: "forbidden" }, 403);
	let sessionId = "";
	try {
		const url = new URL(request.url);
		const rest = url.pathname.slice(PLAN_SESSION_ROUTE.length);
		sessionId = rest === "" ? "" : decodeURIComponent(rest.replace(/^\//, ""));
	} catch {
		return roleRouteJson({ ok: false, error: "bad request" }, 400);
	}
	if (sessionId === "" || sessionId.includes("/"))
		return roleRouteJson({ ok: false, error: "unknown session" }, 404);
	if (!planSessions.has(sessionId))
		return roleRouteJson({ ok: false, error: "unknown session" }, 404);
	planSessions.delete(sessionId);
	return roleRouteJson({ ok: true, sessionId });
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

/**
 * Install the role team surface.
 */
export function apply(ctx: HostContext, rawConfig: unknown = {}): void {
	const config = resolveRoleTeamConfig(rawConfig);
	const background = createBackgroundRuns<
		Agent,
		Omit<RunOptions, "agent">,
		Partial<RunState>,
		TeamOutcome
	>(ctx, (options) => runRoleTeam(ctx, options), runStateOf);
	backgroundControllers.set(ctx, background);
	ctx.effect(() => () => background.dispose());
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
					handler: (req, res) => handleRolesHttp(ctx, req, res, rawConfig),
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
