import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

interface PickerRoute {
	provider: string;
	model: string;
	runtime?: string;
	reasoningEffort?: string;
}
interface PickerGroup {
	id: string;
	name: string;
	models: Array<{ id: string; name: string }>;
}
interface NodeProps {
	value?: string;
	disabled?: boolean;
	"aria-label"?: string;
	onChange?(event: { target: { value: string } }): void;
	onClick?(): void;
	[key: string]: unknown;
}
type Tree = FakeNode | Tree[] | string | boolean | null | undefined;
type Component = (props: NodeProps) => Tree;
interface FakeNode {
	type: string | Component;
	props: NodeProps;
	children: Tree[];
}
interface PickerContext {
	effect(): void;
	locale: { bind(): (key: string) => string };
	slots: {
		inject(name: string, callback: () => unknown): void;
		register(options: { name?: string }, component: Component): void;
	};
}
interface PickerModule {
	factory(require: () => object): { apply(ctx: PickerContext): void };
}
function find(
	tree: Tree,
	predicate: (node: FakeNode) => boolean,
): FakeNode | undefined {
	if (!tree || typeof tree !== "object") return undefined;
	if (!Array.isArray(tree) && predicate(tree)) return tree;
	for (const child of Array.isArray(tree) ? tree : (tree.children ?? [])) {
		const found = find(child, predicate);
		if (found) return found;
	}
}

type RuntimeCatalog = Record<
	string,
	{ models?: Array<{ id: string; name: string }>; error?: string }
>;
async function pickerHarness(
	route: PickerRoute,
	groups: PickerGroup[] = [],
	runtimes: RuntimeCatalog = {},
	fallbacks: PickerRoute[] = [],
	mode: "route" | "fallback" = "route",
	api: Record<string, unknown> = {},
) {
	let captured!: PickerModule;
	let states: unknown[] = [];
	let cursor = 0;
	const React = {
		createElement: (
			type: string | Component,
			props: NodeProps | null,
			...children: Tree[]
		) => ({ type, props: props ?? {}, children }),
		Fragment: "fragment",
		useState(initial: unknown) {
			const index = cursor++;
			if (!(index in states)) states[index] = initial;
			return [
				states[index],
				(next: unknown) => {
					states[index] =
						typeof next === "function"
							? (next as (value: unknown) => unknown)(states[index])
							: next;
				},
			];
		},
		useEffect() {},
		useCallback: <T>(fn: T) => fn,
		useRef: () => ({ current: null }),
	};
	runInNewContext(
		await readFile(new URL("../client.js", import.meta.url), "utf8"),
		{
			window: {
				__ModuleLoader__: {
					load: (options: PickerModule) => {
						captured = options;
					},
				},
			},
		},
	);
	const face = captured.factory(() => React);
	let Section!: Component;
	face.apply({
		effect() {},
		locale: { bind: () => (key) => key },
		slots: {
			inject(name, callback) {
				const value = callback();
				if (value && typeof value === "object" && Symbol.iterator in value)
					for (const _ignored of value as Iterable<unknown>) {
					}
			},
			register(options, component) {
				if (options.name === "settings.models.footer") Section = component;
			},
		},
	});
	states = [
		{
			status: "ready",
			snapshot: { roles: { worker: { route, fallbacks } } },
			catalog: { groups },
		},
		mode === "fallback"
			? { role: "worker", fallback: true }
			: { role: "worker" },
		false,
		undefined,
		"",
	];
	const section = Section({ api, t: (key: string) => key });
	const element = find(
		section,
		(node) =>
			typeof node.type === "function" && node.type.name === "ModelPicker",
	)!;
	let saved: PickerRoute | undefined;
	states = [];
	cursor = 0;
	const props = {
		...element.props,
		runtimes,
		...(mode === "route"
			? {
					onApply: (value: PickerRoute) => {
						saved = value;
					},
				}
			: {}),
	};
	const render = () => {
		cursor = 0;
		return (element.type as Component)(props);
	};
	return { render, saved: () => saved, section };
}

test("runtime picker preserves external route on reopen and allows manual model entry without native providers", async () => {
	const picker = await pickerHarness({
		runtime: "droid",
		provider: "droid",
		model: "factory-model",
		reasoningEffort: "high",
	});
	let tree = picker.render();
	assert.equal(
		find(tree, (node) => node.type === "select")!.props.value,
		"droid",
	);
	const field = find(
		tree,
		(node) =>
			node.type === "input" && node.props["aria-label"] === "externalModel",
	)!;
	assert.equal(field.props.value, "factory-model");
	assert.equal(field.props.autoFocus, true);
	const search = find(
		tree,
		(node) => node.type === "input" && node.props["aria-label"] === "search",
	)!;
	assert.equal(search.props.autoFocus, false);
	field.props.onChange!({ target: { value: "another-model" } });
	tree = picker.render();
	const apply = find(
		tree,
		(node) => node.type === "button" && node.children.includes("apply"),
	)!;
	assert.equal(apply.props.disabled, false);
	apply.props.onClick!();
	assert.equal(picker.saved()!.runtime, "droid");
	assert.equal(picker.saved()!.provider, "droid");
	assert.equal(picker.saved()!.model, "another-model");
});

