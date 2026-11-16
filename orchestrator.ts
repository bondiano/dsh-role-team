import {
	clip,
	familyOf,
	formatDuration,
	formatRoute,
	LIMITS,
	messageOf,
	normalizeRoute,
	oneLine,
	ROLE_LABELS,
	ROLE_NAMES,
	textOf,
	validateRoute,
	validateRoutesParallel,
} from "./config.js";
import {
	buildAdvisorPrompt,
	buildPlanAuditPrompt,
	buildPlanPrompt,
	buildPlanRevisionPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
} from "./prompts.js";
import { runRuntimeRole } from "./runtime-role.js";
import {
	beginRunStage,
	beginRunState,
	endRunStage,
	endRunState,
	markWorkerDone,
	roleChildName,
	runStateOf,
	stateFor,
	updateRunState,
} from "./state.js";
import type {
	Agent,
	Answers,
	ChildTarget,
	Comment,
	Decision,
	HostContext,
	Model,
	Question,
	Role,
	RoleResult,
	RoleTeamConfig,
	Round,
	Route,
	RunOptions,
	Stage,
	TeamOutcome,
	ToolValue,
	Verdict,
} from "./types.js";
import { feedbackLines, parseVerdict, parseWorkerStatus } from "./verdict.js";

export interface RoleRunOptions {
	role: Role;
	prompt: string;
	parent: Agent;
	signal?: AbortSignal;
	cwd?: string;
	callId?: string;
	onChild?: (child: ChildTarget | undefined) => void;
}

