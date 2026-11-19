import type {
	IndependenceWarning,
	Role,
	RoleTeamConfig,
	Route,
	TextBlock,
} from "./types.js";

/** The four roles, in pipeline order. */
export const ROLE_NAMES = Object.freeze([
	"plan",
	"worker",
	"advisor",
	"reviewer",
] as const);

/** Human-facing role names used in prompts and reports. */
export const ROLE_LABELS = Object.freeze({
	plan: "PLAN",
	worker: "WORKER",
	advisor: "ADVISOR",
	reviewer: "REVIEWER",
});

/**
 * Recommended cross-family defaults: a strong planner (GPT-6 Luna), a fast
 * implementer (DeepSeek V4.1 Flash), a GLM advisor, and an independent Qwen
 * final reviewer.
 */
export const DEFAULT_ROLES = Object.freeze({
	plan: { provider: "opencode-go", model: "gpt-6-luna" },
	worker: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
	advisor: { provider: "opencode-go", model: "glm-5.3" },
	reviewer: { provider: "opencode-go", model: "qwen3.8-max" },
});

/** Bound every model-facing piece of the report so one round cannot flood the lead. */
export const LIMITS = Object.freeze({
	planChars: 8000,
	workerChars: 5000,
	verdictChars: 3000,
	issueChars: 1200,
	reportChars: 32_000,
	roleOutputChars: 14_000,
	toolTaskChars: 60_000,
	contextChars: 30_000,
	maxRounds: 6,
	maxChildDepth: 8,
	/** Upper bound of the `maxPlanPasses` configuration (audit -> revise cycles before WORKER). */
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
export const ROLES_SETTINGS_ROUTE = "/plugin-api/role-team/roles";
/** Same-origin prefix route serving the live state of one run. */
export const RUN_STATE_ROUTE = "/plugin-api/role-team/run";
/** Same-origin prefix route the browser polls for a freshly created plan session. */
export const PLAN_SESSION_ROUTE = "/plugin-api/role-team/plan-session";

/** Supported agent runtime identifiers for role routes. */
export const EXTERNAL_RUNTIMES = Object.freeze([
	"cursor",
	"droid",
	"antigravity",
] as const);

/** The section that tells the lead what the team is for. */
export const ROLE_GUIDANCE = `Role team (PLAN -> WORKER -> ADVISOR -> REVIEWER) is available. Prefer \`roles_start\` for substantial work: it starts the pipeline in the background so you remain available to the user. PLAN drafts a plan, ADVISOR audits it before WORKER implements, then audits each attempt; REVIEWER is the final gate. Pass the task verbatim and all relevant context: children do not see this conversation. On progress questions such as “чё там”, “че там”, “как там” or “how is it going”, call \`roles_status\` and report the observed stage, child activity and blockers. Its optional question argument asks the active native child for clarification; inbox acceptance is not an answer. Never launch another run for a progress question. Use \`roles_cancel\` to stop. \`roles_run\` waits for the final report when foreground execution is explicitly needed; \`role_*\` tools run single roles. Never start REVIEWER before WORKER reports completion. The user can use \`/roles run <task>\` here or \`/role-plan <task or plan.md>\` to open a dedicated conversational orchestrator session. Role routes are configured with \`/roles\` or Settings → Models. Background results are kept in memory until plugin reload; use runId to select an older run.`;

/** Whether a value is a plain data object. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Truncate text to a character budget with an explicit marker. */
export function clip(
	value: string | number | boolean | null | undefined,
	max: number,
): string {
	const text =
		typeof value === "string" ? value : value == null ? "" : String(value);
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 24))}\n… [truncated ${text.length - max} chars]`;
}

/** Collapse whitespace for a one-line summary. */
export function oneLine(
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

/** Extract the text blocks of a child's final output. */
export function textOf(blocks: readonly unknown[] | undefined): string {
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

/** Render one thrown value without trusting its coercion. */
export function messageOf(error: unknown): string {
	if (error instanceof Error && typeof error.message === "string")
		return error.message;
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

/** Format a duration in coarse units. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Clone plain configuration data without assuming structuredClone exists. */
export function cloneJson<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Clamp a positive integer configuration value. */
export function clampInt(
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

/** Whether a string names one of the four roles. */
export function isRole(value: string): value is Role {
	return ROLE_NAMES.some((role) => role === value);
}

/** Split an optional `:effort` suffix from a model string. */
function splitEffortSuffix(rawModel: string): {
	model: string;
	reasoningEffort?: string;
} {
	const colon = rawModel.lastIndexOf(":");
	if (colon > 0 && colon < rawModel.length - 1) {
		const candidate = rawModel.slice(colon + 1);
		if (/^[a-z][a-z0-9_-]*$/.test(candidate)) {
			return {
				model: rawModel.slice(0, colon).trim(),
				reasoningEffort: candidate,
			};
		}
	}
	return { model: rawModel.trim() };
}

/**
 * Parse one configured role route.
 *
 * Accepted forms are `{ provider, model, runtime?, reasoningEffort? }`, the
 * compact strings `provider/model[:effort]` and `runtime:model[:effort]`,
 * and `null`/`"inherit"` to follow the session model.
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
		const runtimeMatch = /^(native|cursor|droid|antigravity):(.+)$/i.exec(text);
		if (runtimeMatch) {
			const runtime = runtimeMatch[1]!.toLowerCase();
			const body = runtimeMatch[2]!.trim();
			if (body.includes("/")) {
				const inner = normalizeRoute(body);
				if (inner.error === undefined && inner.route !== null)
					return { route: { ...inner.route, runtime } };
				return { error: inner.error ?? "a runtime route needs a model" };
			}
			if (runtime !== "native") {
				const { model, reasoningEffort } = splitEffortSuffix(body);
				if (model !== "") {
					return {
						route: {
							provider: runtime,
							model,
							runtime,
							...(reasoningEffort === undefined ? {} : { reasoningEffort }),
						},
					};
				}
			}
			return { error: "a runtime route needs a model" };
		}
		const slash = text.indexOf("/");
		if (slash <= 0 || slash === text.length - 1) {
			return { error: `"${text}" is not a <provider>/<model> route` };
		}
		const provider = text.slice(0, slash).trim();
		const { model, reasoningEffort } = splitEffortSuffix(text.slice(slash + 1));
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
				!["native", "cursor", "droid", "antigravity"].includes(
					runtime,
				))
		) {
			return { error: "runtime must be native, cursor, droid, or antigravity" };
		}
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

/** Serialize one route into a minimal plain JSON-safe object. */
export function serializeRoute(route: Route): Route {
	return {
		provider: route.provider,
		model: route.model,
		...(route.runtime === undefined ? {} : { runtime: route.runtime }),
		...(route.reasoningEffort === undefined
			? {}
			: { reasoningEffort: route.reasoningEffort }),
	};
}

/** Format a route for display. */
export function formatRoute(route: Route | null | undefined): string {
	if (route === null || route === undefined) return "inherit session model";
	return `${route.runtime && route.runtime !== "native" ? `${route.runtime}:` : ""}${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : ` @${route.reasoningEffort}`}`;
}

/** Format one role's ordered fallback chain for display. */
export function formatFallbackChain(routes: readonly Route[]): string {
	return routes.length === 0
		? "none"
		: routes.map((route) => formatRoute(route)).join(" -> ");
}

/** Deduplicate an ordered list of candidate routes while preserving precedence. */
export function deduplicateRoutes(
	candidates: readonly (Route | null)[],
): (Route | null)[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		if (candidate === null) {
			if (seen.has("inherit")) return false;
			seen.add("inherit");
			return true;
		}
		const key = `${candidate.runtime ?? ""}|${candidate.provider}|${candidate.model}|${candidate.reasoningEffort ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Best-effort model family, used only for independence warnings. */
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
 * `"inherit"` makes that role follow the caller's session model.
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
	const fallbacksInput = isPlainObject(input.fallbacks) ? input.fallbacks : {};
	const fallbacks = {} as Record<Role, Route[]>;
	for (const role of ROLE_NAMES) {
		const value = fallbacksInput[role];
		const entries = Array.isArray(value)
			? value
			: value === undefined
				? []
				: [value];
		const routes: Route[] = [];
		for (const entry of entries) {
			const parsed = normalizeRoute(entry);
			if (parsed.error !== undefined)
				problems.push({ role, message: `fallback: ${parsed.error}` });
			else if (parsed.route !== null) routes.push(parsed.route);
		}
		fallbacks[role] = routes;
	}
	return {
		roles,
		fallbacks,
		sources,
		problems,
		maxRounds: clampInt(input.maxRounds, 1, LIMITS.maxRounds, 3),
		maxPlanPasses: clampInt(input.maxPlanPasses, 1, LIMITS.maxPlanPasses, 2),
		childMaxDepth: clampInt(input.childMaxDepth, 0, LIMITS.maxChildDepth, 2),
		prompts,
	};
}