test("native selection retains provider/model behavior and runtime can switch to Cursor", async () => {
	const picker = await pickerHarness({ provider: "p", model: "m" }, [
		{ id: "p", name: "Provider", models: [{ id: "m", name: "Model" }] },
	]);
	let tree = picker.render();
	find(
		tree,
		(node) => node.type === "button" && node.children.includes("apply"),
	)!.props.onClick!();
	assert.equal(picker.saved()!.runtime, undefined);
	assert.equal(picker.saved()!.provider, "p");
	find(tree, (node) => node.type === "select")!.props.onChange!({
		target: { value: "cursor" },
	});
	tree = picker.render();
	find(
		tree,
		(node) => node.type === "button" && node.children.includes("apply"),
	)!.props.onClick!();
	assert.equal(picker.saved()!.runtime, "cursor");
	assert.equal(picker.saved()!.provider, "cursor");
	assert.equal(picker.saved()!.model, "m");
});

test("external runtime catalog offers selectable models for the route", async () => {
	const picker = await pickerHarness(
		{ runtime: "droid", provider: "droid", model: "old-model" },
		[],
		{
			droid: {
				models: [
					{ id: "auto", name: "Auto Model" },
					{ id: "claude-opus-5-5", name: "Opus 5.5" },
				],
			},
		},
	);
	let tree = picker.render();
	const option = find(
		tree,
		(node) =>
			node.type === "button" &&
			node.children.some(
				(child) =>
					typeof child === "object" &&
					child !== null &&
					!Array.isArray(child) &&
					"children" in child &&
					Array.isArray(child.children) &&
					child.children.includes("Opus 5.5"),
			),
	)!;
	option.props.onClick!();
	tree = picker.render();
	find(
		tree,
		(node) => node.type === "button" && node.children.includes("apply"),
	)!.props.onClick!();
	assert.equal(picker.saved()!.runtime, "droid");
	assert.equal(picker.saved()!.provider, "droid");
	assert.equal(picker.saved()!.model, "claude-opus-5-5");
});

function stringsOf(tree: Tree): string[] {
	if (typeof tree === "string") return [tree];
	if (!tree || typeof tree !== "object") return [];
	return (Array.isArray(tree) ? tree : (tree.children ?? [])).flatMap(
		stringsOf,
	);
}

test("role rows render the configured fallback chain", async () => {
	const picker = await pickerHarness({ provider: "p", model: "m" }, [], {}, [
		{ provider: "z", model: "g" },
		{ runtime: "droid", provider: "droid", model: "auto" },
	]);
	const row = find(
		picker.section,
		(node) =>
			typeof node.type === "function" &&
			node.type.name === "RoleRow" &&
			node.props.role === "worker",
	)!;
	const text = stringsOf((row.type as Component)(row.props));
	assert.ok(
		text.some((value) => value === "fallbacks: z/g -> droid:droid/auto"),
		JSON.stringify(text),
	);
});

test("fallback picker appends a runtime-catalog route to the chain", async () => {
	const saves: Array<{ role: string; routes: PickerRoute[] }> = [];
	const picker = await pickerHarness(
		{ runtime: "droid", provider: "droid", model: "old-model" },
		[],
		{ droid: { models: [{ id: "auto", name: "Auto Model" }] } },
		[{ provider: "z", model: "g" }],
		"fallback",
		{
			async saveFallback(role: string, routes: PickerRoute[]) {
				saves.push({ role, routes });
				return { ok: true };
			},
		},
	);
	let tree = picker.render();
	const option = find(
		tree,
		(node) =>
			node.type === "button" &&
			node.children.some(
				(child) =>
					typeof child === "object" &&
					child !== null &&
					!Array.isArray(child) &&
					"children" in child &&
					Array.isArray(child.children) &&
					child.children.includes("Auto Model"),
			),
	)!;
	option.props.onClick!();
	tree = picker.render();
	find(
		tree,
		(node) => node.type === "button" && node.children.includes("apply"),
	)!.props.onClick!();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(saves.length, 1);
	assert.equal(saves[0]!.role, "worker");
	assert.equal(saves[0]!.routes.length, 2);
	assert.equal(saves[0]!.routes[0]!.provider, "z");
	assert.equal(saves[0]!.routes[0]!.model, "g");
	assert.equal(saves[0]!.routes[1]!.runtime, "droid");
	assert.equal(saves[0]!.routes[1]!.provider, "droid");
	assert.equal(saves[0]!.routes[1]!.model, "auto");
});
