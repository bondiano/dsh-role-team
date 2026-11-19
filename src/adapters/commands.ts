import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
	saveRoleFallbacks,
	saveRoleRoute,
	saveTeamSettings,
} from "../application/config-persistence.js";
import {
	type BackgroundRuns,
	forgetPlanSession,
	rememberPlanSession,
	stateFor,
} from "../application/state.js";
import {
	clip,
	EXTERNAL_RUNTIMES,
	familyOf,
	familyWarnings,
	formatFallbackChain,
	formatRoute,
	isRole,
	LIMITS,
	messageOf,
	normalizeRoute,
	oneLine,
	ROLE_NAMES,
} from "../domain/config.js";
import type {
	CommandInvocation,
	CommandResult,
	HostContext,
	RoleTeamConfig,
	Route,
} from "../domain/types.js";
import { validateRoute } from "../infrastructure/route-validation.js";

export { saveRoleFallbacks, saveRoleRoute, saveTeamSettings };

/** Render the current role table. */
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
		const fallbacks = config.fallbacks[role] ?? [];
		lines.push(`  ${role.padEnd(8)} ${label}${suffix}`);
		if (fallbacks.length > 0)
			lines.push(`           fallbacks: ${formatFallbackChain(fallbacks)}`);
	}
	lines.push(
		`Settings: maxRounds=${config.maxRounds} · maxPlanPasses=${config.maxPlanPasses} · childMaxDepth=${config.childMaxDepth}`,
	);
	const warnings = familyWarnings(config.roles);
	if (warnings.length > 0) {
		lines.push("");
		for (const warning of warnings) lines.push(`Warning: ${warning}`);
	}
	lines.push("");
	lines.push(
		"Commands: /roles set <role> <provider>/<model>[:effort] · /roles fallback <role> [<provider>/<model> ... | clear] · /roles inherit <role> · /roles reset <role> · /roles config [key] [value] · /roles models [provider] · /roles doctor · /roles run <task> · /roles status [run-id] · /roles list · /roles cancel [run-id] · /role-plan <task or plan.md>",
	);
	return lines.join("\n");
}