/** Apply an optional per-call `max_rounds` override to a resolved config. */
export function effectiveConfigWithRounds(
	config: RoleTeamConfig,
	args: unknown,
): RoleTeamConfig {
	const rounds = isPlainObject(args) ? args.max_rounds : undefined;
	if (rounds === undefined) return config;
	return {
		...config,
		maxRounds: clampInt(rounds, 1, LIMITS.maxRounds, config.maxRounds),
	};
}

/** Structured family-independence warnings for server and browser consumption. */
export function structuredFamilyWarnings(
	roles: Record<Role, Route | null>,
): IndependenceWarning[] {
	const warnings: IndependenceWarning[] = [];
	const worker = familyOf(roles.worker ?? null);
	const advisor = familyOf(roles.advisor ?? null);
	const reviewer = familyOf(roles.reviewer ?? null);
	if (worker !== null && advisor !== null && worker === advisor) {
		warnings.push({
			kind: "worker_advisor",
			family: worker,
			message: `WORKER and ADVISOR both use the ${worker} family; the advisor's independence is weaker. Choose a different family for one of them.`,
		});
	}
	if (worker !== null && reviewer !== null && worker === reviewer) {
		warnings.push({
			kind: "worker_reviewer",
			family: worker,
			message: `WORKER and REVIEWER both use the ${worker} family; the final gate is not independent.`,
		});
	}
	if (advisor !== null && reviewer !== null && advisor === reviewer) {
		warnings.push({
			kind: "advisor_reviewer",
			family: advisor,
			message: `ADVISOR and REVIEWER both use the ${advisor} family; the final gate is not independent from the advisor.`,
		});
	}
	if (worker === null || advisor === null || reviewer === null) {
		warnings.push({
			kind: "inherit",
			message:
				"At least one of WORKER, ADVISOR or REVIEWER inherits the session model, so cross-family independence is not guaranteed.",
		});
	}
	return warnings;
}