export interface TrackedRoleOptions extends Omit<RoleRunOptions, "parent"> {
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

/**
 * Start one role child, await its settlement, and release it.
 */
export async function runRole(
	ctx: HostContext,
	config: RoleTeamConfig,
	{ role, prompt, parent, signal, cwd, callId, onChild }: RoleRunOptions,
): Promise<RoleResult> {
	const update = (patch: Parameters<typeof updateRunState>[2]) => {
		updateRunState(ctx, callId, patch);
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
	const name = roleChildName(ctx, role);
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

/** Run one role for a single-role tool while tracking it in the live run state. */
export async function runTrackedRole(
	ctx: HostContext,
	config: RoleTeamConfig,
	{ tool, task, role, prompt, agent, signal, cwd, callId }: TrackedRoleOptions,
): Promise<RoleResult> {
	beginRunState(ctx, callId, tool, oneLine(task, 300));
	beginRunStage(ctx, callId, role, config.roles[role] ?? null);
	try {
		const result = await runRole(ctx, config, {
			role,
			prompt,
			parent: agent,
			signal,
			cwd,
			callId,
		});
		endRunStage(ctx, callId, role, result.status, result.durationMs);
		return result;
	} catch (error) {
		endRunStage(ctx, callId, role, "failed", 0);
		throw error;
	} finally {
		endRunState(ctx, callId);
	}
}

/** Format one role result for a single-role tool. */
export function formatRoleResult(result: RoleResult): string {
	const header = `Role ${ROLE_LABELS[result.role]} (${formatRoute(result.route)}) finished: ${result.status} in ${formatDuration(result.durationMs)}.`;
	const body = result.text === "" ? "(the role returned no text)" : result.text;
	const diagnostic =
		result.diagnostic === undefined
			? ""
			: `\n\nDiagnostic: ${result.diagnostic}`;
	return clip(`${header}\n\n${body}${diagnostic}`, LIMITS.roleOutputChars);
}

/** Build the structured canonical value of one single-role tool. */
export function structuredRoleResult(
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

/** Ask the user one question through the user-questions service. */
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

/** Read the selected label of one answered question. */
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

/** Ask the user how to proceed when the rounds are exhausted without approval. */
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
 * Lists models across all providers in parallel and interleaves them fairly so
 * a single large provider cannot starve the remaining providers.
 */
async function askWorkerModelRoute(
	ctx: HostContext,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	config?: RoleTeamConfig,
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
	let providers: Model[] = [];
	try {
		providers = llm.listProviders();
	} catch {
		return undefined;
	}
	const settled = await Promise.allSettled(
		providers.map(async (provider) => {
			const models = await llm.listModels(provider.id);
			return {
				provider,
				models: Array.isArray(models) ? models : [],
			};
		}),
	);
	const buckets = settled
		.filter(
			(
				item,
			): item is PromiseFulfilledResult<{ provider: Model; models: Model[] }> =>
				item.status === "fulfilled" && item.value.models.length > 0,
		)
		.map((item) => item.value);
	if (buckets.length === 0) return undefined;

	const avoidFamilies = new Set<string>();
	if (config) {
		for (const role of ["advisor", "reviewer"] as const) {
			const fam = familyOf(config.roles[role]);
			if (fam) avoidFamilies.add(fam);
		}
	}

	// Interleave models across providers so every provider gets representation
	// within the 40-option cap.
	const candidates: {
		label: string;
		description: string;
		independent: boolean;
	}[] = [];
	const maxLen = Math.max(...buckets.map((b) => b.models.length));
	for (let idx = 0; idx < maxLen && candidates.length < 40; idx += 1) {
		for (const bucket of buckets) {
			if (candidates.length >= 40) break;
			const model = bucket.models[idx];
			if (!model) continue;
			const route = { provider: bucket.provider.id, model: model.id };
			const fam = familyOf(route);
			const providerLabel = bucket.provider.name ?? bucket.provider.id;
			const modelLabel = model.name ?? model.id;
			candidates.push({
				label: `${bucket.provider.id}/${model.id}`,
				description:
					providerLabel && modelLabel !== `${providerLabel} ${model.id}`
						? `${modelLabel} (${providerLabel})`
						: modelLabel,
				independent: fam === null || !avoidFamilies.has(fam),
			});
		}
	}
	// Put models from families independent of ADVISOR/REVIEWER first, preserving relative order.
	candidates.sort((a, b) => Number(b.independent) - Number(a.independent));
	const options = candidates.map(({ label, description }) => ({
		label,
		description,
	}));
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
		if (round.advisor !== undefined) {
			lines.push(
				`ADVISOR (${formatRoute(round.advisor.route)}, ${round.advisor.status}, ${formatDuration(round.advisor.durationMs)}) — ${round.advisorVerdict.approved ? "APPROVED" : "CHANGES REQUIRED"}`,
			);
			if (round.advisor.diagnostic !== undefined)
				lines.push(`Diagnostic: ${clip(round.advisor.diagnostic, 1500)}`);
		} else {
			lines.push("ADVISOR — skipped because WORKER reported STATUS: blocked");
		}
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

/**
 * Run the full PLAN -> plan audit -> WORKER -> ADVISOR -> REVIEWER loop.
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
		tool = "roles_run",
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
	await validateRoutesParallel(ctx, usedRoles, config, signal);
	// A local copy of the routes: a worker model chosen through the exhaustion
	// question changes later attempts without mutating the plugin's config.
	const runConfig = { ...config, roles: { ...config.roles } };
	const startedAt = Date.now();
	const stages: Stage[] = [];
	const comments: Comment[] = [];
	const decisions: Decision[] = [];
	const planAudits: TeamOutcome["planAudits"] = [];
	const liveState = beginRunState(ctx, callId, tool, oneLine(taskText, 300));
	if (liveState) {
		liveState.comments = comments;
		liveState.decisions = decisions;
	}
	const stage = async (role: Role, prompt: string) => {
		beginRunStage(ctx, callId, role, runConfig.roles[role] ?? null);
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
			endRunStage(ctx, callId, role, result.status, result.durationMs);
			return result;
		} catch (error) {
			endRunStage(ctx, callId, role, "failed", 0);
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
		const runStates = stateFor(ctx).runStates;
		for (;;) {
			if (signal !== undefined && signal.aborted)
				throw new Error("role team was cancelled");
			if (number >= attemptLimit) {
				const waiting =
					callId === undefined ? undefined : runStates.get(callId);
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
					const route = await askWorkerModelRoute(
						ctx,
						agent,
						signal,
						runConfig,
					);
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

			const workerStatus = parseWorkerStatus(worker.text);
			if (workerStatus.blocked) {
				const blockedIssue = {
					severity: "blocker",
					detail: workerStatus.detail,
				};
				const blockedVerdict: Verdict = {
					approved: false,
					summary: "WORKER reported STATUS: blocked",
					issues: [blockedIssue],
					parsed: true,
				};
				rounds.push({
					number,
					worker,
					advisorVerdict: blockedVerdict,
				});
				comments.push({
					role: "advisor",
					stage: `round ${number} attempt (worker blocked)`,
					route: worker.route,
					approved: false,
					summary: blockedVerdict.summary,
					issues: blockedVerdict.issues,
				});
				feedback = feedbackLines(blockedVerdict.issues);
				continue;
			}

			if (worker.status === "completed") markWorkerDone(ctx, agent);

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
		onState?.({ ...runStateOf(callId, ctx), comments, decisions });
		endRunState(ctx, callId);
	}
}
