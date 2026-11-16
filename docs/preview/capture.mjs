/** Capture the shipped components with deterministic data, without a live DSH session. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { roleTeamSnapshot } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../../../..");
const runtimeModules =
	process.env.DSH_PREVIEW_MODULES ??
	resolve(repository, "packages/dsh-runtime/node_modules");
const browserModules =
	process.env.DSH_PREVIEW_BROWSER_MODULES ??
	resolve(repository, "extensions/omp/cursor/node_modules");
const { chromium } = createRequire(resolve(browserModules, "package.json"))(
	"playwright",
);
const read = (path) => readFile(path, "utf8");
const scripts = await Promise.all([
	read(resolve(runtimeModules, "react/umd/react.production.min.js")),
	read(resolve(runtimeModules, "react-dom/umd/react-dom.production.min.js")),
]);
const theme = await Promise.all(
	["design-platform.css", "base.css"].map((file) =>
		read(
			resolve(
				runtimeModules,
				"@deepseek-ai/dsh-client-ui-theme/src/styles",
				file,
			),
		),
	),
);
const client = await read(resolve(here, "../../dist/client.js"));
const snapshot = roleTeamSnapshot({});
const catalog = {
	groups: [
		{
			id: "opencode-go",
			name: "OpenCode Go",
			models: [
				{
					id: "gpt-6-luna",
					name: "GPT-6 Luna",
					reasoning: {
						efforts: [
							{ id: "low", name: "Low" },
							{ id: "high", name: "High" },
						],
					},
				},
				{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
				{ id: "glm-5.3", name: "GLM 5.3" },
				{ id: "qwen3.8-max", name: "Qwen 3.8 Max" },
			],
		},
	],
};

function documentFor(language, view) {
	const russian = language === "ru";
	const task = russian
		? "Добавить проверку конфигурации и регрессионные тесты"
		: "Add configuration validation and regression tests";
	const route = (role) => snapshot.roles[role].route;
	const stages = ["plan", "advisor", "worker", "advisor", "reviewer"].map(
		(role, index) => ({
			role,
			route: route(role),
			status: view === "live" && index === 4 ? "running" : "done",
		}),
	);
	const comments = [
		{
			role: "advisor",
			stage: "plan audit 1",
			route: route("advisor"),
			approved: true,
			summary: russian
				? "План содержит пути файлов, риски и команды проверки."
				: "The plan names file paths, risks and verification commands.",
			issues: [],
		},
		{
			role: "advisor",
			stage: "round 1 attempt",
			route: route("advisor"),
			approved: true,
			summary: russian
				? "Проверены изменения и обработка некорректной конфигурации."
				: "Inspected the diff and invalid-configuration handling.",
			issues: [],
		},
		{
			role: "reviewer",
			stage: "round 1 final gate",
			route: route("reviewer"),
			approved: true,
			summary: russian
				? "Проверки пройдены. Критических замечаний нет."
				: "Checks passed. No blocking issues remain.",
			issues: [],
		},
	];
	const approved = {
		runId: "preview-run",
		tool: "roles_start",
		task,
		status: "approved",
		stages: stages.map((stage) => ({ ...stage, status: "done" })),
		comments,
		decisions: [],
		currentRole: null,
		progress: russian ? "Все этапы завершены." : "All stages completed.",
		text: "Role team: APPROVED\n\nAll acceptance checks passed.",
	};
	const live =
		view === "live"
			? {
					runId: "preview-run",
					tool: "roles_start",
					task,
					status: "running",
					stages,
					currentRole: "reviewer",
					startedAt: 1,
					progress: russian
						? "REVIEWER: проверяю результаты тестов и критерии приёмки."
						: "REVIEWER: checking test results and acceptance criteria.",
					text: russian
						? "Команда работает в фоне."
						: "The team is running in the background.",
				}
			: approved;
	const block = {
		kind: "tool-result",
		isError: false,
		call: { name: "roles_start", argsRaw: JSON.stringify({ task }) },
		content: [{ type: "text", text: live.text }],
		meta: { v: 1, ...live },
	};
	return `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>Role team component preview</title>
<style>${theme.join("\n")}body{margin:0;font:14px var(--dsw-font-family)}main{box-sizing:border-box;width:900px;padding:36px 44px 44px;margin:auto}.preview-context{font-size:13px;color:var(--dsw-alias-label-tertiary);margin:0 0 16px}.dsh-rt-section{margin-top:0}</style>
<main><p class="preview-context">${view === "settings" ? (russian ? "Настройки / Модели" : "Settings / Models") : russian ? "Команда ролей / Демонстрационный запуск" : "Role team / Demo run"}</p><div id="root"></div></main>
${scripts.map((source) => `<script>${source}</script>`).join("")}
<script>
const registrations=[];let dictionary;const language=${JSON.stringify(language)};
const snapshot=${JSON.stringify(snapshot)};const catalog=${JSON.stringify(catalog)};
window.demo={run:${JSON.stringify(live)},approved:${JSON.stringify(approved)},requests:[],renders:0};
window.fetch=async (url,init)=>{
  window.demo.requests.push({url:String(url),method:init?.method??'GET'});
  return {ok:true,status:200,json:async()=>String(url).includes('/run/')?{ok:true,run:window.demo.run}:snapshot};
};
window.__ModuleLoader__={load(bundle){bundle.factory(name=>{if(name==='react')return React;throw Error(name)}).apply({
effect(fn){return fn()},locale:{register(ns,dict){dictionary=dict[language];return()=>{}},bind(){return key=>dictionary[key]??key}},
remote:{session:{modelCatalog:async()=>({ok:true,value:catalog})},$on(){return()=>{}}},uiWorkspace:{},
slots:{inject(name,fn){const result=fn();if(result?.next)for(const row of result){}},register(options,component){registrations.push({options,component});return()=>{}}}
})}};
</script><script>${client}</script><script>
const entry=registrations.find(row=>row.options.${view === "settings" ? "name==='settings.models.footer'" : "key==='roles_start'"});
const props=${view === "settings" ? "entry.options.inject()" : `{toolName:'roles_start',callId:'preview-start-call',block:${JSON.stringify(block)},t:key=>dictionary[key]??key,useDisclosure:()=>({expanded:true,toggle(){}})}`};
window.demo.renders++;
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(entry.component,props));
</script></html>`;
}

const server = createServer((request, response) => {
	const url = new URL(request.url, "http://localhost");
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(
		documentFor(
			url.searchParams.get("language") ?? "en",
			url.searchParams.get("view") ?? "settings",
		),
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
	const page = await browser.newPage({
		viewport: { width: 980, height: 720 },
		deviceScaleFactor: 2,
	});
	await page.clock.install();
	page.on("pageerror", (error) => errors.push(error.message));
	await mkdir(resolve(here, "../screenshots"), { recursive: true });
	for (const language of ["en", "ru"]) {
		const base = `http://127.0.0.1:${server.address().port}/?language=${language}`;
		await page.goto(`${base}&view=settings`);
		await page.locator(".dsh-rt-row").last().waitFor();
		assert.equal(await page.locator(".dsh-rt-row").count(), 4);
		await page.locator("main").screenshot({
			path: resolve(here, `../screenshots/settings.${language}.png`),
		});
		await page
			.locator('[data-role="plan"] .dsh-rt-actions button')
			.first()
			.click();
		await page.locator("dialog[open]").waitFor();
		const dialog = await page.locator("dialog[open]").boundingBox();
		await page.screenshot({
			path: resolve(here, `../screenshots/model-picker.${language}.png`),
			clip: {
				x: dialog.x - 24,
				y: dialog.y - 24,
				width: dialog.width + 48,
				height: dialog.height + 48,
			},
		});
		await page.goto(`${base}&view=live`);
		await page.locator(".dsh-rt-stage").last().waitFor();
		assert.equal(await page.locator(".dsh-rt-stage").count(), 5);
		assert.equal(await page.locator('[data-active="true"]').count(), 1);
		assert.equal(
			await page.locator(".dsh-rt-tool-head .dsh-rt-pill").innerText(),
			language === "ru" ? "Выполняется…" : "Running…",
		);
		assert.deepEqual(await page.evaluate(() => window.demo.requests), [
			{ url: "/plugin-api/role-team/run/preview-run", method: "GET" },
		]);
		await page.locator("main").screenshot({
			path: resolve(here, `../screenshots/live.${language}.png`),
		});

		// The initial roles_start tool is already settled. Advance only the mocked
		// run state: the existing card must refresh without another tool or render.
		await page.evaluate(() => {
			window.demo.run = window.demo.approved;
		});
		await page.clock.runFor(2500);
		await page.locator(".dsh-rt-comment").last().waitFor();
		assert.equal(await page.locator(".dsh-rt-comment").count(), 3);
		assert.equal(await page.locator('[data-active="true"]').count(), 0);
		assert.equal(
			await page.locator(".dsh-rt-tool-head .dsh-rt-pill").innerText(),
			language === "ru" ? "Одобрено" : "Approved",
		);
		assert.equal(
			await page.locator(".dsh-rt-raw").textContent(),
			"Role team: APPROVED\n\nAll acceptance checks passed.",
		);
		await page.locator("main").screenshot({
			path: resolve(here, `../screenshots/result.${language}.png`),
		});
		const settledRequests = await page.evaluate(
			() => window.demo.requests.length,
		);
		assert.equal(settledRequests, 2);
		await page.clock.runFor(7500);
		assert.equal(
			await page.evaluate(() => window.demo.requests.length),
			settledRequests,
			"terminal card must stop polling",
		);
		assert.equal(
			await page.evaluate(() => window.demo.renders),
			1,
			"no replacement tool result was rendered",
		);
		assert.ok(
			(await page.evaluate(() => window.demo.requests)).every(
				(request) =>
					request.method === "GET" &&
					request.url === "/plugin-api/role-team/run/preview-run",
			),
			"status refreshes never start another tool",
		);

		await page.goto(`${base}&view=result`);
		await page.locator(".dsh-rt-comment").last().waitFor();
		await page.clock.runFor(5000);
		assert.deepEqual(
			await page.evaluate(() => window.demo.requests),
			[],
			"an initially approved result does not poll",
		);
	}
	assert.deepEqual(errors, []);
	console.log(
		"Captured eight screenshots in both languages; background roles_start cards poll by runId, transition running → approved with three comments, then stop polling without starting another tool; no browser errors.",
	);
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