/** Validate every configured route in parallel and report independence warnings. */
export async function doctorReport(
	ctx: HostContext,
	config: RoleTeamConfig,
	signal?: AbortSignal,
): Promise<string> {
	const lines = ["Role team doctor:"];
	const checks = await Promise.all(
		ROLE_NAMES.map(async (role) => {
			const out: string[] = [];
			const route = config.roles[role];
			if (route === null) {
				out.push(`  ${role.padEnd(8)} inherit session model`);
			} else {
				try {
					await validateRoute(ctx, role, route, signal);
					out.push(
						`  ${role.padEnd(8)} ok — ${formatRoute(route)} (${familyOf(route) ?? "unknown"} family; credentials are verified on the first run)`,
					);
				} catch (error) {
					out.push(
						`  ${role.padEnd(8)} FAILED — ${formatRoute(route)}: ${messageOf(error)}`,
					);
				}
			}
			const fallbacks = config.fallbacks[role] ?? [];
			for (let index = 0; index < fallbacks.length; index += 1) {
				const fallback = fallbacks[index]!;
				try {
					await validateRoute(ctx, role, fallback, signal);
					out.push(
						`  ${role.padEnd(8)} fallback ${index + 1} ok — ${formatRoute(fallback)}`,
					);
				} catch (error) {
					out.push(
						`  ${role.padEnd(8)} fallback ${index + 1} FAILED — ${formatRoute(fallback)}: ${messageOf(error)}`,
					);
				}
			}
			return out;
		}),
	);
	lines.push(...checks.flat());
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

/** List registered providers, agent runtimes and their advertised models. */
async function modelsReport(
	ctx: HostContext,
	providerArg: string | undefined,
): Promise<string> {
	const runtime = ctx.get("agentRuntime");
	const runtimeIds: readonly string[] = EXTERNAL_RUNTIMES;
	if (providerArg !== undefined && runtimeIds.includes(providerArg)) {
		if (typeof runtime?.catalog !== "function")
			throw new Error(
				`runtime "${providerArg}" is unavailable or exposes no model catalog`,
			);
		let models;
		try {
			models = (await runtime.catalog(providerArg)).models;
		} catch (error) {
			throw new Error(
				`runtime "${providerArg}" could not list models: ${messageOf(error)}`,
			);
		}
		const lines = [`Models for ${providerArg} runtime:`];
		for (const model of models)
			lines.push(
				`  ${model.id}${model.name === undefined || model.name === model.id ? "" : ` — ${model.name}`}`,
			);
		if (models.length === 0) lines.push("  (the runtime advertises no models)");
		lines.push(
			"",
			`Use them as a route: /roles set <role> ${providerArg}:${models[0]?.id ?? "<model-id>"}`,
		);
		return clip(lines.join("\n"), LIMITS.reportChars);
	}
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
	const counts = await Promise.all(
		providers.map(async (provider) => {
			try {
				const models = await llm.listModels(provider.id);
				return String(models.length);
			} catch {
				return "unavailable";
			}
		}),
	);
	for (let idx = 0; idx < providers.length; idx += 1) {
		const provider = providers[idx]!;
		lines.push(
			`  ${provider.id} — ${provider.name ?? provider.id} (${counts[idx]} models)`,
		);
	}
	if (providers.length === 0) lines.push("  (none)");
	if (typeof runtime?.catalog === "function") {
		lines.push("", "Agent runtimes:");
		for (const id of runtimeIds) {
			try {
				const models = (await runtime.catalog(id)).models;
				lines.push(
					`  ${id} — ${models.length} models (use /roles models ${id})`,
				);
			} catch (error) {
				lines.push(`  ${id} — unavailable: ${messageOf(error)}`);
			}
		}
	}
	lines.push("");
	lines.push(
		"Use /roles models <provider|runtime> to list model ids; runtime routes use cursor:<model>, droid:<model> or antigravity:<model>.",
	);
	return lines.join("\n");
}

function parseRoleName(token: string | undefined, usage: string) {
	if (token === undefined) throw new Error(usage);
	const role = token.toLowerCase();
	if (!isRole(role))
		throw new Error(
			`unknown role "${token}"; choose one of ${ROLE_NAMES.join(", ")}`,
		);
	return role;
}

/** Execute one `/roles` command line. */
async function handleRolesCommand(
	ctx: HostContext,
	initialConfig: RoleTeamConfig,
	invocation: CommandInvocation,
	background: BackgroundRuns,
): Promise<CommandResult> {
	const config = stateFor(ctx)?.config ?? initialConfig;
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
			const role = parseRoleName(
				roleToken,
				"usage: /roles set <plan|worker|advisor|reviewer> <provider>/<model>[:effort]",
			);
			const routeInput = routeTokens.join(" ");
			if (routeInput.toLowerCase() === "inherit") {
				await saveRoleRoute(ctx, role, null, "inherit");
				return {
					kind: "success",
					text: `Role ${role} now inherits the session model. Applied and saved to the profile patch.`,
				};
			}
			const parsed = normalizeRoute(routeInput);
			if (parsed.error !== undefined || parsed.route === null) {
				throw new Error(
					parsed.error ??
						"a concrete provider/model route is required; use /roles inherit or /roles reset",
				);
			}
			await validateRoute(ctx, role, parsed.route, invocation.signal);
			await saveRoleRoute(ctx, role, parsed.route, "set");
			return {
				kind: "success",
				text: `Role ${role} now uses ${formatRoute(parsed.route)}. The route resolves; credentials are verified by the first role run. Applied and saved to the profile patch.`,
			};
		}
		if (verb === "fallback") {
			const [roleToken, ...routeTokens] = rest.split(/\s+/).filter(Boolean);
			const role = parseRoleName(
				roleToken,
				"usage: /roles fallback <plan|worker|advisor|reviewer> <provider>/<model>[:effort] [more...] | clear",
			);
			if (routeTokens.length === 0) {
				return {
					kind: "success",
					text: `Role ${role} fallbacks: ${formatFallbackChain(config.fallbacks[role] ?? [])}. Usage: /roles fallback ${role} <provider>/<model>[:effort] [more...] | clear`,
				};
			}
			if (
				routeTokens.length === 1 &&
				routeTokens[0]!.toLowerCase() === "clear"
			) {
				await saveRoleFallbacks(ctx, role, []);
				return {
					kind: "success",
					text: `Role ${role} has no fallback routes. Applied and saved to the profile patch.`,
				};
			}
			const routes: Route[] = [];
			for (const token of routeTokens) {
				const parsed = normalizeRoute(token);
				if (parsed.error !== undefined || parsed.route === null)
					throw new Error(parsed.error ?? `"${token}" is not a route`);
				routes.push(parsed.route);
			}
			for (const route of routes)
				await validateRoute(ctx, role, route, invocation.signal);
			await saveRoleFallbacks(ctx, role, routes);
			return {
				kind: "success",
				text: `Role ${role} fallbacks: ${formatFallbackChain(routes)}. Every route resolves; credentials are verified on use. Applied and saved to the profile patch.`,
			};
		}
		if (verb === "inherit") {
			const role = parseRoleName(rest, "usage: /roles inherit <role>");
			await saveRoleRoute(ctx, role, null, "inherit");
			return {
				kind: "success",
				text: `Role ${role} now inherits the caller's session model. Applied and saved to the profile patch.`,
			};
		}
		if (verb === "reset") {
			const role = parseRoleName(rest, "usage: /roles reset <role>");
			await saveRoleRoute(ctx, role, null, "reset");
			return {
				kind: "success",
				text: `Role ${role} reset to the recommended default (or the inherited session model when no default is configured).`,
			};
		}
		if (verb === "config") {
			if (rest === "") {
				return {
					kind: "success",
					text: `Role team settings: maxRounds=${config.maxRounds} (1-${LIMITS.maxRounds}) · maxPlanPasses=${config.maxPlanPasses} (1-${LIMITS.maxPlanPasses}) · childMaxDepth=${config.childMaxDepth} (0-${LIMITS.maxChildDepth})`,
				};
			}
			const [keyToken, valueToken] = rest.split(/\s+/).filter(Boolean);
			const keyMap: Record<
				string,
				"maxRounds" | "maxPlanPasses" | "childMaxDepth"
			> = {
				maxrounds: "maxRounds",
				max_rounds: "maxRounds",
				maxplanpasses: "maxPlanPasses",
				max_plan_passes: "maxPlanPasses",
				childmaxdepth: "childMaxDepth",
				child_max_depth: "childMaxDepth",
			};
			const canonicalKey = keyToken
				? keyMap[keyToken.toLowerCase()]
				: undefined;
			if (!canonicalKey || valueToken === undefined) {
				throw new Error(
					"usage: /roles config <maxRounds|maxPlanPasses|childMaxDepth> <integer>",
				);
			}
			const numeric = Number(valueToken);
			if (!Number.isInteger(numeric)) {
				throw new Error(`"${valueToken}" must be an integer`);
			}
			await saveTeamSettings(ctx, { [canonicalKey]: numeric });
			const updated = stateFor(ctx).config;
			return {
				kind: "success",
				text: `Updated ${canonicalKey}=${updated[canonicalKey]}. Applied and saved to the profile patch.`,
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
		if (verb === "list") {
			const runs = background.list(invocation.agent, 10);
			if (runs.length === 0) {
				return {
					kind: "success",
					text: "No role-team runs in this session.",
				};
			}
			const lines = ["Recent role-team runs in this session:"];
			for (const item of runs) {
				lines.push(
					`  ${item.runId} · ${item.status.toUpperCase()} · ${item.task}`,
				);
			}
			return { kind: "success", text: lines.join("\n") };
		}
		if (verb === "status") {
			const status = await background.status(
				invocation.agent,
				rest || undefined,
			);
			const recent = background.list(invocation.agent, 5);
			const history =
				recent.length > 1
					? `\nRecent runs: ${recent.map((item) => `${item.runId} (${item.status})`).join(" · ")}`
					: "";
			return {
				kind: "success",
				text: `${status.text}${history}`,
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
				tool: "roles_start",
			});
			return {
				kind: "success",
				text: `${run.text}\nUse /roles status for progress or /roles cancel to stop.`,
			};
		}
		throw new Error(
			`unknown /roles subcommand "${verb}"; use set, fallback, inherit, reset, config, models, doctor, run, status, list or cancel`,
		);
	} catch (error) {
		return { kind: "error", text: messageOf(error) };
	}
}

