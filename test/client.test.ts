import test from "node:test";
import assert from "node:assert/strict";

type Rendered = [string, { className: string }, Rendered, Rendered];
type CardProps = {
	toolName: string;
	callId: string;
	t(key: string): string;
	useDisclosure(): { expanded: boolean; toggle(): void };
	block: object;
};
type Card = (props: CardProps) => Rendered;
interface SlotOptions {
	name: string;
	id?: string;
	order?: number;
	locale?: string;
	key?: string;
}
interface BrowserFixture {
	effect(callback: () => unknown): () => void;
	uiWorkspace: { openSession(sessionId: string): void };
	locale: {
		register(
			namespace: string,
			values: Record<string, Record<string, string>>,
		): () => void;
		bind(): (key: string) => string;
	};
	slots: {
		inject(name: string, callback: () => unknown): void;
		register(options: SlotOptions, component: Card): () => void;
	};
	remote: {
		session: {
			modelCatalog(): Promise<{ ok: boolean; value: { groups: unknown[] } }>;
		};
		$on(
			event: string,
			listener: (value: { sessionId: string }) => void,
		): () => void;
	};
}
interface TestClientModule {
	id: string;
	factory(require: (name: string) => object): {
		inject: string[];
		apply(ctx: BrowserFixture): void;
	};
}

