type ClientReact = typeof import("react");
type ClientNode = import("react").ReactNode;
type ClientTranslator = (key: string) => string;
type ClientRole = "plan" | "worker" | "advisor" | "reviewer";
type ClientItem = Record<string, unknown>;
interface ClientRoute {
	provider: string;
	model: string;
	runtime?: string;
	reasoningEffort?: string;
}
interface ClientRoleInfo {
	route?: ClientRoute | null;
	fallbacks?: ClientRoute[];
	family?: string | null;
	source?: string;
	problem?: string;
	validationError?: string;
}
interface ClientWarningItem {
	kind: "worker_advisor" | "worker_reviewer" | "advisor_reviewer" | "inherit";
	family?: string;
	message?: string;
}
interface ClientModel {
	id: string;
	name: string;
	reasoning?: { efforts?: Array<{ id: string; name: string }> };
}
interface ClientGroup {
	id: string;
	name: string;
	models?: ClientModel[];
}
interface ClientCatalog {
	groups?: ClientGroup[];
}
interface ClientSnapshot {
	ok?: boolean;
	error?: string;
	roles?: Partial<Record<ClientRole, ClientRoleInfo>>;
	runtimes?: Record<string, { models?: ClientModel[]; error?: string }>;
	warnings?: string[];
	warningItems?: ClientWarningItem[];
	maxRounds?: number;
	maxPlanPasses?: number;
	childMaxDepth?: number;
}
interface ClientApi {
	load(validate?: boolean): Promise<ClientSnapshot>;
	save(role: ClientRole, route: ClientRoute): Promise<ClientSnapshot>;
	saveFallback(
		role: ClientRole,
		routes: ClientRoute[],
	): Promise<ClientSnapshot>;
	inherit?(role: ClientRole): Promise<ClientSnapshot>;
	reset(role: ClientRole): Promise<ClientSnapshot>;
	saveConfig?(patch: {
		maxRounds?: number;
		maxPlanPasses?: number;
		childMaxDepth?: number;
	}): Promise<ClientSnapshot>;
	runtimeModels(
		runtime: string,
	): Promise<{ models?: ClientModel[]; error?: string }>;
	catalog(): Promise<ClientCatalog>;
	onCatalogChange(listener: () => void): () => void;
}
interface ClientSectionProps {
	api: ClientApi;
	t: ClientTranslator;
}
interface ClientRowProps {
	role: ClientRole;
	info?: ClientRoleInfo;
	catalog?: ClientCatalog | null;
	t: ClientTranslator;
	busy: boolean;
	onEdit: (role: ClientRole) => void;
	onFallback: (role: ClientRole) => void;
	onReset: (role: ClientRole) => void;
}
interface ClientPickerProps {
	role: ClientRole;
	info?: ClientRoleInfo;
	catalog?: ClientCatalog | null;
	t: ClientTranslator;
	busy: boolean;
	error?: string;
	fallback?: boolean;
	runtimes?: Record<string, { models?: ClientModel[]; error?: string }>;
	onRuntime?: (runtime: string) => void;
	onApply: (route: ClientRoute) => void;
	onRemoveFallback?: (index: number) => void;
	onClearFallbacks?: () => void;
	onInherit?: () => void;
	onCancel: () => void;
}
interface ClientToolBlock {
	kind?: string;
	phase?: string;
	call?: { argsRaw?: string };
	argsRaw?: string;
	content?: unknown[];
	isError?: boolean;
	meta?: unknown;
}
interface ClientToolProps {
	toolName: string;
	block?: ClientToolBlock | null;
	callId?: string;
	t?: ClientTranslator;
	useDisclosure?: () => { expanded: boolean; toggle: () => void };
}
interface ClientContext {
	effect(callback: () => void | (() => void), label?: string): void;
	locale: {
		register(
			namespace: string,
			dictionaries: Record<string, Record<string, string>>,
		): () => void;
		bind(namespace: string): ClientTranslator;
	};
	remote: {
		session: { modelCatalog(): Promise<{ ok: boolean; value: ClientCatalog }> };
		$on(event: string, listener: (value: unknown) => void): () => void;
	};
	uiWorkspace?: { openSession?(id: string): void };
	slots: {
		inject(
			name: string,
			factory: () => (() => void) | Generator<() => void>,
		): void;
		register<Props>(
			options: {
				name: string;
				id?: string;
				order?: number;
				locale: string;
				key?: string;
				inject?: () => Props;
			},
			component: (props: Props) => ClientNode,
		): () => void;
	};
}
interface Window {
	__ModuleLoader__: {
		load(options: {
			id: string;
			factory(require: (id: "react") => ClientReact): {
				inject: string[];
				apply(ctx: ClientContext): void;
			};
		}): void;
	};
}

/**
 * Browser half of `@local/dsh-role-team`.
 *
 * Adds the Role team section to **Settings → Models** and renders dedicated
 * role-team cards in the chat timeline.
 */

