/**
 * Browser half of `@local/dsh-role-team`.
 *
 * Adds the Role team section to **Settings → Models**: four role rows with
 * the model each role currently uses, a provider/model picker backed by the
 * live adapter catalogue, reasoning-effort selection, per-role reset, and the
 * same cross-family independence warnings the `/roles doctor` command prints.
 *
 * The page talks to the Host half through one same-origin JSON route. Model
 * choices come from the shared `remote.session.modelCatalog()` directory, so
 * only providers the running profile can actually route are offered.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-role-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Same-origin route served by the Host half. */
    const ROUTE = '/plugin-api/role-team/roles'
    /** Locale namespace owned by this plugin. */
    const NS = 'roleTeam'
    /** The four roles, in pipeline order. */
    const ROLES = ['plan', 'worker', 'advisor', 'reviewer']
    const ROLE_LABEL = { plan: 'PLAN', worker: 'WORKER', advisor: 'ADVISOR', reviewer: 'REVIEWER' }
    const ROLE_COLOR = {
      plan: '#f0b451',
      worker: '#2f7fc1',
      advisor: '#3fa46a',
      reviewer: '#7b62c9',
    }
    const FAMILY_LABEL = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      google: 'Google',
      zai: 'Z.AI / GLM',
      deepseek: 'DeepSeek',
      qwen: 'Qwen',
      moonshot: 'Moonshot',
      xai: 'xAI',
      minimax: 'MiniMax',
      meta: 'Meta',
      mistral: 'Mistral',
    }

    const en = {
      title: 'Role team',
      intro: 'Choose the model each role uses. Changes apply to the next role run; the /roles command in chat changes the same setting.',
      refresh: 'Refresh',
      loading: 'Loading role settings…',
      loadError: 'Could not load role settings.',
      retry: 'Try again',
      saveError: 'Could not save the role route.',
      noProviders: 'No routable provider is available. Configure a provider under Models first.',
      change: 'Change',
      reset: 'Reset',
      recommended: 'Recommended',
      custom: 'Custom',
      inherit: 'Inherits the session model',
      unavailable: 'not currently available',
      chooseTitle: 'Choose the model for {role}',
      search: 'Search models',
      providers: 'Providers',
      models: 'Models',
      noModels: 'No models match.',
      effort: 'Reasoning effort',
      defaultEffort: 'Default',
      cancel: 'Cancel',
      apply: 'Apply',
      saving: 'Saving…',
      saved: 'Saved',
      close: 'Close',
      warnings: 'Independence',
      warningWorkerAdvisor: 'WORKER and ADVISOR both use the {family} family; the advisor\'s independence is weaker.',
      warningWorkerReviewer: 'WORKER and REVIEWER both use the {family} family; the final gate is not independent.',
      warningAdvisorReviewer: 'ADVISOR and REVIEWER both use the {family} family; the final gate is not independent from the advisor.',
      warningInherit: 'At least one of WORKER, ADVISOR or REVIEWER inherits the session model, so cross-family independence is not guaranteed.',
      chooseEffort: 'Effort',
      modelUnavailable: 'This route is not advertised by any routable provider right now. Pick another model or reset the role.',
      runTitle: 'Role team',
      preparing: 'Preparing…',
      running: 'Running…',
      pipeline: 'Pipeline',
      comments: 'ADVISOR and REVIEWER comments',
      approved: 'Approved',
      changes: 'Changes required',
      continued: 'Continued without approval',
      notApproved: 'Not approved',
      failed: 'Failed',
      decisions: 'Decisions',
      inheritRoute: 'session model',
      noMeta: 'Structured details are unavailable; showing the raw report.',
      rawReport: 'Raw report',
    }

    const ru = {
      title: 'Команда ролей',
      intro: 'Выберите модель для каждой роли. Изменения применяются со следующего запуска ролей; команда /roles в чате меняет ту же настройку.',
      refresh: 'Обновить',
      loading: 'Загружаю настройки ролей…',
      loadError: 'Не удалось загрузить настройки ролей.',
      retry: 'Повторить',
      saveError: 'Не удалось сохранить маршрут роли.',
      noProviders: 'Нет доступных провайдеров. Сначала настройте провайдера в разделе «Модели».',
      change: 'Изменить',
      reset: 'Сбросить',
      recommended: 'Рекомендуемая',
      custom: 'Своя',
      inherit: 'Наследует модель сессии',
      unavailable: 'сейчас недоступна',
      chooseTitle: 'Выберите модель для {role}',
      search: 'Поиск моделей',
      providers: 'Провайдеры',
      models: 'Модели',
      noModels: 'Нет подходящих моделей.',
      effort: 'Уровень рассуждений',
      defaultEffort: 'По умолчанию',
      cancel: 'Отмена',
      apply: 'Применить',
      saving: 'Сохраняю…',
      saved: 'Сохранено',
      close: 'Закрыть',
      warnings: 'Независимость',
      warningWorkerAdvisor: 'WORKER и ADVISOR используют одно семейство {family}; независимость советника слабее.',
      warningWorkerReviewer: 'WORKER и REVIEWER используют одно семейство {family}; финальный контроль не независим.',
      warningAdvisorReviewer: 'ADVISOR и REVIEWER используют одно семейство {family}; финальный контроль не независим от советника.',
      warningInherit: 'Хотя бы одна из ролей WORKER, ADVISOR или REVIEWER наследует модель сессии, поэтому независимость семейств не гарантирована.',
      chooseEffort: 'Усилие',
      modelUnavailable: 'Этот маршрут сейчас не предлагается ни одним доступным провайдером. Выберите другую модель или сбросьте роль.',
      runTitle: 'Команда ролей',
      preparing: 'Подготовка…',
      running: 'Выполняется…',
      pipeline: 'Конвейер',
      comments: 'Замечания ADVISOR и REVIEWER',
      approved: 'Одобрено',
      changes: 'Нужны правки',
      continued: 'Продолжено без одобрения',
      notApproved: 'Не одобрено',
      failed: 'Ошибка',
      decisions: 'Решения',
      inheritRoute: 'модель сессии',
      noMeta: 'Структурированные данные недоступны; показан исходный отчёт.',
      rawReport: 'Исходный отчёт',
    }

    const zh = {
      title: '角色团队',
      intro: '为每个角色选择模型。更改会应用于下一次角色运行；聊天中的 /roles 命令修改的是同一设置。',
      refresh: '刷新',
      loading: '正在加载角色设置…',
      loadError: '无法加载角色设置。',
      retry: '重试',
      saveError: '无法保存角色路由。',
      noProviders: '没有可路由的提供商。请先在“模型”中配置提供商。',
      change: '更改',
      reset: '重置',
      recommended: '推荐',
      custom: '自定义',
      inherit: '继承会话模型',
      unavailable: '当前不可用',
      chooseTitle: '为 {role} 选择模型',
      search: '搜索模型',
      providers: '提供商',
      models: '模型',
      noModels: '没有匹配的模型。',
      effort: '推理强度',
      defaultEffort: '默认',
      cancel: '取消',
      apply: '应用',
      saving: '正在保存…',
      saved: '已保存',
      close: '关闭',
      warnings: '独立性',
      warningWorkerAdvisor: 'WORKER 和 ADVISOR 都使用 {family} 系列；ADVISOR 的独立性较弱。',
      warningWorkerReviewer: 'WORKER 和 REVIEWER 都使用 {family} 系列；最终关卡不独立。',
      warningAdvisorReviewer: 'ADVISOR 和 REVIEWER 都使用 {family} 系列；最终关卡不独立于 ADVISOR。',
      warningInherit: 'WORKER、ADVISOR 或 REVIEWER 中至少有一个继承会话模型，因此无法保证跨系列独立性。',
      chooseEffort: '强度',
      modelUnavailable: '当前没有可路由的提供商提供此路由。请选择其他模型或重置该角色。',
      runTitle: '角色团队',
      preparing: '准备中…',
      running: '运行中…',
      pipeline: '流水线',
      comments: 'ADVISOR 和 REVIEWER 的意见',
      approved: '已通过',
      changes: '需要修改',
      continued: '未经批准继续',
      notApproved: '未通过',
      failed: '失败',
      decisions: '决定',
      inheritRoute: '会话模型',
      noMeta: '结构化数据不可用；显示原始报告。',
      rawReport: '原始报告',
    }

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
.dsh-rt-effort-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); margin-right: 2px; }
.dsh-rt-effort {
  box-sizing: border-box; height: 26px; padding: 0 9px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-rt-effort[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.dsh-rt-effort:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
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
  box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; width: 100%;
  padding: 9px 12px; border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-settings-card-fill);
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
@media (hover: hover) { .dsh-rt-tool:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dsh-rt-tool:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dsh-rt-tool-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-rt-tool-dots { display: inline-flex; align-items: center; gap: 3px; flex: none; }
.dsh-rt-tool-title { font-size: 12px; line-height: 18px; font-weight: 600; letter-spacing: .04em; white-space: nowrap; }
.dsh-rt-pill {
  font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dsh-rt-pill-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-rt-pill-warn { color: var(--dsw-alias-state-warn-label); }
.dsh-rt-pill-err { color: var(--dsw-alias-state-error-primary); }
.dsh-rt-tool-task {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-rt-tool-body { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
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
  font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
.dsh-rt-raw {
  margin: 0; padding: 9px 11px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto;
}
`

    /**
     * Replace `{name}` placeholders in localized copy.
     * @param {string} text template
     * @param {Record<string, string> | undefined} params values
     * @returns {string} rendered text
     */
    function fill(text, params) {
      if (params === undefined) return text
      let out = text
      for (const [key, value] of Object.entries(params)) out = out.split(`{${key}}`).join(String(value))
      return out
    }

    /**
     * Render a thrown value without trusting coercion.
     * @param {unknown} error thrown value
     * @returns {string} message
     */
    function messageOf(error) {
      if (error instanceof Error && typeof error.message === 'string') return error.message
      try {
        return String(error)
      } catch {
        return 'unknown error'
      }
    }

    /**
     * Build the Host API the page talks to.
     * @param {object} ctx browser plugin context
     * @returns {object} API face
     */
    function createApi(ctx) {
      async function request(method, body) {
        const response = await fetch(ROUTE, {
          method,
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : {
              'content-type': 'application/json',
              'x-role-team-request': '1',
            }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        let data
        try {
          data = await response.json()
        } catch {
          throw new Error(`HTTP ${response.status}`)
        }
        if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`)
        return data
      }
      return {
        load: () => request('GET'),
        save: (role, route) => request('POST', { role, route }),
        reset: role => request('POST', { role, action: 'reset' }),
        async catalog() {
          const response = await ctx.remote.session.modelCatalog()
          if (!response.ok) throw new Error('model catalog is unavailable')
          return response.value
        },
        onCatalogChange(listener) {
          try {
            return ctx.remote.$on('llm/adapters-updated', listener)
          } catch {
            return () => {}
          }
        },
      }
    }

    /**
     * Localized family-independence warnings for the settings rows.
     * @param {object | undefined} roles snapshot roles
     * @param {(key: string, params?: object) => string} t translator
     * @returns {string[]} warnings
     */
    function independenceWarnings(roles, t) {
      const family = role => roles?.[role]?.family ?? null
      const label = value => FAMILY_LABEL[value] ?? value
      const worker = family('worker')
      const advisor = family('advisor')
      const reviewer = family('reviewer')
      const out = []
      if (worker !== null && advisor !== null && worker === advisor) {
        out.push(fill(t('warningWorkerAdvisor'), { family: label(worker) }))
      }
      if (worker !== null && reviewer !== null && worker === reviewer) {
        out.push(fill(t('warningWorkerReviewer'), { family: label(worker) }))
      }
      if (advisor !== null && reviewer !== null && advisor === reviewer) {
        out.push(fill(t('warningAdvisorReviewer'), { family: label(advisor) }))
      }
      if (worker === null || advisor === null || reviewer === null) out.push(t('warningInherit'))
      return out
    }

    /**
     * Find a provider group.
     * @param {object | undefined} catalog model catalog
     * @param {string} provider provider id
     * @returns {object | undefined} group
     */
    function groupOf(catalog, provider) {
      return catalog?.groups?.find(group => group.id === provider)
    }

    /**
     * Find one model inside its provider group.
     * @param {object | undefined} catalog model catalog
     * @param {{ provider: string, model: string } | null | undefined} route route
     * @returns {object | undefined} model
     */
    function modelOf(catalog, route) {
      if (route === null || route === undefined) return undefined
      return groupOf(catalog, route.provider)?.models?.find(model => model.id === route.model)
    }

    /**
     * One role row: current model, source, actions.
     * @param {object} props row props
     * @returns {object} React node
     */
    function RoleRow({ role, info, catalog, t, busy, onEdit, onReset }) {
      const route = info?.route ?? null
      const group = route === null ? undefined : groupOf(catalog, route.provider)
      const model = modelOf(catalog, route)
      const available = route === null || (group !== undefined && model !== undefined)
      const sourceKey = info?.source === 'config' ? 'custom' : info?.source === 'inherit' ? 'inherit' : 'recommended'
      return h('div', { className: 'dsh-rt-row', 'data-role': role },
        h('div', { className: 'dsh-rt-role' },
          h('span', { className: 'dsh-rt-dot', style: { background: ROLE_COLOR[role] } }),
          h('span', { className: 'dsh-rt-role-name' }, ROLE_LABEL[role]),
          info?.family === null || info?.family === undefined
            ? null
            : h('span', { className: 'dsh-rt-family' }, FAMILY_LABEL[info.family] ?? info.family)),
        h('div', { className: 'dsh-rt-value' },
          route === null
            ? h('span', { className: 'dsh-rt-model dsh-rt-muted' }, t('inherit'))
            : h('span', { className: 'dsh-rt-model' }, model?.name ?? route.model),
          route === null
            ? null
            : h('span', { className: 'dsh-rt-route' },
              `${group?.name ?? route.provider} / ${route.model}${route.reasoningEffort === undefined ? '' : ` · ${route.reasoningEffort}`}`),
          !available && route !== null
            ? h('span', { className: 'dsh-rt-warn', title: t('modelUnavailable') }, t('unavailable'))
            : null,
          info?.problem === undefined ? null : h('span', { className: 'dsh-rt-warn' }, info.problem)),
        h('div', { className: 'dsh-rt-meta' }, h('span', { className: 'dsh-rt-source' }, t(sourceKey))),
        h('div', { className: 'dsh-rt-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-rt-btn',
            disabled: busy,
            onClick: () => onEdit(role),
          }, t('change')),
          info?.source === 'default'
            ? null
            : h('button', {
                type: 'button',
                className: 'dsh-rt-btn dsh-rt-btn-quiet',
                disabled: busy,
                onClick: () => onReset(role),
              }, t('reset'))))
    }

    /**
     * Modal picker: provider, model, reasoning effort.
     * @param {object} props picker props
     * @returns {object} React node
     */
    function ModelPicker({ role, info, catalog, t, busy, error, onApply, onCancel }) {
      const groups = catalog?.groups ?? []
      const current = info?.route ?? null
      const currentGroup = current === null ? undefined : groupOf(catalog, current.provider)
      const currentModel = modelOf(catalog, current)
      const initialProvider = currentGroup?.id ?? groups[0]?.id ?? ''
      const [provider, setProvider] = React.useState(initialProvider)
      const [model, setModel] = React.useState(
        current !== null && current.provider === initialProvider && currentModel !== undefined
          ? current.model
          : groupOf(catalog, initialProvider)?.models?.[0]?.id ?? '',
      )
      const [effort, setEffort] = React.useState(
        current !== null && current.provider === initialProvider && currentModel !== undefined
          ? current.reasoningEffort
          : undefined,
      )
      const [query, setQuery] = React.useState('')
      const group = groupOf(catalog, provider)
      const selected = group?.models?.find(candidate => candidate.id === model)
      const efforts = selected?.reasoning?.efforts ?? []
      const needle = query.trim().toLowerCase()
      const visible = (group?.models ?? []).filter(candidate => needle === ''
        || candidate.name.toLowerCase().includes(needle)
        || candidate.id.toLowerCase().includes(needle))
      const canApply = provider !== '' && model !== '' && !busy

      const dialogRef = React.useRef(null)
      React.useEffect(() => {
        const dialog = dialogRef.current
        if (dialog !== null && !dialog.open) dialog.showModal()
        return () => {
          if (dialogRef.current?.open) dialogRef.current.close()
        }
      }, [])
      React.useEffect(() => {
        const dialog = dialogRef.current
        if (dialog === null) return
        const onCancelEvent = event => {
          event.preventDefault()
          if (!busy) onCancel()
        }
        dialog.addEventListener('cancel', onCancelEvent)
        return () => { dialog.removeEventListener('cancel', onCancelEvent) }
      }, [busy, onCancel])

      const chooseProvider = id => {
        if (busy || id === provider) return
        setProvider(id)
        setModel(groupOf(catalog, id)?.models?.[0]?.id ?? '')
        setEffort(undefined)
      }
      const chooseModel = id => {
        if (busy) return
        setModel(id)
        setEffort(undefined)
      }
      const apply = () => {
        if (!canApply) return
        onApply({
          provider,
          model,
          ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
        })
      }

      return h('dialog', {
        className: 'dsh-rt-dialog',
        ref: dialogRef,
        'aria-labelledby': 'dsh-rt-dialog-title',
        onMouseDown: event => { if (event.target === event.currentTarget && !busy) onCancel() },
      },
      h('div', { className: 'dsh-rt-dialog-head' },
        h('h3', { className: 'dsh-rt-dialog-title', id: 'dsh-rt-dialog-title' }, fill(t('chooseTitle'), { role: ROLE_LABEL[role] })),
        h('button', { type: 'button', className: 'dsh-rt-close', 'aria-label': t('close'), disabled: busy, onClick: onCancel }, '×')),
      h('div', { className: 'dsh-rt-dialog-body' },
        h('div', { className: 'dsh-rt-providers', role: 'group', 'aria-label': t('providers') },
          groups.length === 0
            ? h('p', { className: 'dsh-rt-note' }, t('noProviders'))
            : groups.map(candidate => h('button', {
                key: candidate.id,
                type: 'button',
                className: 'dsh-rt-provider',
                'aria-pressed': candidate.id === provider,
                disabled: busy,
                onClick: () => chooseProvider(candidate.id),
              }, candidate.name))),
        h('div', { className: 'dsh-rt-models' },
          h('input', {
            className: 'dsh-rt-search',
            type: 'search',
            autoFocus: true,
            placeholder: t('search'),
            'aria-label': t('search'),
            value: query,
            disabled: busy || groups.length === 0,
            onChange: event => setQuery(event.target.value),
          }),
          h('div', { className: 'dsh-rt-model-list', role: 'group', 'aria-label': t('models') },
            visible.length === 0
              ? h('p', { className: 'dsh-rt-note' }, groups.length === 0 ? t('noProviders') : t('noModels'))
              : visible.map(candidate => h('button', {
                  key: candidate.id,
                  type: 'button',
                  className: 'dsh-rt-model-option',
                  'aria-pressed': candidate.id === model,
                  disabled: busy,
                  onClick: () => chooseModel(candidate.id),
                },
                h('span', { className: 'dsh-rt-model-name' }, candidate.name),
                candidate.name === candidate.id ? null : h('span', { className: 'dsh-rt-model-id' }, candidate.id)))),
          efforts.length === 0 ? null : h('div', { className: 'dsh-rt-efforts', role: 'group', 'aria-label': t('effort') },
            h('span', { className: 'dsh-rt-effort-label' }, t('effort')),
            h('button', {
              type: 'button',
              className: 'dsh-rt-effort',
              'aria-pressed': effort === undefined,
              disabled: busy,
              onClick: () => setEffort(undefined),
            }, t('defaultEffort')),
            efforts.map(candidate => h('button', {
              key: candidate.id,
              type: 'button',
              className: 'dsh-rt-effort',
              'aria-pressed': effort === candidate.id,
              disabled: busy,
              onClick: () => setEffort(candidate.id),
            }, candidate.name))))),
      error === undefined ? null : h('p', { className: 'dsh-rt-error dsh-rt-dialog-error', role: 'alert' }, error),
      h('div', { className: 'dsh-rt-dialog-foot' },
        h('button', { type: 'button', className: 'dsh-rt-btn', disabled: busy, onClick: onCancel }, t('cancel')),
        h('button', { type: 'button', className: 'dsh-rt-btn dsh-rt-btn-primary', disabled: !canApply, onClick: apply }, busy ? t('saving') : t('apply'))))
    }

    /**
     * The Settings → Models section.
     * @param {object} props injected face
     * @returns {object | null} React node
     */
    function RoleTeamSection(props) {
      const { api, t } = props
      const [state, setState] = React.useState({ status: 'loading', snapshot: null, catalog: null, error: null })
      const [editing, setEditing] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(undefined)
      const [notice, setNotice] = React.useState('')
      const alive = React.useRef(true)
      const loading = React.useRef(false)

      const load = React.useCallback(async () => {
        if (loading.current) return
        loading.current = true
        setState(previous => ({ ...previous, status: previous.snapshot === null ? 'loading' : 'refreshing', error: null }))
        try {
          const [snapshot, catalog] = await Promise.all([api.load(), api.catalog()])
          if (!alive.current) return
          setState({ status: 'ready', snapshot, catalog, error: null })
        } catch (error) {
          if (!alive.current) return
          setState(previous => ({
            ...previous,
            status: previous.snapshot === null ? 'error' : 'ready',
            error: messageOf(error),
          }))
        } finally {
          loading.current = false
        }
      }, [api])

      React.useEffect(() => {
        alive.current = true
        void load()
        return () => { alive.current = false }
      }, [load])

      React.useEffect(() => api.onCatalogChange(() => { void load() }), [api, load])

      React.useEffect(() => {
        if (notice === '') return
        const timer = setTimeout(() => { setNotice('') }, 2400)
        return () => { clearTimeout(timer) }
      }, [notice])

      const closePicker = () => {
        if (saving) return
        setEditing(null)
        setSaveError(undefined)
      }

      const applyRoute = async route => {
        if (editing === null) return
        setSaving(true)
        setSaveError(undefined)
        try {
          const snapshot = await api.save(editing.role, route)
          if (!alive.current) return
          setState(previous => ({ ...previous, snapshot, status: 'ready' }))
          setEditing(null)
          setNotice(t('saved'))
        } catch (error) {
          setSaveError(messageOf(error))
        } finally {
          setSaving(false)
        }
      }

      const resetRole = async role => {
        setSaving(true)
        setSaveError(undefined)
        try {
          const snapshot = await api.reset(role)
          if (!alive.current) return
          setState(previous => ({ ...previous, snapshot, status: 'ready' }))
          setNotice(t('saved'))
        } catch (error) {
          setSaveError(messageOf(error))
        } finally {
          setSaving(false)
        }
      }

      const snapshot = state.snapshot
      const warnings = independenceWarnings(snapshot?.roles, t)
      const body = state.status === 'loading'
        ? h('p', { className: 'dsh-rt-loading', role: 'status' }, t('loading'))
        : state.status === 'error'
          ? h(React.Fragment, null,
              h('p', { className: 'dsh-rt-error', role: 'alert' }, `${t('loadError')} ${state.error ?? ''}`),
              h('button', { type: 'button', className: 'dsh-rt-btn dsh-rt-retry', onClick: () => { void load() } }, t('retry')))
          : snapshot === null
            ? null
            : h(React.Fragment, null,
                h('div', { className: 'dsh-rt-card' },
                  ROLES.map(role => h(RoleRow, {
                    key: role,
                    role,
                    info: snapshot.roles?.[role],
                    catalog: state.catalog,
                    t,
                    busy: saving,
                    onEdit: selected => { setEditing({ role: selected }); setSaveError(undefined) },
                    onReset: roleName => { void resetRole(roleName) },
                  }))),
                warnings.length === 0 ? null : h('ul', { className: 'dsh-rt-warnings', 'aria-label': t('warnings') },
                  warnings.map((warning, index) => h('li', { key: index, className: 'dsh-rt-warning' }, warning))),
                saveError === undefined || editing !== null ? null : h('p', { className: 'dsh-rt-error', role: 'alert' }, `${t('saveError')} ${saveError}`),
                notice === '' ? null : h('p', { className: 'dsh-rt-status', role: 'status' }, notice))

      return h('section', { className: 'dsh-rt-section', 'data-plugin': 'role-team' },
        h('div', { className: 'dsh-rt-head' },
          h('div', null,
            h('h2', { className: 'dsh-rt-title' }, t('title')),
            h('p', { className: 'dsh-rt-intro' }, t('intro'))),
          h('button', {
            type: 'button',
            className: 'dsh-rt-refresh',
            disabled: saving || state.status === 'loading' || state.status === 'refreshing',
            onClick: () => { void load() },
          }, t('refresh'))),
        body,
        editing === null ? null : h(ModelPicker, {
          key: editing.role,
          role: editing.role,
          info: snapshot?.roles?.[editing.role],
          catalog: state.catalog,
          t,
          busy: saving,
          error: saveError,
          onApply: route => { void applyRoute(route) },
          onCancel: closePicker,
        }))
    }

    /** The role tools this browser half renders as dedicated cards. */
    const TOOL_KEYS = ['roles_run', 'role_plan', 'role_worker', 'role_advisor', 'role_reviewer']

    /**
     * Read the `task` argument out of a tool call's raw arguments.
     * @param {object} block preparing, started, or settled Tool block
     * @returns {string} the task text, or '' when unavailable
     */
    function taskOf(block) {
      try {
        const call = block !== null && typeof block === 'object' && 'kind' in block ? block.call : block
        if (call === null || call === undefined || typeof call.argsRaw !== 'string') return ''
        const parsed = JSON.parse(call.argsRaw)
        return typeof parsed?.task === 'string' ? parsed.task : ''
      } catch {
        return ''
      }
    }

    /**
     * First text block of a settled result, for the plain-text fallback.
     * @param {object} block settled Tool result
     * @returns {string} its text, or ''
     */
    function rawTextOf(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      const first = content.find(part => part && part.type === 'text' && typeof part.text === 'string')
      const text = first === undefined ? '' : first.text
      return text.length > 2400 ? `${text.slice(0, 2400)}\n…` : text
    }

    /**
     * One role label with its route, shared by stage badges and comment heads.
     * @param {string} role role name
     * @param {object | null} route role route
     * @param {(key: string) => string} t translator
     * @returns {object} React node
     */
    function roleLabel(role, route, t) {
      return h('span', { className: 'dsh-rt-comment-role' },
        h('span', { className: 'dsh-rt-dot', style: { background: ROLE_COLOR[role] ?? 'var(--dsw-alias-label-tertiary)' } }),
        ROLE_LABEL[role] ?? role,
        h('span', { className: 'dsh-rt-stage-route' },
          route === null || route === undefined ? t('inheritRoute') : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @${route.reasoningEffort}`}`))
    }

    /**
     * Poll the live run state of one call while it is in flight.
     * @param {string | undefined} callId tool call id
     * @param {boolean} active whether the call is running
     * @returns {object | null} the live run state
     */
    function useRunState(callId, active) {
      const [run, setRun] = React.useState(null)
      React.useEffect(() => {
        if (!active || !callId) return undefined
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(`/plugin-api/role-team/run/${encodeURIComponent(callId)}`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const data = await response.json()
            if (alive && data && data.ok) setRun(data.run)
          } catch {
            // A transient poll failure just waits for the next tick.
          }
        }
        void load()
        const timer = setInterval(load, 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [callId, active])
      return run
    }

    /**
     * The dedicated chat-timeline card for one role tool call.
     * @param {object} props owner props of the keyed toolview
     * @returns {object} React node
     */
    function RoleToolRow(props) {
      const { toolName, block, useDisclosure } = props
      const t = typeof props.t === 'function' ? props.t : (key => key)
      const callId = props.callId
      const [fallbackExpanded, setFallbackExpanded] = React.useState(false)
      const disclosure = typeof useDisclosure === 'function'
        ? useDisclosure()
        : { expanded: fallbackExpanded, toggle: () => setFallbackExpanded(value => !value) }
      const settled = block !== null && typeof block === 'object' && 'kind' in block
      const preparing = !settled && block?.phase !== 'start'
      const isError = settled && block.isError === true
      const meta = settled && !isError && block.meta !== null && typeof block.meta === 'object'
        && !Array.isArray(block.meta) && block.meta.v === 1 ? block.meta : null
      const live = useRunState(callId, !settled && !preparing)
      const task = taskOf(block)
      const stages = meta !== null && Array.isArray(meta.stages) ? meta.stages
        : live !== null && Array.isArray(live.stages) ? live.stages : []
      const comments = meta !== null && Array.isArray(meta.comments) ? meta.comments : []
      const decisions = meta !== null && Array.isArray(meta.decisions) ? meta.decisions : []
      const verdict = meta !== null && meta.verdict !== null && typeof meta.verdict === 'object' ? meta.verdict : null
      const statusKey = preparing
        ? 'preparing'
        : settled
          ? isError
            ? 'failed'
            : verdict !== null
              ? verdict.approved ? 'approved' : 'changes'
              : meta?.status === 'approved' ? 'approved'
                : meta?.status === 'continued' ? 'continued'
                  : meta?.status === 'unapproved' ? 'notApproved' : 'changes'
          : 'running'
      const pillClass = statusKey === 'approved' || statusKey === 'continued'
        ? 'dsh-rt-pill dsh-rt-pill-ok'
        : statusKey === 'failed' ? 'dsh-rt-pill dsh-rt-pill-err' : 'dsh-rt-pill dsh-rt-pill-warn'
      const role = toolName === 'roles_run' ? 'plan' : toolName.replace(/^role_/, '')
      const headerRoles = toolName === 'roles_run' ? ROLES : [role]

      const body = disclosure.expanded
        ? h('div', { className: 'dsh-rt-tool-body' },
            stages.length > 0
              ? h('div', null,
                  h('div', { className: 'dsh-rt-section-label' }, t('pipeline')),
                  h('div', { className: 'dsh-rt-stages' },
                    stages.map((stage, index) => h('span', {
                      key: index,
                      className: 'dsh-rt-stage',
                      'data-active': stage.status === 'running' ? 'true' : 'false',
                    },
                    h('span', { className: 'dsh-rt-dot', style: { background: ROLE_COLOR[stage.role] ?? 'var(--dsw-alias-label-tertiary)' } }),
                    ROLE_LABEL[stage.role] ?? stage.role,
                    h('span', { className: 'dsh-rt-stage-route' },
                      stage.route === null || stage.route === undefined ? t('inheritRoute') : `${stage.route.provider}/${stage.route.model}`)))))
              : null,
            comments.length > 0
              ? h('div', null,
                  h('div', { className: 'dsh-rt-section-label' }, t('comments')),
                  comments.map((comment, index) => h('div', { key: index, className: 'dsh-rt-comment' },
                    h('div', { className: 'dsh-rt-comment-head' },
                      roleLabel(comment.role, comment.route, t),
                      h('span', { className: 'dsh-rt-comment-stage' }, comment.stage ?? ''),
                      h('span', {
                        className: comment.approved ? 'dsh-rt-pill dsh-rt-pill-ok' : 'dsh-rt-pill dsh-rt-pill-warn',
                      }, comment.approved ? t('approved') : t('changes'))),
                    typeof comment.summary === 'string' && comment.summary !== ''
                      ? h('p', { className: 'dsh-rt-comment-summary' }, comment.summary)
                      : null,
                    Array.isArray(comment.issues) && comment.issues.length > 0
                      ? h('ul', { className: 'dsh-rt-issues' },
                          comment.issues.map((issue, issueIndex) => h('li', {
                            key: issueIndex,
                            className: 'dsh-rt-issue',
                          }, `[${issue.severity ?? 'major'}] ${issue.detail ?? ''}`)))
                      : null)))
              : null,
            decisions.length > 0
              ? h('div', null,
                  h('div', { className: 'dsh-rt-section-label' }, t('decisions')),
                  h('ul', { className: 'dsh-rt-decisions' },
                    decisions.map((decision, index) => h('li', { key: index, className: 'dsh-rt-decision' },
                      `${decision.choice ?? ''}${decision.route === undefined ? '' : ` → ${decision.route.provider}/${decision.route.model}`}`))))
              : null,
            settled
              ? h('div', null,
                  meta === null ? h('p', { className: 'dsh-rt-note', style: { margin: '0 0 6px' } }, t('noMeta')) : null,
                  h('details', null,
                    h('summary', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' } }, t('rawReport')),
                    h('pre', { className: 'dsh-rt-raw' }, rawTextOf(block) || '(no report)')))
              : null)
        : null

      return h('div', { className: 'dsh-rt-tool', 'data-plugin': 'role-team', 'data-phase': preparing ? 'preparing' : settled ? 'result' : 'start' },
        h('button', {
          type: 'button',
          className: 'dsh-rt-tool-head',
          'aria-expanded': disclosure.expanded ? 'true' : 'false',
          onClick: disclosure.toggle,
          style: { border: 'none', background: 'transparent', padding: 0, font: 'inherit', cursor: 'pointer' },
        },
        h('span', { className: 'dsh-rt-tool-dots' },
          headerRoles.map(headerRole => h('span', {
            key: headerRole,
            className: 'dsh-rt-dot',
            style: { background: ROLE_COLOR[headerRole] ?? 'var(--dsw-alias-label-tertiary)' },
          }))),
        h('span', { className: 'dsh-rt-tool-title' }, toolName === 'roles_run' ? t('runTitle') : ROLE_LABEL[role] ?? toolName),
        h('span', { className: pillClass }, t(statusKey)),
        task === '' ? null : h('span', { className: 'dsh-rt-tool-task' }, task)),
        body)
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, ru, zh }), 'role-team: dictionaries')
        ctx.effect(() => {
          for (const previous of document.querySelectorAll('style[data-dsh-plugin="role-team"]')) previous.remove()
          const style = document.createElement('style')
          style.dataset.dshPlugin = 'role-team'
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'role-team: styles')
        const api = createApi(ctx)
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'role-team',
          order: 20,
          locale: NS,
          inject: () => ({ api, t }),
        }, RoleTeamSection))
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of TOOL_KEYS) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, RoleToolRow)
          }
        })
      },
    }
  },
})