test("the client half registers settings and foreground/background role tool cards", async () => {
	let captured!: TestClientModule;
	globalThis.window = {
		__ModuleLoader__: {
			load(options: unknown) {
				captured = options as TestClientModule;
			},
		},
	} as unknown as Window & typeof globalThis;
	globalThis.document = {
		createElement() {
			return { dataset: {}, textContent: "", remove() {} };
		},
		head: { append() {} },
		querySelectorAll() {
			return [];
		},
	} as unknown as Document;
	await import(new URL("../client.js", import.meta.url).href);
	assert.equal(captured.id, "@local/dsh-role-team");
	assert.equal(typeof captured.factory, "function");

	const fakeReact = {
		createElement: (...args: unknown[]) => args,
		Fragment: "Fragment",
		useState: <T>(initial: T) => [initial, () => {}],
		useEffect: () => {},
		useCallback: <T>(fn: T) => fn,
		useRef: () => ({ current: null }),
	};
	const moduleFace = captured.factory((name) => {
		if (name === "react") return fakeReact;
		throw new Error(`unexpected external: ${name}`);
	});
	assert.deepEqual(moduleFace.inject, [
		"slots",
		"locale",
		"remote",
		"remote.session",
		"uiWorkspace",
	]);
	assert.equal(typeof moduleFace.apply, "function");

	const dictionaries: Record<
		string,
		Record<string, Record<string, string>>
	> = {};
	const slotInjections: string[] = [];
	const registrations: Array<{ options: SlotOptions; component: Card }> = [];
	const openedSessions: string[] = [];
	let sessionAddedListener!: (value: { sessionId: string }) => void;
	const ctx: BrowserFixture = {
		effect(callback) {
			const disposer = callback();
			return typeof disposer === "function"
				? (disposer as () => void)
				: () => {};
		},
		uiWorkspace: {
			openSession(sessionId) {
				openedSessions.push(sessionId);
			},
		},
		locale: {
			register(namespace, values) {
				dictionaries[namespace] = values;
				return () => {};
			},
			bind() {
				return (key) => key;
			},
		},
		slots: {
			inject(name, callback) {
				slotInjections.push(name);
				const out = callback();
				if (
					out !== null &&
					out !== undefined &&
					typeof (out as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
						"function"
				) {
					for (const _ of out as Iterable<unknown>) {
						// each yield already registered itself through ctx.slots.register
					}
				}
			},
			register(options, component) {
				registrations.push({ options, component });
				return () => {};
			},
		},
		remote: {
			session: {
				modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
			},
			$on(event, listener) {
				if (event === "api-session/added") sessionAddedListener = listener;
				return () => {};
			},
		},
	};
	moduleFace.apply(ctx);

	// A session `/role-plan` created is claimed through the marker route and opened;
	// an unrelated session is left where it is.
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const address =
			typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		requests.push({ url: address, init });
		const planSession = address.includes("session-new");
		return {
			ok: planSession,
			async json() {
				return { ok: true, sessionId: "session-new" };
			},
		} as Response;
	};
	try {
		assert.equal(typeof sessionAddedListener, "function");
		sessionAddedListener({ sessionId: "session-new" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		sessionAddedListener({ sessionId: "session-foreign" });
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.equal(requests.length, 2);
	assert.ok(
		requests[0]!.url.endsWith("/plugin-api/role-team/plan-session/session-new"),
	);
	assert.equal(requests[0]!.init!.credentials, "same-origin");
	assert.deepEqual(openedSessions, ["session-new"]);

	assert.deepEqual(slotInjections, [
		"settings.models.footer",
		"tool.call.toolview",
	]);

	assert.equal(registrations[0]!.options.name, "settings.models.footer");
	assert.equal(registrations[0]!.options.id, "role-team");
	assert.equal(registrations[0]!.options.order, 20);
	assert.equal(registrations[0]!.options.locale, "roleTeam");
	assert.equal(typeof registrations[0]!.component, "function");

	const toolviews = registrations.slice(1);
	assert.deepEqual(
		toolviews.map((entry) => entry.options.key),
		[
			"roles_run",
			"roles_start",
			"roles_status",
			"roles_cancel",
			"role_plan",
			"role_worker",
			"role_advisor",
			"role_reviewer",
		],
	);
	for (const entry of toolviews) {
		assert.equal(entry.options.name, "tool.call.toolview");
		assert.equal(entry.options.locale, "roleTeam");
		assert.equal(typeof entry.component, "function");
	}

	for (const language of ["en", "ru", "zh"]) {
		const dict = dictionaries.roleTeam![language]!;
		for (const key of [
			"runTitle",
			"preparing",
			"running",
			"pipeline",
			"comments",
			"approved",
			"changes",
			"notApproved",
			"continued",
			"finished",
			"decisions",
			"noMeta",
			"noReport",
			"rawReport",
			"inheritRoute",
			"liveUnavailable",
			"decisionContinue",
			"decisionRetry",
			"decisionModel",
			"decisionStop",
			"decisionNone",
			"severityBlocker",
			"severityMajor",
			"severityMinor",
		]) {
			assert.ok(dict[key], `missing locale key ${language}.${key}`);
		}
	}

	const Card = toolviews[0]!.component;
	const rendered = Card({
		toolName: "roles_run",
		callId: "call-1",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: false,
			meta: {
				v: 1,
				tool: "roles_run",
				status: "approved",
				task: "Do it",
				stages: [
					{
						role: "advisor",
						route: { provider: "opencode-go", model: "glm-5.3" },
						status: "done",
					},
				],
				comments: [
					{
						role: "reviewer",
						stage: "round 1 final gate",
						route: { provider: "opencode-go", model: "qwen3.8-max" },
						approved: true,
						summary: "verified",
						issues: [],
					},
				],
				decisions: [],
			},
			content: [{ type: "text", text: "Role team: APPROVED" }],
			call: { name: "roles_run", argsRaw: '{"task":"Do it"}' },
		},
	});
	assert.equal(rendered[0]!, "div");
	assert.ok(rendered[1]!.className.includes("dsh-rt-tool"));
	const button = rendered[2]!;
	assert.equal(button[0]!, "button");
	assert.ok(JSON.stringify(button).includes("approved"));
	assert.ok(JSON.stringify(button).includes("Do it"));
	const body = rendered[3]!;
	const bodyText = JSON.stringify(body);
	assert.ok(bodyText.includes("round 1 final gate"));
	assert.ok(bodyText.includes("qwen3.8-max"));
	assert.ok(bodyText.includes("verified"));
	assert.ok(bodyText.includes("Role team: APPROVED"));

	// Per-state renders: preparing, running, error, meta-less, and single-role results.
	const preparing = Card({
		toolName: "roles_run",
		callId: "c2",
		t: (key) => key,
		useDisclosure: () => ({ expanded: false, toggle: () => {} }),
		block: { phase: "preparing" },
	});
	assert.ok(JSON.stringify(preparing).includes("preparing"));

	const running = Card({
		toolName: "roles_run",
		callId: "c3",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			phase: "start",
			name: "roles_run",
			argsRaw: '{"task":"Live task"}',
		},
	});
	const runningText = JSON.stringify(running);
	assert.ok(runningText.includes("running"));
	assert.ok(runningText.includes("liveUnavailable"));
	assert.ok(runningText.includes("Live task"));

	const failed = Card({
		toolName: "roles_run",
		callId: "c4",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: true,
			content: [{ type: "text", text: "Error: provider failed" }],
			call: { name: "roles_run", argsRaw: '{"task":"Broken"}' },
		},
	});
	const failedText = JSON.stringify(failed);
	assert.ok(failedText.includes("failed"));
	assert.ok(failedText.includes("Error: provider failed"));

	const metaLess = Card({
		toolName: "roles_run",
		callId: "c5",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: false,
			content: [{ type: "text", text: "Old result without metadata" }],
			call: { name: "roles_run", argsRaw: '{"task":"Old"}' },
		},
	});
	const metaLessText = JSON.stringify(metaLess);
	assert.ok(
		metaLessText.includes("finished"),
		"a settled result without a verdict must show the neutral finished pill, not changes",
	);
	assert.ok(metaLessText.includes("noMeta"));
	assert.ok(metaLessText.includes("Old result without metadata"));

	const planCard = toolviews[1]!.component;
	const planResult = planCard({
		toolName: "role_plan",
		callId: "c6",
		t: (key) => key,
		useDisclosure: () => ({ expanded: false, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: false,
			meta: {
				v: 1,
				tool: "role_plan",
				role: "plan",
				route: { provider: "codex", model: "gpt-6-astra" },
				status: "completed",
				durationMs: 5,
			},
			content: [{ type: "text", text: "Role PLAN finished" }],
			call: { name: "role_plan", argsRaw: '{"task":"Plan it"}' },
		},
	});
	const planText = JSON.stringify(planResult);
	assert.ok(
		planText.includes("finished"),
		"a successful non-verdict single-role result must show the neutral finished pill",
	);
	assert.ok(
		planText.includes("runTitle · PLAN"),
		"single-role cards carry the role-team context in their title",
	);

	const advisorCard = toolviews.find(
		(entry) => entry.options.key === "role_advisor",
	)!.component;
	const advisorResult = advisorCard({
		toolName: "role_advisor",
		callId: "c7",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: false,
			meta: {
				v: 1,
				tool: "role_advisor",
				role: "advisor",
				route: { provider: "zai", model: "glm-5.3" },
				status: "completed",
				durationMs: 9,
				verdict: {
					approved: false,
					summary: "needs work",
					issues: [{ severity: "major", detail: "tests missing" }],
				},
			},
			content: [{ type: "text", text: "Role ADVISOR finished" }],
			call: { name: "role_advisor", argsRaw: '{"task":"Check it"}' },
		},
	});
	const advisorText = JSON.stringify(advisorResult);
	assert.ok(advisorText.includes("changes"));
	assert.ok(
		advisorText.includes("needs work"),
		"a standalone ADVISOR verdict renders as a comment card",
	);
	assert.ok(advisorText.includes("glm-5.3"));
	assert.ok(advisorText.includes("tests missing"));
	assert.ok(advisorText.includes("severityMajor"));

	// awaiting_user phase, stage durationMs, child activity, cancelRun button, and status question title
	const awaitingCard = Card({
		toolName: "roles_start",
		callId: "c8",
		t: (key) => key,
		useDisclosure: () => ({ expanded: true, toggle: () => {} }),
		block: {
			kind: "tool-result",
			isError: false,
			meta: {
				v: 1,
				tool: "roles_start",
				runId: "roles-bg-1",
				status: "running",
				phase: "awaiting_user",
				task: "Fix edge cases",
				progress: "Waiting for your decision",
				child: { id: "c-1", activity: "thinking" },
				stages: [
					{
						role: "plan",
						route: { provider: "opencode-go", model: "gpt-6-luna" },
						status: "done",
						durationMs: 12000,
					},
				],
			},
			content: [{ type: "text", text: "Running" }],
			call: { name: "roles_start", argsRaw: '{"task":"Fix edge cases"}' },
		},
	});
	const awaitingText = JSON.stringify(awaitingCard);
	assert.ok(awaitingText.includes("awaitingUser"));
	assert.ok(awaitingText.includes("cancelRun"));
	assert.ok(awaitingText.includes("12s"));
	assert.ok(awaitingText.includes("thinking"));

	const statusInFlight = Card({
		toolName: "roles_status",
		callId: "c9",
		t: (key) => key,
		useDisclosure: () => ({ expanded: false, toggle: () => {} }),
		block: {
			phase: "start",
			name: "roles_status",
			argsRaw: '{"run_id":"roles-bg-1","question":"How is it going?"}',
		},
	});
	assert.ok(JSON.stringify(statusInFlight).includes("How is it going?"));
});