(window as Window).__ModuleLoader__.load({
	id: "@local/dsh-role-team",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** Same-origin route served by the Host half. */
		const ROUTE = "/plugin-api/role-team/roles";
		/** Same-origin route naming a session `/role-plan` just created. */
		const PLAN_SESSION_ROUTE = "/plugin-api/role-team/plan-session";
		/** Locale namespace owned by this plugin. */
		const NS = "roleTeam";
		/** The four roles, in pipeline order. */
		const ROLES: ClientRole[] = ["plan", "worker", "advisor", "reviewer"];
		const ROLE_LABEL: Record<string, string> = {
			plan: "PLAN",
			worker: "WORKER",
			advisor: "ADVISOR",
			reviewer: "REVIEWER",
		};
		const ROLE_COLOR: Record<string, string> = {
			plan: "#f0b451",
			worker: "#2f7fc1",
			advisor: "#3fa46a",
			reviewer: "#7b62c9",
		};
		/** One route in the compact form the settings rows use. */
		function routeText(route: ClientRoute): string {
			return `${route.runtime && route.runtime !== "native" ? `${route.runtime}:` : ""}${route.provider}/${route.model}${route.reasoningEffort === undefined ? "" : ` @${route.reasoningEffort}`}`;
		}
		const FAMILY_LABEL: Record<string, string> = {
			openai: "OpenAI",
			anthropic: "Anthropic",
			google: "Google",
			zai: "Z.AI / GLM",
			deepseek: "DeepSeek",
			qwen: "Qwen",
			moonshot: "Moonshot",
			xai: "xAI",
			minimax: "MiniMax",
			meta: "Meta",
			mistral: "Mistral",
		};

		const en = {
			title: "Role team",
			intro:
				"Choose the model each role uses. Changes apply to the next role run; the /roles command in chat changes the same setting.",
			refresh: "Refresh",
			loading: "Loading role settings…",
			loadError: "Could not load role settings.",
			retry: "Try again",
			saveError: "Could not save the role route.",
			noProviders:
				"No routable provider is available. Configure a provider under Models first.",
			change: "Change",
			reset: "Reset",
			recommended: "Recommended",
			custom: "Custom",
			inherit: "Inherits the session model",
			useInherit: "Inherit session model",
			unavailable: "not currently available",
			fallbacks: "Fallbacks",
			noFallbacks: "No fallbacks",
			editFallbacks: "Fallbacks",
			chooseFallbackTitle: "Add a fallback for {role}",
			remove: "Remove",
			clearFallbacks: "Clear fallbacks",
			runtimeModels: "Runtime models",
			runtimeModelsError: "Runtime models are unavailable.",
			chooseTitle: "Choose the model for {role}",
			search: "Search models",
			providers: "Providers",
			runtime: "Agent runtime",
			runtimeNative: "Native DSH",
			externalModel: "Runtime model ID",
			externalModelHint:
				"Enter a model available to this runtime. The list below provides suggestions from DSH providers.",
			models: "Models",
			noModels: "No models match.",
			effort: "Reasoning effort",
			defaultEffort: "Default",
			cancel: "Cancel",
			apply: "Apply",
			saving: "Saving…",
			saved: "Saved",
			close: "Close",
			warnings: "Independence",
			warningWorkerAdvisor:
				"WORKER and ADVISOR both use the {family} family; the advisor's independence is weaker.",
			warningWorkerReviewer:
				"WORKER and REVIEWER both use the {family} family; the final gate is not independent.",
			warningAdvisorReviewer:
				"ADVISOR and REVIEWER both use the {family} family; the final gate is not independent from the advisor.",
			warningInherit:
				"At least one of WORKER, ADVISOR or REVIEWER inherits the session model, so cross-family independence is not guaranteed.",
			chooseEffort: "Effort",
			modelUnavailable:
				"This route is not advertised by any routable provider right now. Pick another model or reset the role.",
			limitsTitle: "Loop limits",
			maxRoundsLabel: "Max worker rounds",
			maxPlanPassesLabel: "Max plan passes",
			childMaxDepthLabel: "Child delegation depth",
			runTitle: "Role team",
			preparing: "Preparing…",
			running: "Running…",
			awaitingUser: "Awaiting your decision",
			cancelRun: "Cancel run",
			pipeline: "Pipeline",
			comments: "ADVISOR and REVIEWER comments",
			approved: "Approved",
			changes: "Changes required",
			continued: "Continued without approval",
			notApproved: "Not approved",
			failed: "Failed",
			cancelled: "Cancelled",
			cancelling: "Cancelling…",
			decisions: "Decisions",
			inheritRoute: "session model",
			noMeta: "Structured details are unavailable; showing the raw report.",
			rawReport: "Raw report",
			finished: "Finished",
			liveUnavailable: "Live progress is unavailable right now.",
			noReport: "(no report)",
			decisionContinue: "continue without approval",
			decisionRetry: "try 3 more rounds",
			decisionModel: "change the worker model",
			decisionStop: "stop",
			decisionNone: "no answer",
			severityBlocker: "blocker",
			severityMajor: "major",
			severityMinor: "minor",
		};

		const ru = {
			title: "Команда ролей",
			intro:
				"Выберите модель для каждой роли. Изменения применяются со следующего запуска ролей; команда /roles в чате меняет ту же настройку.",
			refresh: "Обновить",
			loading: "Загружаю настройки ролей…",
			loadError: "Не удалось загрузить настройки ролей.",
			retry: "Повторить",
			saveError: "Не удалось сохранить маршрут роли.",
			noProviders:
				"Нет доступных провайдеров. Сначала настройте провайдера в разделе «Модели».",
			change: "Изменить",
			reset: "Сбросить",
			recommended: "Рекомендуемая",
			custom: "Своя",
			inherit: "Наследует модель сессии",
			useInherit: "Наследовать модель сессии",
			unavailable: "сейчас недоступна",
			fallbacks: "Фолбеки",
			noFallbacks: "Без фолбеков",
			editFallbacks: "Фолбеки",
			chooseFallbackTitle: "Добавить фолбек для {role}",
			remove: "Убрать",
			clearFallbacks: "Очистить фолбеки",
			runtimeModels: "Модели рантайма",
			runtimeModelsError: "Модели рантайма недоступны.",
			chooseTitle: "Выберите модель для {role}",
			search: "Поиск моделей",
			providers: "Провайдеры",
			runtime: "Среда агента",
			runtimeNative: "Нативный DSH",
			externalModel: "ID модели runtime",
			externalModelHint:
				"Введите модель, доступную выбранному runtime. Ниже — подсказки из каталога DSH.",
			models: "Модели",
			noModels: "Нет подходящих моделей.",
			effort: "Уровень рассуждений",
			defaultEffort: "По умолчанию",
			cancel: "Отмена",
			apply: "Применить",
			saving: "Сохраняю…",
			saved: "Сохранено",
			close: "Закрыть",
			warnings: "Независимость",
			warningWorkerAdvisor:
				"WORKER и ADVISOR используют одно семейство {family}; независимость советника слабее.",
			warningWorkerReviewer:
				"WORKER и REVIEWER используют одно семейство {family}; финальный контроль не независим.",
			warningAdvisorReviewer:
				"ADVISOR и REVIEWER используют одно семейство {family}; финальный контроль не независим от советника.",
			warningInherit:
				"Хотя бы одна из ролей WORKER, ADVISOR или REVIEWER наследует модель сессии, поэтому независимость семейств не гарантирована.",
			chooseEffort: "Усилие",
			modelUnavailable:
				"Этот маршрут сейчас не предлагается ни одним доступным провайдером. Выберите другую модель или сбросьте роль.",
			limitsTitle: "Лимиты цикла",
			maxRoundsLabel: "Раунды WORKER",
			maxPlanPassesLabel: "Проходы аудита плана",
			childMaxDepthLabel: "Глубина делегирования",
			runTitle: "Команда ролей",
			preparing: "Подготовка…",
			running: "Выполняется…",
			awaitingUser: "Ожидает решения",
			cancelRun: "Отменить запуск",
			pipeline: "Конвейер",
			comments: "Замечания ADVISOR и REVIEWER",
			approved: "Одобрено",
			changes: "Нужны правки",
			continued: "Продолжено без одобрения",
			notApproved: "Не одобрено",
			failed: "Ошибка",
			cancelled: "Отменено",
			cancelling: "Отмена…",
			decisions: "Решения",
			inheritRoute: "модель сессии",
			noMeta: "Структурированные данные недоступны; показан исходный отчёт.",
			rawReport: "Исходный отчёт",
			finished: "Завершено",
			liveUnavailable: "Живой прогресс сейчас недоступен.",
			noReport: "(нет отчёта)",
			decisionContinue: "продолжить без одобрения",
			decisionRetry: "ещё 3 раунда",
			decisionModel: "сменить модель воркера",
			decisionStop: "остановиться",
			decisionNone: "без ответа",
			severityBlocker: "блокер",
			severityMajor: "серьёзное",
			severityMinor: "мелкое",
		};

		const zh = {
			title: "角色团队",
			intro:
				"为每个角色选择模型。更改会应用于下一次角色运行；聊天中的 /roles 命令修改的是同一设置。",
			refresh: "刷新",
			loading: "正在加载角色设置…",
			loadError: "无法加载角色设置。",
			retry: "重试",
			saveError: "无法保存角色路由。",
			noProviders: "没有可路由的提供商。请先在“模型”中配置提供商。",
			change: "更改",
			reset: "重置",
			recommended: "推荐",
			custom: "自定义",
			inherit: "继承会话模型",
			useInherit: "继承会话模型",
			unavailable: "当前不可用",
			fallbacks: "备用模型",
			noFallbacks: "无备用模型",
			editFallbacks: "备用模型",
			chooseFallbackTitle: "为 {role} 添加备用模型",
			remove: "移除",
			clearFallbacks: "清空备用模型",
			runtimeModels: "运行时模型",
			runtimeModelsError: "运行时模型不可用。",
			chooseTitle: "为 {role} 选择模型",
			search: "搜索模型",
			providers: "提供商",
			runtime: "代理运行时",
			runtimeNative: "原生 DSH",
			externalModel: "运行时模型 ID",
			externalModelHint: "输入此运行时可用的模型。下方列表提供 DSH 模型建议。",
			models: "模型",
			noModels: "没有匹配的模型。",
			effort: "推理强度",
			defaultEffort: "默认",
			cancel: "取消",
			apply: "应用",
			saving: "正在保存…",
			saved: "已保存",
			close: "关闭",
			warnings: "独立性",
			warningWorkerAdvisor:
				"WORKER 和 ADVISOR 都使用 {family} 系列；ADVISOR 的独立性较弱。",
			warningWorkerReviewer:
				"WORKER 和 REVIEWER 都使用 {family} 系列；最终关卡不独立。",
			warningAdvisorReviewer:
				"ADVISOR 和 REVIEWER 都使用 {family} 系列；最终关卡不独立于 ADVISOR。",
			warningInherit:
				"WORKER、ADVISOR 或 REVIEWER 中至少有一个继承会话模型，因此无法保证跨系列独立性。",
			chooseEffort: "强度",
			modelUnavailable:
				"当前没有可路由的提供商提供此路由。请选择其他模型或重置该角色。",
			limitsTitle: "循环限制",
			maxRoundsLabel: "WORKER 最大轮数",
			maxPlanPassesLabel: "计划审核轮数",
			childMaxDepthLabel: "子代理最大深度",
			runTitle: "角色团队",
			preparing: "准备中…",
			running: "运行中…",
			awaitingUser: "等待您的决定",
			cancelRun: "取消运行",
			pipeline: "流水线",
			comments: "ADVISOR 和 REVIEWER 的意见",
			approved: "已通过",
			changes: "需要修改",
			continued: "未经批准继续",
			notApproved: "未通过",
			failed: "失败",
			cancelled: "已取消",
			cancelling: "正在取消…",
			decisions: "决定",
			inheritRoute: "会话模型",
			noMeta: "结构化数据不可用；显示原始报告。",
			rawReport: "原始报告",
			finished: "已完成",
			liveUnavailable: "实时进度当前不可用。",
			noReport: "（无报告）",
			decisionContinue: "不批准继续",
			decisionRetry: "再试 3 轮",
			decisionModel: "更换 WORKER 模型",
			decisionStop: "停止",
			decisionNone: "无回应",
			severityBlocker: "阻塞",
			severityMajor: "主要",
			severityMinor: "次要",
		};

		const CSS = `
.dsh-rt-section {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 28px;
  padding-top: 24px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dsh-rt-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-rt-intro { margin: 4px 0 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); max-width: 620px; }
.dsh-rt-refresh {
  box-sizing: border-box; flex: none; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
@media (hover: hover) { .dsh-rt-refresh:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-rt-refresh:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-refresh:disabled { opacity: .4; cursor: default; }
.dsh-rt-card {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  overflow: hidden;
}
.dsh-rt-row {
  display: grid;
  grid-template-columns: 142px minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}
.dsh-rt-row:first-child { border-top: 0; }
.dsh-rt-role { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-rt-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dsh-rt-role-name { font-size: 12px; line-height: 18px; font-weight: 600; letter-spacing: .04em; color: var(--dsw-alias-label-primary); }
.dsh-rt-family {
  font-size: 11px; line-height: 16px; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsh-rt-value { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dsh-rt-model { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rt-route { font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-rt-muted { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.dsh-rt-warn { font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-warn-label); }
.dsh-rt-meta { display: flex; justify-content: flex-end; }
.dsh-rt-source {
  font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsh-rt-actions { display: flex; justify-content: flex-end; gap: 4px; }
.dsh-rt-btn {
  box-sizing: border-box; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
@media (hover: hover) { .dsh-rt-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-rt-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-btn:disabled { opacity: .4; cursor: default; }
.dsh-rt-btn-quiet { border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-rt-btn-primary { border: none; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
@media (hover: hover) { .dsh-rt-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); } }
.dsh-rt-limits {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  padding: 10px 14px; border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-rt-limit-item { display: inline-flex; align-items: center; gap: 6px; }
.dsh-rt-limit-input {
  width: 48px; height: 26px; padding: 0 6px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; text-align: center;
}
.dsh-rt-note {
  margin: 0; padding: 9px 12px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-rt-warnings { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.dsh-rt-warning { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
.dsh-rt-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-rt-status { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
.dsh-rt-loading { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dsh-rt-retry { align-self: flex-start; }
.dsh-rt-dialog {
  box-sizing: border-box; position: fixed; inset: 0; margin: auto;
  width: min(620px, calc(100vw - 48px)); max-height: min(640px, calc(100vh - 48px));
  padding: 0; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xl); box-shadow: 0 24px 64px rgba(0, 0, 0, .32);
  color: var(--dsw-alias-label-primary);
}
.dsh-rt-dialog[open] { display: flex; flex-direction: column; }
.dsh-rt-dialog::backdrop { background: rgba(0, 0, 0, .38); }
.dsh-rt-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-rt-dialog-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.dsh-rt-close {
  box-sizing: border-box; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 18px; line-height: 1; cursor: pointer;
}
@media (hover: hover) { .dsh-rt-close:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-rt-dialog-body { display: grid; grid-template-columns: 168px minmax(0, 1fr); flex: 1; min-height: 0; }
.dsh-rt-runtime { display: flex; align-items: center; gap: 12px; padding: 12px 20px; color: var(--dsw-alias-label-primary); }
.dsh-rt-runtime select { font: inherit; padding: 6px 10px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.dsh-rt-runtime select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-rt-runtime-model { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; }
.dsh-rt-providers { display: flex; flex-direction: column; gap: 2px; padding: 8px; overflow: auto; border-right: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-rt-provider {
  box-sizing: border-box; width: 100%; padding: 8px 9px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 19px;
  text-align: left; cursor: pointer;
}
.dsh-rt-provider:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-rt-provider[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-rt-provider:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-models { display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 10px 12px; }
.dsh-rt-search {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px;
}
.dsh-rt-search::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-rt-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-rt-model-list { display: flex; flex-direction: column; gap: 2px; min-height: 120px; max-height: 328px; overflow: auto; }
.dsh-rt-model-option {
  box-sizing: border-box; width: 100%; padding: 8px 9px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
.dsh-rt-model-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-rt-model-option[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); }
.dsh-rt-model-option:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-model-name { display: block; font-size: 13px; line-height: 20px; }
.dsh-rt-model-id { display: block; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsh-rt-efforts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-rt-fallbacks { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-rt-fallback-row { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-m, 6px); }
.dsh-rt-effort-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.dsh-rt-effort {
  box-sizing: border-box; height: 26px; padding: 0 9px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-rt-effort[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.dsh-rt-effort:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-rt-dialog-foot-left { margin-right: auto; }
.dsh-rt-dialog-error { margin: 0; padding: 0 16px 12px; }
@media (max-width: 760px) {
  .dsh-rt-row { grid-template-columns: minmax(0, 1fr) auto; }
  .dsh-rt-meta { grid-column: 1 / -1; justify-content: flex-start; }
  .dsh-rt-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .dsh-rt-dialog-body { grid-template-columns: 1fr; }
  .dsh-rt-providers { flex-direction: row; border-right: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
  .dsh-rt-provider { width: auto; white-space: nowrap; }
}
.dsh-rt-tool {
  box-sizing: border-box; display: flex; flex-direction: column; width: 100%;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary); font: inherit; overflow: hidden;
}
.dsh-rt-tool-head {
  box-sizing: border-box; display: flex; align-items: center; gap: 8px; min-width: 0; width: 100%;
  padding: 9px 12px; border: none; border-radius: 0; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
@media (hover: hover) { .dsh-rt-tool-head:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-rt-tool-head:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-tool-dots { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.dsh-rt-tool-title { font-size: 12px; line-height: 18px; font-weight: 600; letter-spacing: .04em; white-space: nowrap; }
.dsh-rt-tool-route { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dsh-rt-chevron {
  flex: none; margin-left: auto; font-size: 10px; line-height: 14px;
  color: var(--dsw-alias-label-tertiary); transition: transform .15s ease;
}
.dsh-rt-chevron[data-open='true'] { transform: rotate(90deg); }
.dsh-rt-pill {
  font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsh-rt-pill-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-rt-pill-run { color: var(--dsw-alias-brand-primary); }
.dsh-rt-pill-warn { color: var(--dsw-alias-state-warn-label); }
.dsh-rt-pill-err { color: var(--dsw-alias-state-error-primary); }
.dsh-rt-tool-task {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-rt-tool-body { display: flex; flex-direction: column; gap: 10px; padding: 0 12px 12px; }
.dsh-rt-tool-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-rt-tool-task-full { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.dsh-rt-muted-line { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-style: italic; }
.dsh-rt-section-label {
  font-size: 11px; line-height: 16px; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary);
}
.dsh-rt-stages { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-rt-stage {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
}
.dsh-rt-stage[data-active='true'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.dsh-rt-stage-route {
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dsh-rt-stage-time {
  font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
}
.dsh-rt-comment {
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); padding: 9px 11px;
}
.dsh-rt-comment-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-rt-comment-role { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; font-weight: 600; letter-spacing: .04em; }
.dsh-rt-comment-stage { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.dsh-rt-comment-summary { margin: 4px 0 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.dsh-rt-issues { margin: 2px 0 0; padding: 0 0 0 16px; display: flex; flex-direction: column; gap: 2px; }
.dsh-rt-issue { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.dsh-rt-decisions { margin: 0; padding: 0 0 0 16px; display: flex; flex-direction: column; gap: 2px; }
.dsh-rt-decision { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-rt-raw-summary { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dsh-rt-raw {
  margin: 0; padding: 9px 11px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto;
}
`;

		/** Replace `{name}` placeholders in localized copy. */
		function fill(text: string, params?: Record<string, string>) {
			if (params === undefined) return text;
			let out = text;
			for (const [key, value] of Object.entries(params))
				out = out.split(`{${key}}`).join(String(value));
			return out;
		}

		const stringValue = (value: unknown): string => String(value);

		function messageOf(error: unknown) {
			if (error instanceof Error && typeof error.message === "string")
				return error.message;
			try {
				return String(error);
			} catch {
				return "unknown error";
			}
		}

		function formatShortDuration(ms: unknown): string {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 500) return "";
			const total = Math.max(1, Math.round(ms / 1000));
			if (total < 60) return `${total}s`;
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
		}

		/** Build the Host API the page talks to. */
		function createApi(ctx: ClientContext): ClientApi {
			async function request(
				method: string,
				body?: unknown,
				query = "",
			): Promise<ClientSnapshot> {
				const response = await fetch(`${ROUTE}${query}`, {
					method,
					credentials: "same-origin",
					headers: {
						accept: "application/json",
						...(body === undefined
							? {}
							: {
									"content-type": "application/json",
									"x-role-team-request": "1",
								}),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				let data: ClientSnapshot;
				try {
					data = (await response.json()) as ClientSnapshot;
				} catch {
					throw new Error(`HTTP ${response.status}`);
				}
				if (!response.ok || data.ok === false)
					throw new Error(data.error ?? `HTTP ${response.status}`);
				return data;
			}
			return {
				load: (validate = false) =>
					request("GET", undefined, validate ? "?validate=1" : ""),
				save: (role: ClientRole, route: ClientRoute) =>
					request("POST", { role, route }),
				saveFallback: (role: ClientRole, routes: ClientRoute[]) =>
					request("POST", { role, action: "fallback", routes }),
				inherit: (role: ClientRole) =>
					request("POST", { role, action: "inherit" }),
				reset: (role: ClientRole) => request("POST", { role, action: "reset" }),
				saveConfig: (patch) => request("POST", { action: "config", ...patch }),
				async runtimeModels(runtime: string) {
					const snapshot = await request(
						"GET",
						undefined,
						`?models=1&runtime=${encodeURIComponent(runtime)}`,
					);
					return snapshot.runtimes?.[runtime] ?? {};
				},
				async catalog() {
					const response = await ctx.remote.session.modelCatalog();
					if (!response.ok) throw new Error("model catalog is unavailable");
					return response.value;
				},
				onCatalogChange(listener: () => void) {
					try {
						return ctx.remote.$on("llm/adapters-updated", listener);
					} catch {
						return () => {};
					}
				},
			};
		}

		/**
		 * Ask the Host whether a just-added session is a `/role-plan` session, and
		 * open it when it is.
		 */
		async function openPlanSession(ctx: ClientContext, sessionId: string) {
			try {
				const response = await fetch(
					`${PLAN_SESSION_ROUTE}/${encodeURIComponent(sessionId)}`,
					{
						credentials: "same-origin",
						headers: { accept: "application/json" },
					},
				);
				if (!response.ok) return;
				const data = (await response.json()) as ClientSnapshot;
				if (data === null || typeof data !== "object" || data.ok !== true)
					return;
				ctx.uiWorkspace?.openSession?.(sessionId);
			} catch {
				// A failed claim only costs the automatic switch.
			}
		}

		/**
		 * Localized family-independence warnings from server `warningItems`
		 * (with fallback for minimal test snapshots that only pass `roles`).
		 */
		function independenceWarnings(
			snapshot: ClientSnapshot | null | undefined,
			t: ClientTranslator,
		) {
			const label = (value: string) => FAMILY_LABEL[value] ?? value;
			if (Array.isArray(snapshot?.warningItems)) {
				return snapshot.warningItems.map((item) => {
					const fam = label(item.family ?? "");
					if (item.kind === "worker_advisor")
						return fill(t("warningWorkerAdvisor"), { family: fam });
					if (item.kind === "worker_reviewer")
						return fill(t("warningWorkerReviewer"), { family: fam });
					if (item.kind === "advisor_reviewer")
						return fill(t("warningAdvisorReviewer"), { family: fam });
					return t("warningInherit");
				});
			}
			const roles = snapshot?.roles;
			const family = (role: ClientRole) => roles?.[role]?.family ?? null;
			const worker = family("worker");
			const advisor = family("advisor");
			const reviewer = family("reviewer");
			const out = [];
			if (worker !== null && advisor !== null && worker === advisor) {
				out.push(fill(t("warningWorkerAdvisor"), { family: label(worker) }));
			}
			if (worker !== null && reviewer !== null && worker === reviewer) {
				out.push(fill(t("warningWorkerReviewer"), { family: label(worker) }));
			}
			if (advisor !== null && reviewer !== null && advisor === reviewer) {
				out.push(fill(t("warningAdvisorReviewer"), { family: label(advisor) }));
			}
			if (worker === null || advisor === null || reviewer === null)
				out.push(t("warningInherit"));
			return out;
		}

		function groupOf(
			catalog: ClientCatalog | null | undefined,
			provider: string,
		) {
			return catalog?.groups?.find((group) => group.id === provider);
		}

		function modelOf(
			catalog: ClientCatalog | null | undefined,
			route?: ClientRoute | null,
		) {
			if (route === null || route === undefined) return undefined;
			return groupOf(catalog, route.provider)?.models?.find(
				(model) => model.id === route.model,
			);
		}

		/** One role row: current model, source, actions. */
		function RoleRow({
			role,
			info,
			catalog,
			t,
			busy,
			onEdit,
			onFallback,
			onReset,
		}: ClientRowProps) {
			const route = info?.route ?? null;
			const group =
				route === null ? undefined : groupOf(catalog, route.provider);
			const model = modelOf(catalog, route);
			const available =
				route === null ||
				(route.runtime && route.runtime !== "native") ||
				(group !== undefined && model !== undefined);
			const sourceKey =
				info?.source === "config"
					? "custom"
					: info?.source === "inherit"
						? "inherit"
						: "recommended";
			return h(
				"div",
				{ className: "dsh-rt-row", "data-role": role },
				h(
					"div",
					{ className: "dsh-rt-role" },
					h("span", {
						className: "dsh-rt-dot",
						style: { background: ROLE_COLOR[role] },
					}),
					h("span", { className: "dsh-rt-role-name" }, ROLE_LABEL[role]),
					info?.family === null || info?.family === undefined
						? null
						: h(
								"span",
								{ className: "dsh-rt-family" },
								FAMILY_LABEL[info.family] ?? info.family,
							),
				),
				h(
					"div",
					{ className: "dsh-rt-value" },
					route === null
						? h(
								"span",
								{ className: "dsh-rt-model dsh-rt-muted" },
								t("inherit"),
							)
						: h(
								"span",
								{ className: "dsh-rt-model" },
								model?.name ?? route.model,
							),
					route === null
						? null
						: h(
								"span",
								{ className: "dsh-rt-route" },
								`${route.runtime && route.runtime !== "native" ? `${route.runtime} · ` : ""}${group?.name ?? route.provider} / ${route.model}${route.reasoningEffort === undefined ? "" : ` · ${route.reasoningEffort}`}`,
							),
					info?.fallbacks !== undefined && info.fallbacks.length > 0
						? h(
								"span",
								{ className: "dsh-rt-route" },
								`${t("fallbacks")}: ${info.fallbacks.map(routeText).join(" -> ")}`,
							)
						: null,
					!available && route !== null
						? h(
								"span",
								{ className: "dsh-rt-warn", title: t("modelUnavailable") },
								t("unavailable"),
							)
						: null,
					info?.problem === undefined
						? null
						: h("span", { className: "dsh-rt-warn" }, info.problem),
					info?.validationError === undefined
						? null
						: h("span", { className: "dsh-rt-warn" }, info.validationError),
				),
				h(
					"div",
					{ className: "dsh-rt-meta" },
					h("span", { className: "dsh-rt-source" }, t(sourceKey)),
				),
				h(
					"div",
					{ className: "dsh-rt-actions" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-btn",
							disabled: busy,
							onClick: () => onEdit(role),
						},
						t("change"),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-btn dsh-rt-btn-quiet",
							disabled: busy,
							onClick: () => onFallback(role),
						},
						t("editFallbacks"),
					),
					info?.source === "default"
						? null
						: h(
								"button",
								{
									type: "button",
									className: "dsh-rt-btn dsh-rt-btn-quiet",
									disabled: busy,
									onClick: () => onReset(role),
								},
								t("reset"),
							),
				),
			);
		}

		/** Modal picker: runtime, provider, model, reasoning effort, inherit. */
		function ModelPicker({
			role,
			info,
			catalog,
			t,
			busy,
			error,
			fallback = false,
			runtimes,
			onRuntime,
			onApply,
			onRemoveFallback,
			onClearFallbacks,
			onInherit,
			onCancel,
		}: ClientPickerProps) {
			const groups = catalog?.groups ?? [];
			const current = fallback
				? (info?.route ?? (info?.fallbacks ?? []).at(-1) ?? null)
				: (info?.route ?? null);
			const currentGroup =
				current === null ? undefined : groupOf(catalog, current.provider);
			const currentModel = modelOf(catalog, current);
			const initialProvider = currentGroup?.id ?? groups[0]?.id ?? "";
			const [runtime, setRuntime] = React.useState(
				current?.runtime ?? "native",
			);
			const external = runtime !== "native";
			const externalCatalog = runtimes?.[runtime];
			const externalModels = externalCatalog?.models ?? [];
			const [provider, setProvider] = React.useState(initialProvider);
			const [model, setModel] = React.useState(
				current !== null &&
					((current.runtime && current.runtime !== "native") ||
						(current.provider === initialProvider &&
							currentModel !== undefined))
					? current.model
					: (groupOf(catalog, initialProvider)?.models?.[0]?.id ?? ""),
			);
			const [effort, setEffort] = React.useState(
				current !== null &&
					((current.runtime && current.runtime !== "native") ||
						(current.provider === initialProvider &&
							currentModel !== undefined))
					? current.reasoningEffort
					: undefined,
			);
			const [query, setQuery] = React.useState("");
			const group = groupOf(catalog, provider);
			const selected = group?.models?.find(
				(candidate) => candidate.id === model,
			);
			const efforts = external ? [] : (selected?.reasoning?.efforts ?? []);
			const needle = query.trim().toLowerCase();
			const visible = (
				external ? externalModels : (group?.models ?? [])
			).filter(
				(candidate) =>
					needle === "" ||
					candidate.name.toLowerCase().includes(needle) ||
					candidate.id.toLowerCase().includes(needle),
			);
			const canApply =
				(external || provider !== "") && model.trim() !== "" && !busy;
			React.useEffect(() => {
				if (external) onRuntime?.(runtime);
			}, [external, runtime, onRuntime]);

			const dialogRef = React.useRef<HTMLDialogElement | null>(null);
			React.useEffect(() => {
				const dialog = dialogRef.current;
				if (dialog !== null && !dialog.open) dialog.showModal();
				return () => {
					if (dialogRef.current?.open) dialogRef.current.close();
				};
			}, []);
			React.useEffect(() => {
				const dialog = dialogRef.current;
				if (dialog === null) return;
				const onCancelEvent = (event: Event) => {
					event.preventDefault();
					if (!busy) onCancel();
				};
				dialog.addEventListener("cancel", onCancelEvent);
				return () => {
					dialog.removeEventListener("cancel", onCancelEvent);
				};
			}, [busy, onCancel]);

			const chooseProvider = (id: string) => {
				if (busy || id === provider) return;
				setProvider(id);
				setModel(groupOf(catalog, id)?.models?.[0]?.id ?? "");
				setEffort(undefined);
			};
			const chooseModel = (id: string) => {
				if (busy) return;
				setModel(id);
				setEffort(undefined);
			};
			const apply = () => {
				if (!canApply) return;
				onApply({
					provider: external ? runtime : provider,
					model: model.trim(),
					...(external ? { runtime } : {}),
					...(typeof effort === "string" && effort !== ""
						? { reasoningEffort: effort }
						: {}),
				});
			};

			return h(
				"dialog",
				{
					className: "dsh-rt-dialog",
					ref: dialogRef,
					"aria-labelledby": "dsh-rt-dialog-title",
					onMouseDown: (
						event: import("react").MouseEvent<HTMLDialogElement>,
					) => {
						if (event.target === event.currentTarget && !busy) onCancel();
					},
				},
				h(
					"div",
					{ className: "dsh-rt-dialog-head" },
					h(
						"h3",
						{ className: "dsh-rt-dialog-title", id: "dsh-rt-dialog-title" },
						fill(t(fallback ? "chooseFallbackTitle" : "chooseTitle"), {
							role: ROLE_LABEL[role] ?? role,
						}),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-close",
							"aria-label": t("close"),
							disabled: busy,
							onClick: onCancel,
						},
						"×",
					),
				),
				h(
					"label",
					{ className: "dsh-rt-runtime" },
					t("runtime"),
					h(
						"select",
						{
							"aria-label": t("runtime"),
							value: runtime,
							disabled: busy,
							onChange: (
								event: import("react").ChangeEvent<
									HTMLInputElement | HTMLSelectElement
								>,
							) => {
								const next = event.target.value;
								setRuntime(next);
								setEffort(undefined);
								if (next === "native" && !selected)
									setModel(group?.models?.[0]?.id ?? "");
							},
						},
						h("option", { value: "native" }, t("runtimeNative")),
						h("option", { value: "cursor" }, "Cursor"),
						h("option", { value: "droid" }, "Factory Droid"),
					),
				),
				h(
					"div",
					{ className: "dsh-rt-dialog-body" },
					fallback
						? h(
								"div",
								{ className: "dsh-rt-fallbacks" },
								h("span", { className: "dsh-rt-effort-label" }, t("fallbacks")),
								(info?.fallbacks ?? []).length === 0
									? h("span", { className: "dsh-rt-note" }, t("noFallbacks"))
									: (info?.fallbacks ?? []).map((route, index) =>
											h(
												"span",
												{
													key: `${routeText(route)}-${index}`,
													className: "dsh-rt-fallback-row",
												},
												h(
													"span",
													{ className: "dsh-rt-route" },
													routeText(route),
												),
												h(
													"button",
													{
														type: "button",
														className: "dsh-rt-btn dsh-rt-btn-quiet",
														disabled: busy,
														onClick: () => onRemoveFallback?.(index),
													},
													t("remove"),
												),
											),
										),
								(info?.fallbacks ?? []).length > 0
									? h(
											"button",
											{
												type: "button",
												className: "dsh-rt-btn dsh-rt-btn-quiet",
												disabled: busy,
												onClick: () => onClearFallbacks?.(),
											},
											t("clearFallbacks"),
										)
									: null,
							)
						: null,
					external
						? null
						: h(
								"div",
								{
									className: "dsh-rt-providers",
									role: "group",
									"aria-label": t("providers"),
								},
								groups.length === 0
									? h("p", { className: "dsh-rt-note" }, t("noProviders"))
									: groups.map((candidate) =>
											h(
												"button",
												{
													key: candidate.id,
													type: "button",
													className: "dsh-rt-provider",
													"aria-pressed": candidate.id === provider,
													disabled: busy,
													onClick: () => chooseProvider(candidate.id),
												},
												candidate.name,
											),
										),
							),
					h(
						"div",
						{ className: "dsh-rt-models" },
						external
							? h(
									"label",
									{ className: "dsh-rt-runtime-model" },
									t("externalModel"),
									h("input", {
										className: "dsh-rt-search",
										autoFocus: true,
										value: model,
										disabled: busy,
										"aria-label": t("externalModel"),
										"aria-describedby": "dsh-rt-runtime-model-hint",
										onChange: (
											event: import("react").ChangeEvent<
												HTMLInputElement | HTMLSelectElement
											>,
										) => {
											setModel(event.target.value);
											setEffort(undefined);
										},
									}),
									h(
										"span",
										{
											id: "dsh-rt-runtime-model-hint",
											className: "dsh-rt-note",
										},
										externalModels.length > 0
											? t("runtimeModels")
											: t("externalModelHint"),
									),
									externalCatalog?.error === undefined
										? null
										: h(
												"span",
												{ className: "dsh-rt-warn" },
												`${t("runtimeModelsError")} ${externalCatalog.error}`,
											),
								)
							: null,
						h("input", {
							className: "dsh-rt-search",
							type: "search",
							autoFocus: !external,
							placeholder: t("search"),
							"aria-label": t("search"),
							value: query,
							disabled: busy || (external ? false : groups.length === 0),
							onChange: (
								event: import("react").ChangeEvent<
									HTMLInputElement | HTMLSelectElement
								>,
							) => setQuery(event.target.value),
						}),
						h(
							"div",
							{
								className: "dsh-rt-model-list",
								role: "group",
								"aria-label": t("models"),
							},
							visible.length === 0
								? h(
										"p",
										{ className: "dsh-rt-note" },
										groups.length === 0 ? t("noProviders") : t("noModels"),
									)
								: visible.map((candidate) =>
										h(
											"button",
											{
												key: candidate.id,
												type: "button",
												className: "dsh-rt-model-option",
												"aria-pressed": candidate.id === model,
												disabled: busy,
												onClick: () => chooseModel(candidate.id),
											},
											h(
												"span",
												{ className: "dsh-rt-model-name" },
												candidate.name,
											),
											candidate.name === candidate.id
												? null
												: h(
														"span",
														{ className: "dsh-rt-model-id" },
														candidate.id,
													),
										),
									),
						),
						efforts.length === 0
							? null
							: h(
									"div",
									{
										className: "dsh-rt-efforts",
										role: "group",
										"aria-label": t("effort"),
									},
									h("span", { className: "dsh-rt-effort-label" }, t("effort")),
									h(
										"button",
										{
											type: "button",
											className: "dsh-rt-effort",
											"aria-pressed": effort === undefined,
											disabled: busy,
											onClick: () => setEffort(undefined),
										},
										t("defaultEffort"),
									),
									efforts.map((candidate) =>
										h(
											"button",
											{
												key: candidate.id,
												type: "button",
												className: "dsh-rt-effort",
												"aria-pressed": effort === candidate.id,
												disabled: busy,
												onClick: () => setEffort(candidate.id),
											},
											candidate.name,
										),
									),
								),
					),
				),
				error === undefined
					? null
					: h(
							"p",
							{ className: "dsh-rt-error dsh-rt-dialog-error", role: "alert" },
							error,
						),
				h(
					"div",
					{ className: "dsh-rt-dialog-foot" },
					onInherit === undefined
						? null
						: h(
								"button",
								{
									type: "button",
									className:
										"dsh-rt-btn dsh-rt-btn-quiet dsh-rt-dialog-foot-left",
									disabled: busy,
									onClick: onInherit,
								},
								t("useInherit"),
							),
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-btn",
							disabled: busy,
							onClick: onCancel,
						},
						t("cancel"),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-btn dsh-rt-btn-primary",
							disabled: !canApply,
							onClick: apply,
						},
						busy ? t("saving") : t("apply"),
					),
				),
			);
		}

		/** The Settings → Models section. */
		function RoleTeamSection(props: ClientSectionProps) {
			const { api, t } = props;
			const [state, setState] = React.useState<{
				status: string;
				snapshot: ClientSnapshot | null;
				catalog: ClientCatalog | null;
				error: string | null;
			}>({ status: "loading", snapshot: null, catalog: null, error: null });
			const [editing, setEditing] = React.useState<{
				role: ClientRole;
				fallback?: boolean;
			} | null>(null);
			const [saving, setSaving] = React.useState(false);
			const [runtimes, setRuntimes] = React.useState<
				Record<string, { models?: ClientModel[]; error?: string }>
			>({});
			const [saveError, setSaveError] = React.useState<string | undefined>(
				undefined,
			);
			const [notice, setNotice] = React.useState("");
			const alive = React.useRef(true);
			const loading = React.useRef(false);
			const loadingRuntimes = React.useRef(new Set<string>());

			const loadRuntime = React.useCallback(
				async (runtime: string) => {
					if (loadingRuntimes.current.has(runtime)) return;
					loadingRuntimes.current.add(runtime);
					try {
						const result = await api.runtimeModels(runtime);
						if (!alive.current) return;
						setRuntimes((previous) => ({ ...previous, [runtime]: result }));
					} catch (error) {
						if (!alive.current) return;
						setRuntimes((previous) => ({
							...previous,
							[runtime]: { error: messageOf(error) },
						}));
					} finally {
						loadingRuntimes.current.delete(runtime);
					}
				},
				[api],
			);

			const load = React.useCallback(
				async (validate = false) => {
					if (loading.current) return;
					loading.current = true;
					setState((previous) => ({
						...previous,
						status: previous.snapshot === null ? "loading" : "refreshing",
						error: null,
					}));
					try {
						const [snapshot, catalog] = await Promise.all([
							api.load(validate),
							api.catalog(),
						]);
						if (!alive.current) return;
						setState({ status: "ready", snapshot, catalog, error: null });
					} catch (error) {
						if (!alive.current) return;
						setState((previous) => ({
							...previous,
							status: previous.snapshot === null ? "error" : "ready",
							error: messageOf(error),
						}));
					} finally {
						loading.current = false;
					}
				},
				[api],
			);

			React.useEffect(() => {
				alive.current = true;
				void load(false);
				return () => {
					alive.current = false;
				};
			}, [load]);

			React.useEffect(
				() =>
					api.onCatalogChange(() => {
						void load(false);
					}),
				[api, load],
			);

			React.useEffect(() => {
				if (notice === "") return;
				const timer = setTimeout(() => {
					setNotice("");
				}, 2400);
				return () => {
					clearTimeout(timer);
				};
			}, [notice]);

			const closePicker = () => {
				if (saving) return;
				setEditing(null);
				setSaveError(undefined);
			};

			const updateFallbacks = async (
				role: ClientRole,
				routes: ClientRoute[],
				close = false,
			) => {
				setSaving(true);
				setSaveError(undefined);
				try {
					const snapshot = await api.saveFallback(role, routes);
					if (!alive.current) return;
					setState((previous) => ({ ...previous, snapshot, status: "ready" }));
					if (close) setEditing(null);
					setNotice(t("saved"));
				} catch (error) {
					if (!alive.current) return;
					setSaveError(messageOf(error));
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const applyRoute = async (route: ClientRoute) => {
				if (editing === null) return;
				if (editing.fallback) {
					await updateFallbacks(
						editing.role,
						[
							...(state.snapshot?.roles?.[editing.role]?.fallbacks ?? []),
							route,
						],
						true,
					);
					return;
				}
				setSaving(true);
				setSaveError(undefined);
				try {
					const snapshot = await api.save(editing.role, route);
					if (!alive.current) return;
					setState((previous) => ({ ...previous, snapshot, status: "ready" }));
					setEditing(null);
					setNotice(t("saved"));
				} catch (error) {
					if (!alive.current) return;
					setSaveError(messageOf(error));
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const applyInherit = async () => {
				if (editing === null || typeof api.inherit !== "function") return;
				setSaving(true);
				setSaveError(undefined);
				try {
					const snapshot = await api.inherit(editing.role);
					if (!alive.current) return;
					setState((previous) => ({ ...previous, snapshot, status: "ready" }));
					setEditing(null);
					setNotice(t("saved"));
				} catch (error) {
					if (!alive.current) return;
					setSaveError(messageOf(error));
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const resetRole = async (role: ClientRole) => {
				setSaving(true);
				setSaveError(undefined);
				try {
					const snapshot = await api.reset(role);
					if (!alive.current) return;
					setState((previous) => ({ ...previous, snapshot, status: "ready" }));
					setNotice(t("saved"));
				} catch (error) {
					if (!alive.current) return;
					setSaveError(messageOf(error));
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const updateLimit = async (
				key: "maxRounds" | "maxPlanPasses" | "childMaxDepth",
				rawValue: string,
				min: number,
				max: number,
			) => {
				const trimmed = rawValue.trim();
				if (trimmed === "") return;
				const value = Number(trimmed);
				if (
					typeof api.saveConfig !== "function" ||
					!Number.isInteger(value) ||
					value < min ||
					value > max
				) {
					return;
				}
				setSaving(true);
				setSaveError(undefined);
				try {
					const snapshot = await api.saveConfig({ [key]: value });
					if (!alive.current) return;
					setState((previous) => ({ ...previous, snapshot, status: "ready" }));
					setNotice(t("saved"));
				} catch (error) {
					if (!alive.current) return;
					setSaveError(messageOf(error));
				} finally {
					if (alive.current) setSaving(false);
				}
			};

			const snapshot = state.snapshot;
			const warnings = independenceWarnings(snapshot, t);
			const body =
				state.status === "loading"
					? h(
							"p",
							{ className: "dsh-rt-loading", role: "status" },
							t("loading"),
						)
					: state.status === "error"
						? h(
								React.Fragment,
								null,
								h(
									"p",
									{ className: "dsh-rt-error", role: "alert" },
									`${t("loadError")} ${state.error ?? ""}`,
								),
								h(
									"button",
									{
										type: "button",
										className: "dsh-rt-btn dsh-rt-retry",
										onClick: () => {
											void load(true);
										},
									},
									t("retry"),
								),
							)
						: snapshot === null
							? null
							: h(
									React.Fragment,
									null,
									h(
										"div",
										{ className: "dsh-rt-card" },
										ROLES.map((role) =>
											h(RoleRow, {
												key: role,
												role,
												info: snapshot.roles?.[role],
												catalog: state.catalog,
												t,
												busy: saving,
												onEdit: (selected) => {
													setEditing({ role: selected });
													setSaveError(undefined);
												},
												onFallback: (selected) => {
													setEditing({ role: selected, fallback: true });
													setSaveError(undefined);
												},
												onReset: (roleName) => {
													void resetRole(roleName);
												},
											}),
										),
									),
									typeof snapshot.maxRounds === "number"
										? h(
												"div",
												{
													className: "dsh-rt-limits",
													role: "group",
													"aria-label": t("limitsTitle"),
												},
												h(
													"label",
													{ className: "dsh-rt-limit-item" },
													t("maxRoundsLabel"),
													h("input", {
														type: "number",
														min: 1,
														max: 6,
														className: "dsh-rt-limit-input",
														value: String(snapshot.maxRounds),
														disabled: saving,
														onChange: (
															e: import("react").ChangeEvent<HTMLInputElement>,
														) => {
															void updateLimit(
																"maxRounds",
																e.target.value,
																1,
																6,
															);
														},
													}),
												),
												typeof snapshot.maxPlanPasses === "number"
													? h(
															"label",
															{ className: "dsh-rt-limit-item" },
															t("maxPlanPassesLabel"),
															h("input", {
																type: "number",
																min: 1,
																max: 3,
																className: "dsh-rt-limit-input",
																value: String(snapshot.maxPlanPasses),
																disabled: saving,
																onChange: (
																	e: import("react").ChangeEvent<HTMLInputElement>,
																) => {
																	void updateLimit(
																		"maxPlanPasses",
																		e.target.value,
																		1,
																		3,
																	);
																},
															}),
														)
													: null,
												typeof snapshot.childMaxDepth === "number"
													? h(
															"label",
															{ className: "dsh-rt-limit-item" },
															t("childMaxDepthLabel"),
															h("input", {
																type: "number",
																min: 0,
																max: 8,
																className: "dsh-rt-limit-input",
																value: String(snapshot.childMaxDepth),
																disabled: saving,
																onChange: (
																	e: import("react").ChangeEvent<HTMLInputElement>,
																) => {
																	void updateLimit(
																		"childMaxDepth",
																		e.target.value,
																		0,
																		8,
																	);
																},
															}),
														)
													: null,
											)
										: null,
									warnings.length === 0
										? null
										: h(
												"ul",
												{
													className: "dsh-rt-warnings",
													"aria-label": t("warnings"),
												},
												warnings.map((warning, index) =>
													h(
														"li",
														{ key: index, className: "dsh-rt-warning" },
														warning,
													),
												),
											),
									saveError === undefined || editing !== null
										? null
										: h(
												"p",
												{ className: "dsh-rt-error", role: "alert" },
												`${t("saveError")} ${saveError}`,
											),
									notice === ""
										? null
										: h(
												"p",
												{ className: "dsh-rt-status", role: "status" },
												notice,
											),
								);

			return h(
				"section",
				{ className: "dsh-rt-section", "data-plugin": "role-team" },
				h(
					"div",
					{ className: "dsh-rt-head" },
					h(
						"div",
						null,
						h("h2", { className: "dsh-rt-title" }, t("title")),
						h("p", { className: "dsh-rt-intro" }, t("intro")),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-rt-refresh",
							disabled:
								saving ||
								state.status === "loading" ||
								state.status === "refreshing",
							onClick: () => {
								void load(true);
							},
						},
						t("refresh"),
					),
				),
				body,
				editing === null
					? null
					: h(ModelPicker, {
							key: `${editing.role}-${editing.fallback ? "fallback" : "primary"}`,
							role: editing.role,
							info: snapshot?.roles?.[editing.role],
							catalog: state.catalog,
							t,
							busy: saving,
							error: saveError,
							fallback: editing.fallback === true,
							runtimes,
							onRuntime: (runtime) => {
								void loadRuntime(runtime);
							},
							onApply: (route) => {
								void applyRoute(route);
							},
							onRemoveFallback: (index) => {
								if (editing === null) return;
								const chain = snapshot?.roles?.[editing.role]?.fallbacks ?? [];
								void updateFallbacks(
									editing.role,
									chain.filter((_route, position) => position !== index),
								);
							},
							onClearFallbacks: () => {
								if (editing === null) return;
								void updateFallbacks(editing.role, []);
							},
							onInherit:
								editing.fallback === true
									? undefined
									: typeof api.inherit === "function"
										? () => {
												void applyInherit();
											}
										: undefined,
							onCancel: closePicker,
						}),
			);
		}

		/** The role tools this browser half renders as dedicated cards. */
		const TOOL_KEYS = [
			"roles_run",
			"roles_start",
			"roles_status",
			"roles_cancel",
			"role_plan",
			"role_worker",
			"role_advisor",
			"role_reviewer",
		];

		/**
		 * Read the `task`, `question`, or `run_id` argument out of a tool call's raw arguments.
		 */
		function taskOf(block: ClientToolBlock | null | undefined) {
			try {
				const call =
					block !== null && typeof block === "object" && "kind" in block
						? block.call
						: block;
				if (
					call === null ||
					call === undefined ||
					typeof call.argsRaw !== "string"
				)
					return "";
				const parsed = JSON.parse(call.argsRaw);
				if (typeof parsed?.task === "string" && parsed.task !== "")
					return parsed.task;
				if (typeof parsed?.question === "string" && parsed.question !== "")
					return parsed.question;
				if (typeof parsed?.run_id === "string" && parsed.run_id !== "")
					return parsed.run_id;
				return "";
			} catch {
				return "";
			}
		}

		/** First text block of a settled result, for the plain-text fallback. */
		function rawTextOf(block: ClientToolBlock | null | undefined) {
			const content = Array.isArray(block?.content) ? block.content : [];
			const first = content.find(
				(part): part is { type: "text"; text: string } =>
					isItem(part) && part.type === "text" && typeof part.text === "string",
			);
			const text = first === undefined ? "" : first.text;
			return text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text;
		}

		/** Locale keys for the user's exhaustion decisions. */
		const DECISION_KEYS: Record<string, string> = {
			continue: "decisionContinue",
			retry: "decisionRetry",
			model: "decisionModel",
			stop: "decisionStop",
			none: "decisionNone",
		};

		/** Locale keys for verdict severities. */
		const SEVERITY_KEYS: Record<string, string> = {
			blocker: "severityBlocker",
			major: "severityMajor",
			minor: "severityMinor",
		};

		function isItem(value: unknown): value is ClientItem {
			return (
				value !== null && typeof value === "object" && !Array.isArray(value)
			);
		}

		const TERMINAL_STATUSES = [
			"approved",
			"unapproved",
			"continued",
			"failed",
			"cancelled",
		];

		/**
		 * Poll the live run state of one call while it is running (including
		 * collapsed `roles_start` cards so the header status pill updates when the
		 * background run completes). Pauses while the document is hidden.
		 */
		function useRunState(
			callId: string | undefined,
			active: boolean,
			expanded: boolean,
		) {
			const [run, setRun] = React.useState<ClientItem | null>(null);
			React.useEffect(() => {
				if (!active || !callId) return undefined;
				let alive = true;
				let failures = 0;
				let timer: ReturnType<typeof setInterval> | null = null;
				const stop = () => {
					if (timer !== null) clearInterval(timer);
					timer = null;
				};
				const load = async () => {
					if (!alive) return;
					if (typeof document !== "undefined" && document.hidden === true)
						return;
					try {
						const response = await fetch(
							`/plugin-api/role-team/run/${encodeURIComponent(callId)}`,
							{
								credentials: "same-origin",
								headers: { accept: "application/json" },
							},
						);
						if (!response.ok) {
							failures += 1;
							if (failures >= 3) stop();
							return;
						}
						const data = (await response.json()) as {
							ok: boolean;
							run: ClientItem;
						};
						if (alive && data && data.ok) {
							failures = 0;
							setRun(data.run);
							if (TERMINAL_STATUSES.includes(String(data.run?.status))) {
								stop();
							}
						}
					} catch {
						failures += 1;
						if (failures >= 3) stop();
					}
				};
				void load();
				timer = setInterval(
					() => {
						void load();
					},
					expanded ? 2500 : 4000,
				);
				const onVisibilityChange = () => {
					if (typeof document !== "undefined" && !document.hidden) {
						void load();
					}
				};
				if (
					typeof document !== "undefined" &&
					typeof document.addEventListener === "function"
				) {
					document.addEventListener("visibilitychange", onVisibilityChange);
				}
				return () => {
					alive = false;
					stop();
					if (
						typeof document !== "undefined" &&
						typeof document.removeEventListener === "function"
					) {
						document.removeEventListener(
							"visibilitychange",
							onVisibilityChange,
						);
					}
				};
			}, [callId, active, expanded]);
			return run;
		}

		const STATUS_TO_LOCALE_KEY: Record<string, string> = {
			running: "running",
			cancelling: "cancelling",
			cancelled: "cancelled",
			failed: "failed",
			approved: "approved",
			continued: "continued",
			unapproved: "notApproved",
		};

		/** Explicit FSM status projection for a role tool card header pill. */
		function deriveToolCardStatus({
			preparing,
			inFlight,
			isError,
			activePhase,
			verdict,
			meta,
		}: {
			preparing: boolean;
			inFlight: boolean;
			isError: boolean;
			activePhase: unknown;
			verdict: ClientItem | null;
			meta: ClientItem | null;
		}): string {
			if (preparing) return "preparing";
			if (isError) return "failed";
			const metaStatus =
				meta !== null && typeof meta.status === "string" ? meta.status : "";
			if (TERMINAL_STATUSES.includes(metaStatus)) {
				return STATUS_TO_LOCALE_KEY[metaStatus] ?? "finished";
			}
			if (activePhase === "awaiting_user") return "awaitingUser";
			if (inFlight) return "running";
			if (verdict !== null) return verdict.approved ? "approved" : "changes";
			if (meta === null) return "finished";
			return STATUS_TO_LOCALE_KEY[metaStatus] ?? "finished";
		}

		/** The dedicated chat-timeline card for one role tool call. */
		function RoleToolRow(props: ClientToolProps) {
			const { toolName, block, useDisclosure } = props;
			const t = typeof props.t === "function" ? props.t : (key: string) => key;
			const callId = props.callId;
			const [fallbackExpanded, setFallbackExpanded] = React.useState(false);
			const disclosure =
				typeof useDisclosure === "function"
					? useDisclosure()
					: {
							expanded: fallbackExpanded,
							toggle: () => setFallbackExpanded((value) => !value),
						};
			const bodyId = `dsh-rt-body-${typeof callId === "string" && callId !== "" ? callId : toolName}`;
			const settled =
				block !== null && typeof block === "object" && "kind" in block;
			const preparing = !settled && block?.phase !== "start";
			const inFlight = !settled && !preparing;
			const isError = settled && block.isError === true;
			const storedMeta =
				settled && !isError && isItem(block.meta) && block.meta.v === 1
					? block.meta
					: null;
			const background =
				storedMeta !== null && typeof storedMeta.runId === "string";
			const backgroundInitiallyActive =
				background &&
				["running", "cancelling"].includes(String(storedMeta.status));
			// Poll background runs even when collapsed until they reach a terminal state,
			// and poll foreground in-flight runs when expanded.
			const live = useRunState(
				background ? (storedMeta.runId as string) : callId,
				backgroundInitiallyActive || (inFlight && disclosure.expanded),
				disclosure.expanded,
			);
			const meta =
				storedMeta !== null
					? background && live !== null
						? { ...storedMeta, ...live }
						: storedMeta
					: live;
			const task =
				taskOf(block) || (typeof meta?.task === "string" ? meta.task : "");
			const stages = (
				meta !== null && Array.isArray(meta.stages)
					? meta.stages
					: live !== null && Array.isArray(live.stages)
						? live.stages
						: []
			).filter(isItem);
			const verdict =
				meta !== null && isItem(meta.verdict) ? meta.verdict : null;
			const comments = (
				meta !== null && Array.isArray(meta.comments) ? meta.comments : []
			).filter(isItem);
			if (comments.length === 0 && verdict !== null) {
				comments.push({
					role:
						typeof meta?.role === "string"
							? meta?.role
							: toolName.replace(/^role_/, ""),
					stage: "",
					route: meta?.route,
					approved: verdict.approved === true,
					summary: typeof verdict.summary === "string" ? verdict.summary : "",
					issues: Array.isArray(verdict.issues)
						? verdict.issues.filter(isItem)
						: [],
				});
			}
			const decisions = (
				meta !== null && Array.isArray(meta.decisions) ? meta.decisions : []
			).filter(isItem);

			const activePhase = meta?.phase ?? live?.phase;
			const statusKey = deriveToolCardStatus({
				preparing,
				inFlight,
				isError,
				activePhase,
				verdict,
				meta,
			});
			const pillClass =
				statusKey === "approved"
					? "dsh-rt-pill dsh-rt-pill-ok"
					: statusKey === "failed"
						? "dsh-rt-pill dsh-rt-pill-err"
						: statusKey === "preparing" || statusKey === "running"
							? "dsh-rt-pill dsh-rt-pill-run"
							: statusKey === "awaitingUser" ||
								  statusKey === "changes" ||
								  statusKey === "notApproved" ||
								  statusKey === "continued"
								? "dsh-rt-pill dsh-rt-pill-warn"
								: "dsh-rt-pill";
			const teamTool = toolName.startsWith("roles_");
			const role = teamTool ? "plan" : toolName.replace(/^role_/, "");
			const headerRoles = teamTool ? ROLES : [role];
			const title = teamTool
				? t("runTitle")
				: `${t("runTitle")} · ${ROLE_LABEL[role] ?? toolName}`;

			const routeText = (route: unknown) =>
				route == null || !isItem(route)
					? t("inheritRoute")
					: `${route.runtime && route.runtime !== "native" ? `${stringValue(route.runtime)}:` : ""}${stringValue(route.provider)}/${stringValue(route.model)}${route.reasoningEffort === undefined ? "" : ` @${stringValue(route.reasoningEffort)}`}`;
			// The running stage wins; otherwise the newest finished stage names the
			// model that produced the visible result.
			const headerStage =
				stages.find((stage) => stage.status === "running") ?? stages.at(-1);
			const headerRoute =
				headerStage !== undefined && isItem(headerStage.route)
					? routeText(headerStage.route)
					: "";

			const severityText = (severity: unknown) => {
				const key = SEVERITY_KEYS[stringValue(severity ?? "").toLowerCase()];
				return key === undefined ? stringValue(severity ?? "major") : t(key);
			};

			const decisionText = (decision: ClientItem) => {
				const key = DECISION_KEYS[stringValue(decision.choice ?? "")];
				const choice =
					key === undefined ? stringValue(decision.choice ?? "") : t(key);
				const route = isItem(decision.route)
					? ` → ${routeText(decision.route)}`
					: "";
				const note =
					typeof decision.note === "string" && decision.note !== ""
						? ` (${decision.note})`
						: "";
				return `${choice}${route}${note}`;
			};

			const canCancelBackground =
				background &&
				typeof meta?.runId === "string" &&
				meta.status === "running";
			const requestCancel = () => {
				if (!canCancelBackground || typeof meta?.runId !== "string") return;
				void fetch(
					`/plugin-api/role-team/run/${encodeURIComponent(meta.runId)}?action=cancel`,
					{
						method: "POST",
						credentials: "same-origin",
						headers: {
							accept: "application/json",
							"x-role-team-request": "1",
						},
					},
				);
			};

			const childActivity =
				isItem(meta?.child) && typeof meta.child.activity === "string"
					? meta.child.activity
					: "";

			const body = disclosure.expanded
				? h(
						"div",
						{ className: "dsh-rt-tool-body", id: bodyId },
						task !== "" || canCancelBackground
							? h(
									"div",
									{ className: "dsh-rt-tool-bar" },
									task !== ""
										? h("p", { className: "dsh-rt-tool-task-full" }, task)
										: h("span", null),
									canCancelBackground
										? h(
												"button",
												{
													type: "button",
													className: "dsh-rt-btn dsh-rt-btn-quiet",
													onClick: requestCancel,
												},
												t("cancelRun"),
											)
										: null,
								)
							: null,
						typeof meta?.progress === "string"
							? h(
									"p",
									{ className: "dsh-rt-muted-line" },
									childActivity
										? `${meta.progress} (${childActivity})`
										: meta.progress,
								)
							: null,
						stages.length > 0
							? h(
									"div",
									null,
									h(
										"div",
										{ className: "dsh-rt-section-label" },
										t("pipeline"),
									),
									h(
										"div",
										{ className: "dsh-rt-stages" },
										stages.map((stage, index) => {
											const durationLabel = formatShortDuration(
												stage.durationMs,
											);
											return h(
												"span",
												{
													key: index,
													className: "dsh-rt-stage",
													"data-active":
														stage.status === "running" ? "true" : "false",
													...(stage.status === "running"
														? { "aria-current": "step" }
														: {}),
												},
												h("span", {
													className: "dsh-rt-dot",
													style: {
														background:
															ROLE_COLOR[String(stage.role)] ??
															"var(--dsw-alias-label-tertiary)",
													},
												}),
												ROLE_LABEL[String(stage.role)] ?? String(stage.role),
												h(
													"span",
													{ className: "dsh-rt-stage-route" },
													routeText(stage.route),
												),
												durationLabel !== ""
													? h(
															"span",
															{ className: "dsh-rt-stage-time" },
															durationLabel,
														)
													: null,
											);
										}),
									),
								)
							: inFlight
								? h(
										"p",
										{ className: "dsh-rt-muted-line" },
										t("liveUnavailable"),
									)
								: null,
						comments.length > 0
							? h(
									"div",
									null,
									h(
										"div",
										{ className: "dsh-rt-section-label" },
										t("comments"),
									),
									comments.map((comment, index) =>
										h(
											"div",
											{ key: index, className: "dsh-rt-comment" },
											h(
												"div",
												{ className: "dsh-rt-comment-head" },
												h(
													"span",
													{ className: "dsh-rt-comment-role" },
													h("span", {
														className: "dsh-rt-dot",
														style: {
															background:
																ROLE_COLOR[String(comment.role)] ??
																"var(--dsw-alias-label-tertiary)",
														},
													}),
													ROLE_LABEL[String(comment.role)] ??
														String(comment.role),
													h(
														"span",
														{ className: "dsh-rt-stage-route" },
														routeText(comment.route),
													),
												),
												typeof comment.stage === "string" &&
													comment.stage !== ""
													? h(
															"span",
															{ className: "dsh-rt-comment-stage" },
															comment.stage,
														)
													: null,
												h(
													"span",
													{
														className: comment.approved
															? "dsh-rt-pill dsh-rt-pill-ok"
															: "dsh-rt-pill dsh-rt-pill-warn",
													},
													comment.approved ? t("approved") : t("changes"),
												),
											),
											typeof comment.summary === "string" &&
												comment.summary !== ""
												? h(
														"p",
														{ className: "dsh-rt-comment-summary" },
														comment.summary,
													)
												: null,
											Array.isArray(comment.issues) && comment.issues.length > 0
												? h(
														"ul",
														{ className: "dsh-rt-issues" },
														comment.issues
															.filter(isItem)
															.map((issue, issueIndex) =>
																h(
																	"li",
																	{
																		key: issueIndex,
																		className: "dsh-rt-issue",
																	},
																	`[${severityText(issue.severity)}] ${typeof issue.detail === "string" ? issue.detail : ""}`,
																),
															),
													)
												: null,
										),
									),
								)
							: null,
						decisions.length > 0
							? h(
									"div",
									null,
									h(
										"div",
										{ className: "dsh-rt-section-label" },
										t("decisions"),
									),
									h(
										"ul",
										{ className: "dsh-rt-decisions" },
										decisions.map((decision, index) =>
											h(
												"li",
												{ key: index, className: "dsh-rt-decision" },
												decisionText(decision),
											),
										),
									),
								)
							: null,
						settled
							? h(
									"div",
									null,
									meta === null
										? h("p", { className: "dsh-rt-muted-line" }, t("noMeta"))
										: null,
									h(
										"details",
										null,
										h(
											"summary",
											{ className: "dsh-rt-raw-summary" },
											t("rawReport"),
										),
										h(
											"pre",
											{ className: "dsh-rt-raw" },
											rawTextOf(
												background && typeof meta?.text === "string"
													? { content: [{ type: "text", text: meta.text }] }
													: block,
											) || t("noReport"),
										),
									),
								)
							: null,
					)
				: null;

			return h(
				"div",
				{
					className: "dsh-rt-tool",
					"data-plugin": "role-team",
					"data-phase": preparing ? "preparing" : settled ? "result" : "start",
				},
				h(
					"button",
					{
						type: "button",
						className: "dsh-rt-tool-head",
						"aria-expanded": disclosure.expanded ? "true" : "false",
						"aria-controls": bodyId,
						onClick: disclosure.toggle,
					},
					h(
						"span",
						{ className: "dsh-rt-tool-dots" },
						headerRoles.map((headerRole) =>
							h("span", {
								key: headerRole,
								className: "dsh-rt-dot",
								style: {
									background:
										ROLE_COLOR[headerRole] ?? "var(--dsw-alias-label-tertiary)",
								},
							}),
						),
					),
					h("span", { className: "dsh-rt-tool-title" }, title),
					headerRoute === ""
						? null
						: h(
								"span",
								{ className: "dsh-rt-tool-route", title: headerRoute },
								headerRoute,
							),
					h(
						"span",
						{ className: pillClass, "aria-live": "polite" },
						t(statusKey),
					),
					task === ""
						? null
						: h("span", { className: "dsh-rt-tool-task", title: task }, task),
					h(
						"span",
						{
							className: "dsh-rt-chevron",
							"data-open": disclosure.expanded ? "true" : "false",
							"aria-hidden": "true",
						},
						"▸",
					),
				),
				body,
			);
		}

		return {
			inject: ["slots", "locale", "remote", "remote.session", "uiWorkspace"],
			apply(ctx: ClientContext) {
				ctx.effect(
					() => ctx.locale.register(NS, { en, ru, zh }),
					"role-team: dictionaries",
				);
				ctx.effect(() => {
					for (const previous of document.querySelectorAll(
						'style[data-dsh-plugin="role-team"]',
					))
						previous.remove();
					const style = document.createElement("style");
					style.dataset.dshPlugin = "role-team";
					style.textContent = CSS;
					document.head.append(style);
					return () => {
						style.remove();
					};
				}, "role-team: styles");
				ctx.effect(() => {
					if (typeof ctx.remote?.$on !== "function") return () => {};
					let stop;
					try {
						stop = ctx.remote.$on("api-session/added", (summary) => {
							const sessionId =
								typeof summary === "string"
									? summary
									: summary !== null &&
										  typeof summary === "object" &&
										  typeof (summary as ClientItem).sessionId === "string"
										? ((summary as ClientItem).sessionId as string)
										: "";
							if (sessionId !== "") void openPlanSession(ctx, sessionId);
						});
					} catch {
						return () => {};
					}
					return typeof stop === "function" ? stop : () => {};
				}, "role-team: plan session navigation");
				const api = createApi(ctx);
				const t = ctx.locale.bind(NS);
				ctx.slots.inject("settings.models.footer", () =>
					ctx.slots.register(
						{
							name: "settings.models.footer",
							id: "role-team",
							order: 20,
							locale: NS,
							inject: () => ({ api, t }),
						},
						RoleTeamSection,
					),
				);
				ctx.slots.inject("tool.call.toolview", function* () {
					for (const key of TOOL_KEYS) {
						yield ctx.slots.register(
							{ name: "tool.call.toolview", key, locale: NS },
							RoleToolRow,
						);
					}
				});
			},
		};
	},
});