/** Shared command registration helper. */
function registerCommand(
	ctx: HostContext,
	definition: {
		name: string;
		description: string;
		input: { hint: string };
		handler(invocation: CommandInvocation): Promise<CommandResult>;
	},
): void {
	const commands = ctx.get("commands");
	if (
		commands === undefined ||
		commands === null ||
		typeof commands.register !== "function"
	)
		return;
	ctx.effect(() => commands.register(definition));
}

/** Register the `/roles` command when the commands service is available. */
export function registerRolesCommand(
	ctx: HostContext,
	config: RoleTeamConfig,
	background: BackgroundRuns,
): void {
	registerCommand(ctx, {
		name: "roles",
		description:
			"Show or change the role team models, check role routes, or run the full role team.",
		input: {
			hint: "[set <role> <provider>/<model>[:effort] | fallback <role> [<route> ... | clear] | inherit <role> | reset <role> | config [key] [value] | models [provider|runtime] | doctor | run <task> | status [run-id] | list | cancel [run-id]]",
		},
		handler: (invocation) =>
			handleRolesCommand(ctx, config, invocation, background),
	});
}

/**
 * Parse the `/role-plan` raw input into an optional plan file path and task.
 */
async function resolveRolePlanInput(
	raw: string,
	baseDir: string | undefined,
): Promise<{ planFile?: string; customTask?: string }> {
	const resolveCandidate = (candidate: string) =>
		isAbsolute(candidate)
			? candidate
			: resolvePath(baseDir ?? process.cwd(), candidate);
	const fileExists = async (candidate: string): Promise<boolean> => {
		try {
			const info = await stat(resolveCandidate(candidate));
			return info.isFile();
		} catch {
			return false;
		}
	};

	const flagMatch =
		/^(?:--plan|-p)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/i.exec(
			raw,
		);
	if (flagMatch) {
		const planFile = flagMatch[1] ?? flagMatch[2] ?? flagMatch[3]!;
		const rest = flagMatch[4]?.trim();
		return {
			planFile,
			...(rest ? { customTask: rest } : {}),
		};
	}

	const quotedMatch =
		/^(?:"([^"]+\.md)"|'([^']+\.md)')(?:\s+([\s\S]*))?$/i.exec(raw);
	if (quotedMatch) {
		const planFile = quotedMatch[1] ?? quotedMatch[2]!;
		const rest = quotedMatch[3]?.trim();
		return {
			planFile,
			...(rest ? { customTask: rest } : {}),
		};
	}

	if (!/\s/.test(raw) && /\.md$/i.test(raw)) {
		return { planFile: raw };
	}

	const firstSpace = raw.search(/\s/);
	if (firstSpace > 0) {
		const firstToken = raw.slice(0, firstSpace);
		const rest = raw.slice(firstSpace + 1).trim();
		if (/\.md$/i.test(firstToken) && (await fileExists(firstToken))) {
			return {
				planFile: firstToken,
				...(rest ? { customTask: rest } : {}),
			};
		}
		if (/\.md$/i.test(raw) && (await fileExists(raw))) {
			return { planFile: raw };
		}
	}

	return {};
}