/** Family-independence warnings as display strings. */
export function familyWarnings(roles: Record<Role, Route | null>): string[] {
	return structuredFamilyWarnings(roles).map((item) => item.message);
}

/** Build the client-safe role snapshot served to the settings page. */
export function roleTeamSnapshot(
	rawConfig: unknown,
	validationErrors?: Partial<Record<Role, string>>,
) {
	const config = resolveRoleTeamConfig(rawConfig);
	const roles = {} as Record<
		Role,
		{
			route: Route | null;
			fallbacks: Route[];
			source: RoleTeamConfig["sources"][Role];
			family: string | null;
			problem?: string;
			validationError?: string;
		}
	>;
	for (const role of ROLE_NAMES) {
		const route = config.roles[role] ?? null;
		const problem = config.problems.find(
			(candidate) => candidate.role === role,
		);
		const validationError = validationErrors?.[role];
		roles[role] = {
			route: route === null ? null : { ...route },
			fallbacks: config.fallbacks[role].map((item) => ({ ...item })),
			source: config.sources[role],
			family: familyOf(route),
			...(problem === undefined ? {} : { problem: problem.message }),
			...(validationError === undefined ? {} : { validationError }),
		};
	}
	const warningItems = structuredFamilyWarnings(config.roles);
	return {
		ok: true,
		roles,
		warnings: warningItems.map((item) => item.message),
		warningItems,
		maxRounds: config.maxRounds,
		maxPlanPasses: config.maxPlanPasses,
		childMaxDepth: config.childMaxDepth,
	};
}
