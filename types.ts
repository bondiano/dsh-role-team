import type { IncomingMessage, ServerResponse } from "node:http";

export type Role = "plan" | "worker" | "advisor" | "reviewer";
export interface Route {
	provider: string;
	model: string;
	runtime?: string;
	reasoningEffort?: string;
}
export interface Agent {
	session: { id: string };
}
export type Disposer = () => unknown;
export type WarningKind =
	| "worker_advisor"
	| "worker_reviewer"
	| "advisor_reviewer"
	| "inherit";
export interface IndependenceWarning {
	kind: WarningKind;
	family?: string;
	message: string;
}
export interface RoleTeamConfig {
	roles: Record<Role, Route | null>;
	/** Ordered fallback routes tried when a role's primary route is unavailable or fails. */
	fallbacks: Record<Role, Route[]>;
	sources: Record<Role, "config" | "default" | "inherit">;
	problems: { role: Role; message: string }[];
	maxRounds: number;
	maxPlanPasses: number;
	childMaxDepth: number;
	prompts: Partial<Record<Role, string>>;
}
export interface Issue {
	severity: string;
	detail: string;
}
export interface Verdict {
	approved: boolean;
	summary: string;
	issues: Issue[];
	parsed: boolean;
}
export interface RoleResult {
	role: Role;
	route: Route | null;
	childName: string;
	status: string;
	text: string;
	diagnostic?: string;
	/** True when a configured fallback route produced this result. */
	fallback?: boolean;
	/** Routes that failed before the one that produced this result. */
	attempts?: { route: Route; error: string }[];
	durationMs: number;
	cwd?: string;
	runtimeSessionId?: string;
	artifacts?: string[];
}
export interface Stage {
	role: Role;
	route: Route | null;
	status: string;
	startedAt?: number;
	roleStatus?: string;
	durationMs?: number;
}
export interface Comment extends Omit<Verdict, "parsed"> {
	role: "advisor" | "reviewer";
	stage: string;
	route: Route | null;
}
export interface Decision {
	choice: "continue" | "retry" | "model" | "stop" | "none";
	route?: Route;
	note?: string;
}
export interface Round {
	number: number;
	worker: RoleResult;
	advisor?: RoleResult;
	advisorVerdict: Verdict;
	reviewer?: RoleResult;
	reviewerVerdict?: Verdict;
}
export interface TeamOutcome {
	status: "approved" | "unapproved" | "continued";
	report: string;
	plan: string;
	rounds: Round[];
	planAudits: {
		pass: number;
		route: Route | null;
		durationMs: number;
		verdict: Verdict;
	}[];
	stages: Stage[];
	comments: Comment[];
	decisions: Decision[];
}
export interface RunState {
	tool: string;
	task: string;
	startedAt: number;
	stages: Stage[];
	currentRole: Role | null;
	child?: { id: string; name?: string; runtime?: string };
	progress?: string;
	phase?: string;
	updatedAt?: number;
	comments?: Comment[];
	decisions?: Decision[];
}
export interface ChildTarget {
	id: string;
	signal: AbortSignal;
}
export interface RunOptions {
	agent: Agent;
	task: string;
	context?: string;
	plan?: string;
	signal?: AbortSignal;
	config: RoleTeamConfig;
	callId?: string;
	tool?: string;
	onState?: (state: Partial<RunState>) => void;
	onChild?: (child: ChildTarget | undefined) => void;
}
export interface PromptInputs {
	task: string;
	context?: string;
	cwd?: string;
	extra?: string;
}
export interface PlanPromptInputs extends PromptInputs {
	plan: string;
}
export interface WorkerPromptInputs extends PlanPromptInputs {
	round: number;
	feedback: string[];
	previous?: string;
}
export interface AdvisorPromptInputs extends PlanPromptInputs {
	workerReport: string;
	round: number;
	feedback?: string[];
}
export interface ReviewerPromptInputs extends PlanPromptInputs {
	workerReport: string;
	advisorVerdict: string;
}
export interface TextBlock {
	type: "text";
	text: string;
}
export interface ActivationRequest {
	provider: string;
	label: string;
	name: string;
	parent: Agent;
	signal?: AbortSignal;
	delivery: string;
	cwd?: string;
	prompt: TextBlock[];
	agentOptions?: Route;
	maxDepth?: number;
}
export interface Activation {
	name: string;
	childId: string;
	result: Promise<{
		output?: unknown[];
		stopReason: string;
		diagnostic?: string;
	}>;
	dispose(): Promise<unknown>;
}
export interface Subagents {
	getProvider(
		name: string,
	): { capabilities?: { depthLimit?: boolean } } | undefined;
	startActivation(request: ActivationRequest): Promise<Activation>;
	sendMessage(
		agent: Agent,
		id: string,
		content: TextBlock[],
		options: { signal: AbortSignal },
	): Promise<unknown>;
}
export interface Model {
	id: string;
	name?: string;
}
export interface Llm {
	resolveCallConfig(route: Route, signal?: AbortSignal): Promise<unknown>;
	listProviders(): Model[];
	listModels(provider: string): Promise<Model[]>;
}
export interface Question {
	id: string;
	header: string;
	question: string;
	options: readonly { label: string; description: string }[];
}
export interface Answers {
	answers: { id: string; selected?: string[]; custom?: string }[];
}
export interface CommandInvocation {
	agent: Agent;
	rawInput: string;
	signal?: AbortSignal;
}
export interface CommandResult {
	kind: "success" | "error";
	text: string;
}
export interface ToolExec {
	agent?: Agent;
	signal?: AbortSignal;
	callId?: string;
}
export interface ToolValue {
	text: string;
	role?: Role;
	route?: Route | null;
	status?: string;
	durationMs?: number;
	verdict?: Verdict;
	task?: string;
	stages?: import("./background-runs.js").BackgroundStage[];
	comments?: import("./background-runs.js").BackgroundComment[];
	decisions?: import("./background-runs.js").BackgroundDecision[];
	recentRuns?: import("./background-runs.js").BackgroundRunSummary[];
	[key: string]: unknown;
}
export interface ToolOutput {
	schema: object;
	render(args: unknown, value: ToolValue): TextBlock[];
	presentationMeta(args: unknown, value: ToolValue): object;
}
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: object;
	output: ToolOutput;
	execute(args: unknown, exec: ToolExec): Promise<ToolValue>;
}
export interface WebRoute {
	kind: string;
	path: string;
	handler?: (
		request: IncomingMessage,
		response: ServerResponse,
		...args: unknown[]
	) => unknown;
	resource?: (
		request: Request,
		...args: unknown[]
	) => Response | Promise<Response>;
}
export interface WebServer {
	host?: string;
	getOrigin(): string;
	register(route: WebRoute): Disposer;
}
export interface HostServices {
	subagents: Subagents;
	llm: Llm;
	agents: { get(id: string): { status?: string } | undefined };
	workingDirectory: {
		get(session?: Agent["session"]): string | undefined;
		ensure(parent: Agent, signal?: AbortSignal): Promise<string>;
	};
	agentRuntime: import("./runtime-role.js").RuntimeService<Agent>;
	connection: {
		allowsRemoteAuthorities?: boolean;
		requestRejection(request: {
			headers: IncomingMessage["headers"];
		}): number | undefined;
	};
	configEditor: {
		edit(entry: object, change: (value: unknown) => unknown): Promise<unknown>;
	};
	clientModules: {
		graph(): { rev: string; entries: { id: string; url?: string }[] };
	};
	commands: {
		register(definition: {
			name: string;
			description: string;
			input: { hint: string };
			handler(invocation: CommandInvocation): Promise<CommandResult>;
		}): Disposer;
	};
	userQuestions: {
		ask(request: {
			questions: Question[];
			agent?: Agent;
			signal?: AbortSignal;
		}): Promise<Answers>;
	};
	sessionController: {
		create(request: { sessionId: string; cwd?: string }): Promise<unknown>;
		rename(request: { sessionId: string; title: string }): Promise<unknown>;
		prompt(
			request: {
				requestId: string;
				sessionId: string;
				mode: string;
				content: TextBlock[];
			},
			signal: AbortSignal,
		): Promise<unknown>;
	};
	workspaceRegistry: {
		resolveByPath(
			cwd: string,
		): Promise<{ attachSession?(id: string): Promise<unknown> } | undefined>;
	};
}
export interface HostContext {
	get<K extends keyof HostServices>(name: K): HostServices[K] | undefined;
	fiber?: { entry?: { options?: { config?: unknown } } & object };
	logger?: { info?(message: string): void; warn?(message: string): void };
	effect(callback: () => unknown, label?: string): unknown;
	on?(name: "subagent/end", listener: (info: { id: string }) => void): Disposer;
	on?(
		name: "session/event",
		listener: (
			session: Agent["session"],
			event: {
				type: string;
				data?: { name?: string; message?: { content?: unknown[] } };
			},
		) => void,
	): Disposer;
	tools: { register(definition: ToolDefinition): Disposer };
	systemPrompt: {
		getSectionOrder?(section: string): number;
		section(definition: {
			name: string;
			order: number;
			text: string;
		}): Disposer;
	};
	inject(
		services: string[],
		callback: (ctx: HostContext & { webServer: WebServer }) => void,
	): void;
}