function planSessionTitle(task: string): string {
	const text = String(task).replace(/\s+/g, " ").trim();
	const max = LIMITS.planSessionTitleChars;
	return `Role plan: ${text.length <= max ? text : `${text.slice(0, max - 1)}…`}`;
}

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
 * Execute one `/role-plan` command line: a task, or a Markdown plan file.
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
	const session = invocation.agent?.session;
	let base: string | undefined;
	try {
		base = ctx.get("workingDirectory")?.get?.(session);
	} catch {
		base = undefined;
	}
	const parsedInput = await resolveRolePlanInput(raw, base);
	let plan;
	let task = raw;
	if (parsedInput.planFile !== undefined) {
		const rawPath = parsedInput.planFile;
		const path = isAbsolute(rawPath)
			? rawPath
			: resolvePath(base ?? process.cwd(), rawPath);
		let content;
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			return {
				kind: "error",
				text: `could not read the plan file "${rawPath}": ${messageOf(error)}; give an absolute path or a path relative to the session workspace`,
			};
		}
		if (content.trim() === "")
			return { kind: "error", text: `the plan file "${rawPath}" is empty` };
		if (content.length > LIMITS.planFileMaxChars) {
			return {
				kind: "error",
				text: `the plan file "${rawPath}" is larger than ${LIMITS.planFileMaxChars} characters; split it or pass the essential part as text`,
			};
		}
		plan = clip(content, LIMITS.planChars);
		task = parsedInput.customTask ?? `Execute the plan in ${rawPath} exactly.`;
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
	const cwd = base ?? "";
	const sessionId = `session-${randomUUID()}`;
	rememberPlanSession(ctx, sessionId);
	try {
		await controller.create({
			sessionId,
			...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}),
		});
	} catch (error) {
		forgetPlanSession(ctx, sessionId);
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

/** Register the `/role-plan` command when the commands service is available. */
export function registerRolePlanCommand(
	ctx: HostContext,
	config: RoleTeamConfig,
): void {
	registerCommand(ctx, {
		name: "role-plan",
		description:
			"Run the full role team on a task or a plan file in a new session: the ADVISOR audits the plan, WORKER implements it, ADVISOR checks every attempt, and REVIEWER gives the final verdict.",
		input: { hint: "<task or plan.md>" },
		handler: (invocation) => handleRolePlanCommand(ctx, config, invocation),
	});
}
