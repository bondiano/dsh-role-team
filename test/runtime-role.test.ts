import { test } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeRoute,
	roleTeamSnapshot,
	resolveRoleTeamConfig,
	runRoleTeam,
} from "../index.js";
import {
	runRuntimeRole,
	type RuntimeContext,
	type RuntimeRoute,
	type RuntimeService,
} from "../runtime-role.js";

type HostContext = Parameters<typeof runRoleTeam>[0];
interface NativeRequest {
	cwd?: string;
	prompt: Array<{ text: string }>;
}
type RuntimeCall =
	| { type: "runtime"; options: RuntimeRoute & { cwd: string } }
	| { type: "native"; request: NativeRequest };

test("external runtime routes preserve runtime in normalized and settings snapshots", () => {
	const route = { runtime: "droid", model: "factory-model" };
	const normalized = normalizeRoute(route).route;
	assert.deepEqual(normalized, {
		runtime: "droid",
		provider: "droid",
		model: "factory-model",
	});
	assert.equal(
		roleTeamSnapshot({ roles: { worker: route } }).roles.worker.route?.runtime,
		"droid",
	);
	assert.match(
		normalizeRoute({ runtime: "invalid", provider: "p", model: "m" }).error!,
		/runtime/,
	);
});

test("external WORKER results are reviewed in candidate cwd and artifacts appear in team report", async () => {
	const calls: RuntimeCall[] = [];
	const verdict = JSON.stringify({ approved: true, summary: "ok", issues: [] });
	const runtime: RuntimeService = {
		async list() {
			return { runtimes: [{ id: "droid" }] };
		},
		async create(options) {
			calls.push({ type: "runtime", options });
			return { id: "candidate", cwd: "/worktrees/worker" };
		},
		async *send() {
			yield { type: "text", text: "implemented" };
			yield { type: "artifact", path: "/private/result.patch" };
			yield { type: "settled", status: "completed" };
		},
		async close() {},
	};
	const subagents = {
		getProvider() {
			return { capabilities: {} };
		},
		async startActivation(request: NativeRequest) {
			calls.push({ type: "native", request });
			return {
				name: "native-role",
				result: Promise.resolve({
					stopReason: "completed",
					output: [{ type: "text", text: verdict }],
				}),
				async dispose() {},
			};
		},
	};
	const services = {
		agentRuntime: runtime,
		subagents,
		workingDirectory: { get: () => "/source" },
	};
	const ctx = {
		get(name: keyof typeof services) {
			return services[name];
		},
	} as unknown as HostContext;
	const config = resolveRoleTeamConfig({
		roles: {
			plan: null,
			worker: { runtime: "droid", model: "test" },
			advisor: null,
			reviewer: null,
		},
	});
	const result = await runRoleTeam(ctx, {
		agent: { session: { id: "runtime-parent" } },
		task: "change file",
		plan: "existing plan",
		config,
	});
	assert.equal(result.status, "approved");
	const reviewers = calls
		.filter(
			(call): call is Extract<RuntimeCall, { type: "native" }> =>
				call.type === "native",
		)
		.slice(1);
	assert.equal(reviewers.length, 2);
	for (const call of reviewers) {
		assert.equal(call.request.cwd, "/worktrees/worker");
		assert.match(call.request.prompt[0]!.text, /\/worktrees\/worker/);
	}
	assert.equal(
		calls.find(
			(call): call is Extract<RuntimeCall, { type: "runtime" }> =>
				call.type === "runtime",
		)!.options.cwd,
		"/source",
	);
	assert.match(result.report, /\/private\/result.patch/);
	assert.match(result.report, /Candidate workspace: \/worktrees\/worker/);
});

test("external role cwd resolves from live parent and no native services are required", async () => {
	let request: (RuntimeRoute & { cwd: string }) | undefined;
	const parent = {};
	const runtime = {
		async create(options: RuntimeRoute & { cwd: string }) {
			request = options;
			return { id: "s", cwd: "/isolated" };
		},
		async *send() {
			yield { type: "completed", text: "result", status: "completed" };
		},
		async close() {},
	};
	const ctx = {
		get(name: string) {
			return name === "agentRuntime"
				? runtime
				: {
						async ensure(agent: object) {
							assert.equal(agent, parent);
							return "/actual";
						},
					};
		},
	} as unknown as RuntimeContext;
	const result = await runRuntimeRole(ctx, {
		route: { runtime: "cursor", provider: "cursor", model: "m" },
		role: "worker",
		prompt: "go",
		parent,
	});
	assert.equal(request!.cwd, "/actual");
	assert.equal(result.text, "result");
	assert.equal(result.cwd, "/isolated");
});

test("external role ignores close errors in finally and aborts cleanly on signal", async () => {
	const controller = new AbortController();
	const runtime = {
		async create() {
			return { id: "s", cwd: "/isolated" };
		},
		async *send() {
			yield { type: "text", text: "partial" };
			controller.abort();
			yield { type: "text", text: "ignored" };
		},
		async close() {
			throw new Error("close failed");
		},
	};
	const ctx = {
		get(name: string) {
			return name === "agentRuntime"
				? runtime
				: { ensure: async () => "/actual" };
		},
	} as unknown as RuntimeContext;
	await assert.rejects(
		runRuntimeRole(ctx, {
			route: { runtime: "cursor", provider: "cursor", model: "m" },
			role: "worker",
			prompt: "go",
			parent: {},
			signal: controller.signal,
		}),
		/role team was cancelled/,
	);
});

test("runtime role reports the executed route and names it in activity", async () => {
	const activity: Array<{ child?: { runtime?: string }; progress?: string }> =
		[];
	let created: RuntimeRoute | undefined;
	const runtime: RuntimeService = {
		async list() {
			return { runtimes: [{ id: "cursor" }] };
		},
		async create(options) {
			created = options;
			return { id: "session-1", cwd: "/worktree" };
		},
		async *send() {
			yield { type: "text", text: "done" };
			yield { type: "settled", status: "completed" };
		},
		async close() {},
	};
	const ctx = {
		get(name: string) {
			return name === "agentRuntime"
				? runtime
				: { ensure: async () => "/source" };
		},
	} as unknown as RuntimeContext;
	const result = await runRuntimeRole(ctx, {
		route: {
			runtime: "cursor",
			provider: "cursor",
			model: "claude-opus-5.5",
			reasoningEffort: "high",
		},
		role: "worker",
		prompt: "go",
		parent: {},
		onActivity: (next) => activity.push(next),
	});
	assert.equal(result.childName, "session-1");
	assert.equal(result.route.runtime, "cursor");
	assert.equal(result.route.model, "claude-opus-5.5");
	assert.equal(created!.model, "claude-opus-5.5");
	assert.equal(created!.reasoningEffort, "high");
	assert.equal(activity[0]!.child!.runtime, "cursor");
	assert.match(
		activity[0]!.progress!,
		/WORKER started · cursor:cursor\/claude-opus-5\.5 @high/,
	);
});
