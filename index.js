/**
 * Role team for DeepSeek Harness.
 *
 * Ports the four-role working model of omp (oh-my-pi) to DSH: a smart PLAN
 * produces the plan, WORKER implements it in the shared workspace, ADVISOR
 * audits each worker attempt from a different model family, and REVIEWER is
 * the final independent gate that runs only after WORKER reports completion
 * and ADVISOR approves. Every role is a real DSH subagent, so it has its own
 * context, tools and model route; the route for each role is configurable and
 * may use any registered provider.
 *
 * The deterministic orchestration lives in `roles_run`; the `role_*` tools
 * expose a single role for manual work, and `/roles` inspects and edits the
 * routes through the profile configuration editor. The plugin deliberately
 * imports no DSH packages: it is resolved from the profile and consumes the
 * live Host services through `ctx.get()`.
 *
 * @module @local/dsh-role-team
 */

/** The four roles, in pipeline order. */
export const ROLE_NAMES = Object.freeze(['plan', 'worker', 'advisor', 'reviewer'])

/**
 * Services this plugin requires. Everything else (`subagents`, `llm`,
 * `commands`, `configEditor`, `workingDirectory`) is optional and read with
 * `ctx.get()`, so the plugin still loads in a minimal composition.
 */
export const inject = ['tools', 'systemPrompt']

/** Human-facing role names used in prompts and reports. */
const ROLE_LABELS = Object.freeze({
  plan: 'PLAN',
  worker: 'WORKER',
  advisor: 'ADVISOR',
  reviewer: 'REVIEWER',
})

/**
 * Recommended cross-family defaults. They match the roles described by the
 * user: a strong planner (GPT-6 Astra), a fast implementer (DeepSeek V4.1
 * Flash), a GLM advisor, and an independent GPT-6 Sol final reviewer.
 */
const DEFAULT_ROLES = Object.freeze({
  plan: { provider: 'opencode-go', model: 'gpt-6-luna' },
  worker: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  advisor: { provider: 'opencode-go', model: 'glm-5.3' },
  reviewer: { provider: 'opencode-go', model: 'qwen3.8-max' },
})

/** Bound every model-facing piece of the report so one round cannot flood the lead. */
const LIMITS = Object.freeze({
  planChars: 8000,
  workerChars: 5000,
  verdictChars: 3000,
  issueChars: 1200,
  reportChars: 32_000,
  roleOutputChars: 14_000,
  toolTaskChars: 60_000,
  maxRounds: 6,
  maxChildDepth: 8,
})

/** Same-origin settings route served to the browser half. */
const ROLES_SETTINGS_ROUTE = '/plugin-api/role-team/roles'

/** The section that tells the lead what the team is for. */
const ROLE_GUIDANCE = `Role team (PLAN -> WORKER -> ADVISOR -> REVIEWER) is available. \`roles_run\` runs the full loop on a self-contained task: PLAN drafts, WORKER implements in this shared workspace, ADVISOR audits every worker attempt, and REVIEWER performs the final independent gate only after WORKER reports completion and ADVISOR approves. Use it for substantial implementation, migration or verification work. Pass the user's task verbatim and every fact the roles need: they start without this conversation. The \`role_*\` tools run a single role once when that is enough. Calls block until the role reports; the returned reports are the only thing you see. Role models are configured separately and may use different providers; inspect or change them with \`/roles\`. Do not start the REVIEWER before the worker has reported completion.`

/* ------------------------------------------------------------------------- *
 * Small utilities
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is a plain data object.
 * @param {unknown} value candidate
 * @returns {boolean} true for `{}` and null-prototype objects
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Truncate text to a character budget with an explicit marker.
 * @param {unknown} value candidate text
 * @param {number} max maximum characters
 * @returns {string} clipped text
 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 24))}\n… [truncated ${text.length - max} chars]`
}

/**
 * Collapse whitespace for a one-line summary.
 * @param {unknown} value candidate text
 * @param {number} max maximum characters
 * @returns {string} one line
 */
function oneLine(value, max = 200) {
  return clip(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
}

/**
 * Extract the text blocks of a child's final output.
 * @param {readonly unknown[] | undefined} blocks content blocks
 * @returns {string} joined text
 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Render one thrown value without trusting its coercion.
 * @param {unknown} error thrown value
 * @returns {string} a readable message
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
 * Format a duration in coarse units.
 * @param {number} ms milliseconds
 * @returns {string} e.g. `42s`, `3m 12s`
 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/**
 * Clone plain configuration data without assuming structuredClone exists.
 * @param {unknown} value plain data
 * @returns {unknown} detached copy
 */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * Clamp a positive integer configuration value.
 * @param {unknown} value raw value
 * @param {number} min minimum
 * @param {number} max maximum
 * @param {number} fallback value used when the raw value is not an integer
 * @returns {number} resolved integer
 */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/* ------------------------------------------------------------------------- *
 * Role routes and configuration
 * ------------------------------------------------------------------------- */

/**
 * Parse one configured role route.
 *
 * Accepted forms are `{ provider, model, reasoningEffort? }`, the compact
 * string `provider/model[:effort]`, and `null`/`"inherit"` to follow the
 * session model. Model ids may contain `/`; only the first slash splits the
 * provider, and a trailing `:effort` is recognised only when it looks like an
 * effort id.
 *
 * @param {unknown} value candidate route
 * @returns {{ route: { provider: string, model: string, reasoningEffort?: string } | null, error?: string }} parsed route
 */
export function normalizeRoute(value) {
  if (value === null || value === false || value === undefined) return { route: null }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || text.toLowerCase() === 'inherit') return { route: null }
    const slash = text.indexOf('/')
    if (slash <= 0 || slash === text.length - 1) {
      return { error: `"${text}" is not a <provider>/<model> route` }
    }
    const provider = text.slice(0, slash).trim()
    let model = text.slice(slash + 1).trim()
    let reasoningEffort
    const colon = model.lastIndexOf(':')
    if (colon > 0 && colon < model.length - 1) {
      const candidate = model.slice(colon + 1)
      if (/^[a-z][a-z0-9_-]*$/.test(candidate)) {
        reasoningEffort = candidate
        model = model.slice(0, colon).trim()
      }
    }
    if (provider === '' || model === '') return { error: `"${text}" is not a <provider>/<model> route` }
    return { route: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
  }
  if (isPlainObject(value)) {
    if (value.inherit === true) return { route: null }
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = typeof value.model === 'string' ? value.model.trim() : ''
    if (provider === '' || model === '') {
      return { error: 'a route object needs non-empty provider and model strings' }
    }
    const effort = value.reasoningEffort ?? value.effort
    if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === '')) {
      return { error: 'reasoningEffort must be a non-empty string' }
    }
    return {
      route: {
        provider,
        model,
        ...(typeof effort === 'string' ? { reasoningEffort: effort.trim() } : {}),
      },
    }
  }
  return { error: 'expected a provider/model string, a route object, or null to inherit the session model' }
}

/**
 * Format a route for display.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null} route route
 * @returns {string} display label
 */
export function formatRoute(route) {
  if (route === null) return 'inherit session model'
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @${route.reasoningEffort}`}`
}

/**
 * Best-effort model family, used only for independence warnings.
 * @param {{ provider: string, model: string } | null} route route
 * @returns {string | null} family id
 */
export function familyOf(route) {
  if (route === null) return null
  const id = `${route.provider}/${route.model}`.toLowerCase()
  if (/claude|anthropic/.test(id)) return 'anthropic'
  if (/gemini|google/.test(id)) return 'google'
  if (/glm|zai|z-ai|bigmodel/.test(id)) return 'zai'
  if (/deepseek/.test(id)) return 'deepseek'
  if (/qwen|tongyi/.test(id)) return 'qwen'
  if (/kimi|moonshot/.test(id)) return 'moonshot'
  if (/grok|xai/.test(id)) return 'xai'
  if (/minimax/.test(id)) return 'minimax'
  if (/llama|meta-llama/.test(id)) return 'meta'
  if (/mistral/.test(id)) return 'mistral'
  if (/gpt|openai|codex|o[1-9](?:-|$)/.test(id)) return 'openai'
  return route.provider.toLowerCase()
}

/**
 * Resolve the plugin's raw configuration.
 *
 * Missing role entries use the recommended defaults. An explicit `null` or
 * `"inherit"` makes that role follow the caller's session model, which is
 * useful when a provider is not configured.
 *
 * @param {unknown} raw raw Loader configuration
 * @returns {{
 *   roles: Record<string, { provider: string, model: string, reasoningEffort?: string } | null>,
 *   sources: Record<string, 'config' | 'default' | 'inherit'>,
 *   problems: Array<{ role: string, message: string }>,
 *   maxRounds: number,
 *   childMaxDepth: number,
 *   prompts: Record<string, string>,
 * }} resolved configuration
 */
export function resolveRoleTeamConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const configuredRoles = isPlainObject(input.roles) ? input.roles : {}
  const roles = {}
  const sources = {}
  const problems = []
  for (const role of ROLE_NAMES) {
    const hasOwn = Object.hasOwn(configuredRoles, role)
    const value = hasOwn ? configuredRoles[role] : DEFAULT_ROLES[role]
    const parsed = normalizeRoute(value)
    if (parsed.error !== undefined) {
      roles[role] = null
      sources[role] = 'inherit'
      problems.push({ role, message: parsed.error })
      continue
    }
    roles[role] = parsed.route
    sources[role] = parsed.route === null ? 'inherit' : hasOwn ? 'config' : 'default'
  }
  const promptsInput = isPlainObject(input.prompts) ? input.prompts : {}
  const prompts = {}
  for (const role of ROLE_NAMES) {
    const value = promptsInput[role]
    if (typeof value === 'string' && value.trim() !== '') prompts[role] = value.trim()
  }
  return {
    roles,
    sources,
    problems,
    maxRounds: clampInt(input.maxRounds, 1, LIMITS.maxRounds, 3),
    childMaxDepth: clampInt(input.childMaxDepth, 0, LIMITS.maxChildDepth, 2),
    prompts,
  }
}

/**
 * Validate one configured route against the live LLM runtime.
 * @param {object} ctx Host context
 * @param {string} role role name
 * @param {{ provider: string, model: string, reasoningEffort?: string }} route route
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<void>} fulfillment when the adapter accepts the route
 */
async function validateRoute(ctx, role, route, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) {
    throw new Error('the LLM service is unavailable, so role routes cannot be validated')
  }
  try {
    await llm.resolveCallConfig({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }, signal)
  } catch (error) {
    throw new Error(`role ${role} route ${formatRoute(route)} is not usable: ${messageOf(error)}`)
  }
}

/* ------------------------------------------------------------------------- *
 * Prompts
 * ------------------------------------------------------------------------- */

/** Shared behavioural rules for one role child. */
const COMMON_ROLE_RULES = `You are one role in a four-role engineering team (PLAN, WORKER, ADVISOR, REVIEWER). Every role runs as a separate agent but shares one workspace. Do not call role tools or delegate to other agents: do this role's own work directly. Be concrete; another model reads your output, not a human. Never claim a check passed unless you ran it.`

/**
 * Workspace line for prompts.
 * @param {string | undefined} cwd directory
 * @returns {string} prompt line
 */
function workspaceLine(cwd) {
  return cwd === undefined || cwd === '' ? '' : `Workspace: ${cwd}\n`
}

/**
 * Build the PLAN prompt.
 * @param {object} params prompt inputs
 * @param {string} params.task task text
 * @param {string} [params.context] extra context
 * @param {string | undefined} params.cwd working directory
 * @param {string} [params.extra] role-specific extra instructions
 * @returns {string} prompt
 */
export function buildPlanPrompt({ task, context, cwd, extra }) {
  return `You are PLAN, the planner of a four-role engineering team. You do not edit files; this phase only produces the plan.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === '' ? '' : `\nContext:\n${clip(context, 20_000)}\n`}
Produce an implementation plan with:
1. Ordered steps, each naming the exact files or modules to change and the concrete change.
2. Risks, edge cases, and anything that must be verified rather than assumed.
3. Commands that prove completion (tests, builds, linters, checks).
4. Acceptance checks a reviewer can verify independently.
Keep it under 100 lines. Return only the plan.${extra === undefined ? '' : `\n\n${extra}`}`
}

/**
 * Build the WORKER prompt for one attempt.
 * @param {object} params prompt inputs
 * @param {string} params.task task text
 * @param {string} [params.context] extra context
 * @param {string} params.plan approved plan text
 * @param {string | undefined} params.cwd working directory
 * @param {number} params.round attempt number
 * @param {string[]} params.feedback outstanding advisor/reviewer issues
 * @param {string | undefined} params.previous previous worker report
 * @param {string} [params.extra] role-specific extra instructions
 * @returns {string} prompt
 */
export function buildWorkerPrompt({ task, context, plan, cwd, round, feedback, previous, extra }) {
  const feedbackText = feedback.length === 0
    ? 'None outstanding.'
    : feedback.map((issue, index) => `${index + 1}. ${issue}`).join('\n')
  return `You are WORKER, the implementer of a four-role engineering team. You own the workspace: edit files, run commands, and verify your own work. Do not merely describe changes.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === '' ? '' : `\nContext:\n${clip(context, 20_000)}\n`}
Plan from PLAN:
${clip(plan, LIMITS.planChars)}

Attempt ${round}. Feedback you must address (every blocker and major issue):
${feedbackText}
${previous === undefined || previous.trim() === '' ? '' : `\nYour previous report:\n${clip(previous, 3000)}\n`}
Requirements:
- Implement the whole task, not a sketch. Make reasonable decisions and state assumptions instead of asking questions.
- Run the relevant tests/checks and fix failures you cause. Do not break unrelated behaviour.
- Keep the change scoped to the task.
- Your final message is the only thing the team sees. Include exactly these sections:
  CHANGES: files and what changed
  EVIDENCE: commands run and their results
  STATUS: done | blocked
  NOTES: risks, follow-ups, or what is missing
If blocked, say exactly what is missing; do not claim done.${extra === undefined ? '' : `\n\n${extra}`}`
}

/**
 * Build the ADVISOR prompt for one worker attempt.
 * @param {object} params prompt inputs
 * @param {string} params.task task text
 * @param {string} [params.context] extra context
 * @param {string} params.plan plan text
 * @param {string | undefined} params.cwd working directory
 * @param {string} params.workerReport worker report text
 * @param {number} params.round attempt number
 * @param {string[]} [params.feedback] feedback the worker was asked to address
 * @param {string} [params.extra] role-specific extra instructions
 * @returns {string} prompt
 */
export function buildAdvisorPrompt({ task, context, plan, cwd, workerReport, round, feedback = [], extra }) {
  return `You are ADVISOR, an independent senior reviewer from a different model family than WORKER. Do not edit files. Inspect the actual workspace and diff, run read-only checks if useful, and audit the attempt rather than trusting the report.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === '' ? '' : `\nContext:\n${clip(context, 12_000)}\n`}
Plan:
${clip(plan, LIMITS.planChars)}

WORKER attempt ${round} report:
${clip(workerReport, LIMITS.workerChars)}

Feedback the worker was asked to address in this attempt:
${feedback.length === 0 ? 'None outstanding.' : feedback.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

Judge whether the task is complete and correct. Be adversarial about correctness, but do not invent scope or style work the task did not ask for. Set approved=true only when no blocker or major issue remains.
Return STRICT JSON only, with no markdown fence:
{"approved": true|false, "summary": "one paragraph", "issues": [{"severity": "blocker|major|minor", "detail": "specific, actionable, with file or line when possible"}]}${extra === undefined ? '' : `\n\n${extra}`}`
}

/**
 * Build the REVIEWER prompt for the final gate.
 * @param {object} params prompt inputs
 * @param {string} params.task task text
 * @param {string} [params.context] extra context
 * @param {string} params.plan plan text
 * @param {string | undefined} params.cwd working directory
 * @param {string} params.workerReport worker report text
 * @param {string} params.advisorVerdict advisor verdict text
 * @param {string} [params.extra] role-specific extra instructions
 * @returns {string} prompt
 */
export function buildReviewerPrompt({ task, context, plan, cwd, workerReport, advisorVerdict, extra }) {
  return `You are REVIEWER, the final independent gate of the team. WORKER says the task is done and ADVISOR approved; verify from scratch. Do not edit files. Inspect the diff, run the tests, and check every acceptance check yourself; do not trust the reports.
${COMMON_ROLE_RULES}
${workspaceLine(cwd)}
Task (verbatim):
${clip(task, LIMITS.toolTaskChars)}
${context === undefined || context.trim() === '' ? '' : `\nContext:\n${clip(context, 12_000)}\n`}
Plan:
${clip(plan, LIMITS.planChars)}

WORKER report:
${clip(workerReport, LIMITS.workerChars)}

ADVISOR verdict:
${clip(advisorVerdict, LIMITS.verdictChars)}

Return STRICT JSON only, with no markdown fence:
{"approved": true|false, "summary": "one paragraph", "issues": [{"severity": "blocker|major|minor", "detail": "specific, actionable, with file or line when possible"}]}${extra === undefined ? '' : `\n\n${extra}`}`
}

/* ------------------------------------------------------------------------- *
 * Verdict parsing
 * ------------------------------------------------------------------------- */

/**
 * Scan text for balanced JSON objects, ignoring braces inside strings.
 * @param {string} text candidate text
 * @returns {string[]} JSON object substrings, outermost first
 */
function jsonObjectCandidates(text) {
  const candidates = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1))
        start = -1
        if (candidates.length >= 12) break
      }
    }
  }
  return candidates
}

/**
 * Normalise one issue value from a verdict.
 * @param {unknown} issue raw issue
 * @param {string} fallback fallback detail
 * @returns {{ severity: string, detail: string }} issue
 */
function normalizeIssue(issue, fallback) {
  if (typeof issue === 'string' && issue.trim() !== '') {
    return { severity: 'major', detail: clip(issue.trim(), LIMITS.issueChars) }
  }
  if (isPlainObject(issue)) {
    const severity = typeof issue.severity === 'string' ? issue.severity.toLowerCase() : 'major'
    const detail = issue.detail ?? issue.message ?? issue.description ?? issue.title
    if (typeof detail === 'string' && detail.trim() !== '') {
      return { severity, detail: clip(detail.trim(), LIMITS.issueChars) }
    }
  }
  return { severity: 'major', detail: clip(fallback, LIMITS.issueChars) }
}

/**
 * Parse an ADVISOR/REVIEWER verdict.
 *
 * The preferred form is strict JSON. A missing or malformed object falls back
 * to a conservative text heuristic: an explicit approval without a rejection
 * word approves, everything else is treated as changes required. The fallback
 * is deliberately biased toward another worker round, never toward a false
 * approval.
 *
 * @param {string} text role output
 * @returns {{ approved: boolean, summary: string, issues: Array<{ severity: string, detail: string }>, parsed: boolean }} verdict
 */
export function parseVerdict(text) {
  const source = String(text ?? '')
  for (const candidate of jsonObjectCandidates(source)) {
    try {
      const value = JSON.parse(candidate)
      if (!isPlainObject(value) || typeof value.approved !== 'boolean') continue
      const rawIssues = Array.isArray(value.issues) ? value.issues : []
      const issues = rawIssues.map(issue => normalizeIssue(issue, 'unspecified issue'))
      // A verdict that claims approval while listing a blocker or major issue
      // is contradictory; the gate stays closed.
      const blocking = issues.some(issue => issue.severity === 'blocker' || issue.severity === 'major')
      return {
        approved: value.approved && !blocking,
        summary: typeof value.summary === 'string' ? clip(value.summary, LIMITS.verdictChars) : '',
        issues,
        parsed: true,
      }
    } catch {
      // Not JSON, or a non-verdict object: continue scanning.
    }
  }
  const lower = source.toLowerCase()
  const rejected = /\bnot approved\b|\bchanges required\b|\brejected\b|\bblocker\b/.test(lower)
  // Only a declared approval counts in the fallback; a stray "approved" inside
  // a sentence such as "it would be approved after X" must not release the gate.
  const declared = /^\s*(?:final\s+)?(?:verdict\s*:\s*)?approved\b/im.test(source)
    || /\bapproved\s*:\s*true\b/i.test(source)
  const approved = declared && !rejected
  return {
    approved,
    summary: clip(source.trim(), LIMITS.verdictChars),
    issues: approved ? [] : [{
      severity: 'major',
      detail: clip(source.trim() === '' ? 'the role returned no verdict' : source.trim(), LIMITS.issueChars * 2),
    }],
    parsed: false,
  }
}

/**
 * Render issues as numbered worker feedback.
 * @param {Array<{ severity: string, detail: string }>} issues issues
 * @returns {string[]} feedback lines
 */
function feedbackLines(issues) {
  return issues.map(issue => `[${issue.severity}] ${issue.detail}`)
}

/* ------------------------------------------------------------------------- *
 * Role execution through the subagent service
 * ------------------------------------------------------------------------- */

let childNameCounter = 0

/**
 * Sessions in which a WORKER has reported completion. The REVIEWER is the
 * final gate, so the standalone `role_reviewer` tool refuses to run before
 * that. `roles_run` calls the reviewer internally and does not need the flag.
 */
const workerReportedDone = new WeakSet()

/**
 * Allocate a unique, valid subagent name for one role child.
 * @param {string} role role name
 * @returns {string} lowercase name, at most 32 characters
 */
function roleChildName(role) {
  childNameCounter += 1
  const stamp = Date.now().toString(36).slice(-5)
  return `${role}-${stamp}${childNameCounter.toString(36)}`.slice(0, 32)
}

/**
 * Start one role child, await its settlement, and release it.
 *
 * Caller delivery is used because the orchestrator awaits the result itself;
 * this avoids competing completion notices in the lead's inbox.
 *
 * @param {object} ctx Host context
 * @param {object} config resolved configuration
 * @param {object} params run parameters
 * @param {string} params.role role name
 * @param {string} params.prompt complete prompt
 * @param {object} params.parent calling DSH agent
 * @param {AbortSignal} params.signal cancellation
 * @param {string | undefined} params.cwd working directory
 * @returns {Promise<{
 *   role: string,
 *   route: object | null,
 *   childName: string,
 *   status: string,
 *   text: string,
 *   diagnostic: string | undefined,
 *   durationMs: number,
 * }>} role result
 */
async function runRole(ctx, config, { role, prompt, parent, signal, cwd }) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null) {
    throw new Error('role team needs the subagent service; mount @deepseek-ai/dsh-subagent and @deepseek-ai/dsh-subagent-spawn-in-process')
  }
  const provider = subagents.getProvider('spawn')
  if (provider === undefined || provider === null) {
    throw new Error('role team needs the "spawn" subagent provider; mount @deepseek-ai/dsh-subagent-spawn-in-process')
  }
  if (signal !== undefined && signal.aborted) throw new Error('role team was cancelled')
  const route = config.roles[role] ?? null
  const startedAt = Date.now()
  const name = roleChildName(role)
  const agentOptions = route === null
    ? undefined
    : {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }
  let started
  try {
    started = await subagents.startActivation({
      provider: 'spawn',
      label: `role ${role}`,
      name,
      parent,
      signal,
      delivery: 'caller',
      prompt: [{ type: 'text', text: prompt }],
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(provider.capabilities !== undefined && provider.capabilities.depthLimit && Number.isInteger(config.childMaxDepth)
        ? { maxDepth: config.childMaxDepth }
        : {}),
    })
  } catch (error) {
    throw new Error(`could not start the ${role} role: ${messageOf(error)}`)
  }
  let result
  try {
    result = await started.result
  } catch (error) {
    throw new Error(`the ${role} role failed: ${messageOf(error)}`)
  } finally {
    try {
      await started.dispose()
    } catch {
      // Disposal failure must not replace a captured child result.
    }
  }
  if (result.stopReason === 'aborted' || (signal !== undefined && signal.aborted)) {
    throw new Error('role team was cancelled')
  }
  return {
    role,
    route,
    childName: started.name,
    status: result.stopReason,
    text: textOf(result.output),
    diagnostic: typeof result.diagnostic === 'string' ? result.diagnostic : undefined,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Format one role result for a single-role tool.
 * @param {object} result role result
 * @returns {string} report text
 */
function formatRoleResult(result) {
  const header = `Role ${ROLE_LABELS[result.role]} (${formatRoute(result.route)}) finished: ${result.status} in ${formatDuration(result.durationMs)}.`
  const body = result.text === '' ? '(the role returned no text)' : result.text
  const diagnostic = result.diagnostic === undefined ? '' : `\n\nDiagnostic: ${result.diagnostic}`
  return clip(`${header}\n\n${body}${diagnostic}`, LIMITS.roleOutputChars)
}

/* ------------------------------------------------------------------------- *
 * The orchestrated team loop
 * ------------------------------------------------------------------------- */

/**
 * Build the final report handed back to the lead.
 * @param {object} params report inputs
 * @returns {string} report text
 */
function buildTeamReport({ status, config, plan, rounds, startedAt, task }) {
  const lines = []
  lines.push(`Role team: ${status === 'approved' ? 'APPROVED' : 'NOT APPROVED'} after ${rounds.length} round(s) in ${formatDuration(Date.now() - startedAt)}.`)
  lines.push(`Roles: ${ROLE_NAMES.map(role => `${role}=${formatRoute(config.roles[role])}`).join(' · ')}`)
  lines.push(`Task: ${oneLine(task, 300)}`)
  lines.push('')
  lines.push('PLAN')
  lines.push(clip(plan, LIMITS.planChars))
  for (const round of rounds) {
    lines.push('')
    lines.push(`ROUND ${round.number}`)
    lines.push(`WORKER (${formatRoute(round.worker.route)}, ${round.worker.status}, ${formatDuration(round.worker.durationMs)})`)
    lines.push(clip(round.worker.text === '' ? '(no report)' : round.worker.text, LIMITS.workerChars))
    if (round.worker.diagnostic !== undefined) lines.push(`Diagnostic: ${clip(round.worker.diagnostic, 1500)}`)
    lines.push('')
    lines.push(`ADVISOR (${formatRoute(round.advisor.route)}, ${round.advisor.status}, ${formatDuration(round.advisor.durationMs)}) — ${round.advisorVerdict.approved ? 'APPROVED' : 'CHANGES REQUIRED'}`)
    lines.push(clip(round.advisorVerdict.summary === '' ? round.advisor.text : round.advisorVerdict.summary, LIMITS.verdictChars))
    if (round.advisor.diagnostic !== undefined) lines.push(`Diagnostic: ${clip(round.advisor.diagnostic, 1500)}`)
    for (const issue of round.advisorVerdict.issues) lines.push(`- [${issue.severity}] ${issue.detail}`)
    if (round.reviewer !== undefined) {
      lines.push('')
      lines.push(`REVIEWER (${formatRoute(round.reviewer.route)}, ${round.reviewer.status}, ${formatDuration(round.reviewer.durationMs)}) — ${round.reviewerVerdict.approved ? 'APPROVED' : 'CHANGES REQUIRED'}`)
      lines.push(clip(round.reviewerVerdict.summary === '' ? round.reviewer.text : round.reviewerVerdict.summary, LIMITS.verdictChars))
      if (round.reviewer.diagnostic !== undefined) lines.push(`Diagnostic: ${clip(round.reviewer.diagnostic, 1500)}`)
      for (const issue of round.reviewerVerdict.issues) lines.push(`- [${issue.severity}] ${issue.detail}`)
    }
  }
  const last = rounds.at(-1)
  if (status !== 'approved' && last !== undefined) {
    lines.push('')
    lines.push('OUTSTANDING FEEDBACK')
    const issues = last.reviewerVerdict?.approved === false ? last.reviewerVerdict.issues : last.advisorVerdict.issues
    if (issues.length === 0) lines.push('No structured issues were returned; inspect the round reports above.')
    else for (const issue of issues) lines.push(`- [${issue.severity}] ${issue.detail}`)
    lines.push('')
    lines.push('The task is not approved. Address the outstanding feedback and run the team again, or raise `max_rounds` for another worker attempt.')
  }
  return clip(lines.join('\n'), LIMITS.reportChars)
}

/**
 * Run the full PLAN -> WORKER -> ADVISOR -> REVIEWER loop.
 *
 * The loop is deterministic: ADVISOR audits every WORKER attempt, and
 * REVIEWER runs only after ADVISOR approves. A rejected attempt's issues are
 * fed into the next WORKER prompt. Reviewer rejection returns to WORKER and
 * re-enters the same gate.
 *
 * @param {object} ctx Host context
 * @param {object} options run inputs
 * @param {object} options.agent calling DSH agent
 * @param {string} options.task task text
 * @param {string} [options.context] extra context
 * @param {string} [options.plan] pre-existing plan, skips PLAN
 * @param {AbortSignal} options.signal cancellation
 * @param {object} options.config resolved configuration
 * @returns {Promise<{ status: 'approved' | 'unapproved', report: string, rounds: object[], plan: string }>} outcome
 */
export async function runRoleTeam(ctx, { agent, task, context, plan, signal, config }) {
  if (agent === undefined || agent === null) throw new Error('role team needs a calling agent')
  const taskText = typeof task === 'string' ? task.trim() : ''
  if (taskText === '') throw new Error('role team needs a non-empty task')
  const cwd = ctx.get('workingDirectory')?.get?.(agent.session)
  const usedRoles = plan === undefined || plan.trim() === ''
    ? ROLE_NAMES
    : ['worker', 'advisor', 'reviewer']
  const configProblems = config.problems.filter(problem => usedRoles.includes(problem.role))
  if (configProblems.length > 0) {
    throw new Error(`role team configuration is invalid: ${configProblems.map(problem => `${problem.role}: ${problem.message}`).join('; ')}`)
  }
  for (const role of usedRoles) {
    const route = config.roles[role] ?? null
    if (route !== null) await validateRoute(ctx, role, route, signal)
  }
  const startedAt = Date.now()
  let planText = typeof plan === 'string' ? plan.trim() : ''
  if (planText === '') {
    const planResult = await runRole(ctx, config, {
      role: 'plan',
      prompt: buildPlanPrompt({ task: taskText, context, cwd, extra: config.prompts.plan }),
      parent: agent,
      signal,
      cwd,
    })
    planText = planResult.text.trim()
    if (planText === '') {
      throw new Error(`PLAN finished without a plan (${planResult.status}${planResult.diagnostic === undefined ? '' : `: ${clip(planResult.diagnostic, 1200)}`}); role team cannot continue`)
    }
  }
  const rounds = []
  let feedback = []
  let previousReport
  for (let number = 1; number <= config.maxRounds; number += 1) {
    if (signal !== undefined && signal.aborted) throw new Error('role team was cancelled')
    const workerPrompt = buildWorkerPrompt({
      task: taskText,
      context,
      plan: planText,
      cwd,
      round: number,
      feedback,
      previous: previousReport,
      extra: config.prompts.worker,
    })
    const worker = await runRole(ctx, config, { role: 'worker', prompt: workerPrompt, parent: agent, signal, cwd })
    previousReport = worker.text
    const advisorPrompt = buildAdvisorPrompt({
      task: taskText,
      context,
      plan: planText,
      cwd,
      workerReport: worker.text,
      round: number,
      feedback,
      extra: config.prompts.advisor,
    })
    const advisor = await runRole(ctx, config, { role: 'advisor', prompt: advisorPrompt, parent: agent, signal, cwd })
    const advisorVerdict = parseVerdict(advisor.text)
    const round = { number, worker, advisor, advisorVerdict }
    if (!advisorVerdict.approved) {
      rounds.push(round)
      feedback = feedbackLines(advisorVerdict.issues)
      if (feedback.length === 0) feedback = ['[major] ADVISOR did not approve and returned no issue details; inspect the workspace and retry.']
      continue
    }
    const reviewerPrompt = buildReviewerPrompt({
      task: taskText,
      context,
      plan: planText,
      cwd,
      workerReport: worker.text,
      advisorVerdict: advisor.text,
      extra: config.prompts.reviewer,
    })
    const reviewer = await runRole(ctx, config, { role: 'reviewer', prompt: reviewerPrompt, parent: agent, signal, cwd })
    const reviewerVerdict = parseVerdict(reviewer.text)
    round.reviewer = reviewer
    round.reviewerVerdict = reviewerVerdict
    rounds.push(round)
    if (reviewerVerdict.approved) {
      return {
        status: 'approved',
        plan: planText,
        rounds,
        report: buildTeamReport({ status: 'approved', config, plan: planText, rounds, startedAt, task: taskText }),
      }
    }
    feedback = feedbackLines(reviewerVerdict.issues)
    if (feedback.length === 0) feedback = ['[major] REVIEWER did not approve and returned no issue details; inspect the workspace and retry.']
  }
  return {
    status: 'unapproved',
    plan: planText,
    rounds,
    report: buildTeamReport({ status: 'unapproved', config, plan: planText, rounds, startedAt, task: taskText }),
  }
}

/* ------------------------------------------------------------------------- *
 * Tool definitions
 * ------------------------------------------------------------------------- */

/**
 * Coerce a tool argument to a bounded string.
 * @param {unknown} args tool arguments
 * @param {string} field field name
 * @param {{ required?: boolean, max?: number }} options constraints
 * @returns {string | undefined} value
 */
function stringArg(args, field, { required = false, max = LIMITS.toolTaskChars } = {}) {
  const value = isPlainObject(args) ? args[field] : undefined
  if (value === undefined || value === null) {
    if (required) throw new Error(`\`${field}\` is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`\`${field}\` must be a string`)
  const text = value.trim()
  if (text === '' && required) throw new Error(`\`${field}\` must be a non-empty string`)
  return text === '' ? undefined : clip(text, max)
}

/**
 * The shared output declaration: every role tool returns one text report.
 * @param {unknown} _args arguments
 * @param {{ text: string }} value canonical value
 * @returns {Array<{ type: 'text', text: string }>} content blocks
 */
function renderText(_args, value) {
  return [{ type: 'text', text: value.text }]
}

/** Canonical output schema for every tool in this plugin. */
const TEXT_OUTPUT = Object.freeze({
  schema: Object.freeze({
    type: 'object',
    properties: Object.freeze({ text: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['text']),
    additionalProperties: false,
  }),
  render: renderText,
})

/**
 * Register one tool with a caller context.
 * @param {object} ctx Host context
 * @param {object} definition tool definition
 * @returns {void}
 */
function registerTool(ctx, definition) {
  ctx.effect(() => ctx.tools.register(definition))
}

/**
 * Build every model-facing tool for one resolved configuration.
 * @param {object} ctx Host context
 * @param {object} config resolved configuration
 * @returns {object[]} tool definitions
 */
function buildTools(ctx, config) {
  const tools = []
  tools.push({
    name: 'roles_run',
    description: 'Run the full PLAN -> WORKER -> ADVISOR -> REVIEWER team on one self-contained task and wait for the outcome. PLAN writes the plan, WORKER implements it in this shared workspace, ADVISOR audits every attempt from a different model family, and REVIEWER performs the final independent gate only after WORKER reports completion and ADVISOR approves. Rejected attempts are sent back to WORKER with the issues, up to the configured round limit. The roles start as fresh agents without this conversation, so include every task detail, path, constraint and acceptance check they need. This call can take several minutes; it returns the plan, each attempt, each verdict and the final status.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete task for the team, ideally the user request verbatim plus the exact acceptance criteria.' },
        context: { type: 'string', description: 'Additional facts the roles need: relevant files, constraints, prior decisions, environment notes. The roles do not see this conversation.' },
        plan: { type: 'string', description: 'Optional existing plan. When supplied, PLAN is skipped and WORKER implements this plan directly.' },
        max_rounds: { type: 'integer', description: 'Override the configured worker-attempt limit (1-6).' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('roles_run needs a calling agent')
      const task = stringArg(args, 'task', { required: true })
      const context = stringArg(args, 'context', { max: 30_000 })
      const plan = stringArg(args, 'plan', { max: LIMITS.planChars })
      const rounds = isPlainObject(args) ? args.max_rounds : undefined
      const effectiveConfig = rounds === undefined
        ? config
        : { ...config, maxRounds: clampInt(rounds, 1, LIMITS.maxRounds, config.maxRounds) }
      const outcome = await runRoleTeam(ctx, {
        agent: exec.agent,
        task,
        context,
        plan,
        signal: exec.signal,
        config: effectiveConfig,
      })
      return { text: outcome.report }
    },
  })
  tools.push({
    name: 'role_plan',
    description: 'Ask the configured PLAN model to produce an implementation plan for one self-contained task. PLAN runs as a fresh agent in this workspace; it does not edit files and does not see this conversation. Waits for the plan and returns it.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to plan, with every fact the planner needs.' },
        context: { type: 'string', description: 'Additional context: files, constraints, prior decisions.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('role_plan needs a calling agent')
      const task = stringArg(args, 'task', { required: true })
      const context = stringArg(args, 'context', { max: 30_000 })
      const cwd = ctx.get('workingDirectory')?.get?.(exec.agent.session)
      if (config.roles.plan !== null) await validateRoute(ctx, 'plan', config.roles.plan, exec.signal)
      const result = await runRole(ctx, config, {
        role: 'plan',
        prompt: buildPlanPrompt({ task, context, cwd, extra: config.prompts.plan }),
        parent: exec.agent,
        signal: exec.signal,
        cwd,
      })
      return { text: formatRoleResult(result) }
    },
  })
  tools.push({
    name: 'role_worker',
    description: 'Ask the configured WORKER model to implement one self-contained task in this shared workspace, optionally following a plan and fixing supplied feedback. WORKER runs as a fresh agent with normal editing and shell tools; it does not see this conversation. Waits for its report and returns it.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete implementation task and acceptance criteria.' },
        plan: { type: 'string', description: 'The plan to follow.' },
        feedback: { type: 'string', description: 'Issues from an advisor or reviewer that the worker must address.' },
        context: { type: 'string', description: 'Additional context: files, constraints, prior decisions.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('role_worker needs a calling agent')
      const task = stringArg(args, 'task', { required: true })
      const plan = stringArg(args, 'plan', { max: LIMITS.planChars })
      const feedback = stringArg(args, 'feedback', { max: 8000 })
      const context = stringArg(args, 'context', { max: 30_000 })
      const cwd = ctx.get('workingDirectory')?.get?.(exec.agent.session)
      if (config.roles.worker !== null) await validateRoute(ctx, 'worker', config.roles.worker, exec.signal)
      const result = await runRole(ctx, config, {
        role: 'worker',
        prompt: buildWorkerPrompt({
          task,
          context,
          plan: plan ?? '(no plan supplied; decide and proceed)',
          cwd,
          round: 1,
          feedback: feedback === undefined ? [] : [feedback],
          previous: undefined,
          extra: config.prompts.worker,
        }),
        parent: exec.agent,
        signal: exec.signal,
        cwd,
      })
      if (result.status === 'completed') workerReportedDone.add(exec.agent)
      return { text: formatRoleResult(result) }
    },
  })
  tools.push({
    name: 'role_advisor',
    description: 'Ask the configured ADVISOR model, from a different model family than WORKER, to audit the current workspace and a worker report. ADVISOR runs as a fresh agent, inspects the real diff and files, and returns an approved/changes verdict with issues. It does not edit files.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task the work was supposed to complete.' },
        plan: { type: 'string', description: 'The plan the worker followed.' },
        worker_report: { type: 'string', description: 'What the worker says it changed and verified. Omit to ask ADVISOR to inspect the workspace directly.' },
        context: { type: 'string', description: 'Additional context: files, constraints, prior decisions.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('role_advisor needs a calling agent')
      const task = stringArg(args, 'task', { required: true })
      const plan = stringArg(args, 'plan', { max: LIMITS.planChars }) ?? '(no plan supplied)'
      const workerReport = stringArg(args, 'worker_report', { max: LIMITS.workerChars }) ?? '(no worker report; inspect the current workspace and judge it against the task)'
      const context = stringArg(args, 'context', { max: 20_000 })
      const cwd = ctx.get('workingDirectory')?.get?.(exec.agent.session)
      if (config.roles.advisor !== null) await validateRoute(ctx, 'advisor', config.roles.advisor, exec.signal)
      const result = await runRole(ctx, config, {
        role: 'advisor',
        prompt: buildAdvisorPrompt({ task, context, plan, cwd, workerReport, round: 1, extra: config.prompts.advisor }),
        parent: exec.agent,
        signal: exec.signal,
        cwd,
      })
      return { text: formatRoleResult(result) }
    },
  })
  tools.push({
    name: 'role_reviewer',
    description: 'Ask the configured REVIEWER model to perform the final independent gate on a completed task. REVIEWER runs only after a WORKER reports completion in this session, verifies the diff and tests from scratch, and returns an approved/changes verdict. The tool refuses before that point; use it as the last check, not as a first reviewer.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task that should now be complete.' },
        plan: { type: 'string', description: 'The plan the worker followed.' },
        worker_report: { type: 'string', description: 'What the worker says it changed and verified.' },
        advisor_verdict: { type: 'string', description: 'The advisor verdict that preceded this gate.' },
        context: { type: 'string', description: 'Additional context: files, constraints, prior decisions.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('role_reviewer needs a calling agent')
      if (!workerReportedDone.has(exec.agent)) {
        throw new Error('REVIEWER is the final gate: start a WORKER and let it report completion (role_worker or roles_run) before starting the reviewer')
      }
      const task = stringArg(args, 'task', { required: true })
      const plan = stringArg(args, 'plan', { max: LIMITS.planChars }) ?? '(no plan supplied)'
      const workerReport = stringArg(args, 'worker_report', { max: LIMITS.workerChars }) ?? '(no worker report supplied)'
      const advisorVerdict = stringArg(args, 'advisor_verdict', { max: LIMITS.verdictChars }) ?? '(no advisor verdict supplied)'
      const context = stringArg(args, 'context', { max: 20_000 })
      const cwd = ctx.get('workingDirectory')?.get?.(exec.agent.session)
      if (config.roles.reviewer !== null) await validateRoute(ctx, 'reviewer', config.roles.reviewer, exec.signal)
      const result = await runRole(ctx, config, {
        role: 'reviewer',
        prompt: buildReviewerPrompt({ task, context, plan, cwd, workerReport, advisorVerdict, extra: config.prompts.reviewer }),
        parent: exec.agent,
        signal: exec.signal,
        cwd,
      })
      return { text: formatRoleResult(result) }
    },
  })
  return tools
}

/* ------------------------------------------------------------------------- *
 * /roles command
 * ------------------------------------------------------------------------- */

/**
 * Persist one role route through the profile configuration editor.
 * @param {object} ctx Host context
 * @param {string} role role name
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null} route route, or null to inherit
 * @returns {Promise<object>} the effective configuration written by the edit
 */
async function saveRoleRoute(ctx, role, route) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || editor === null) {
    throw new Error('the configuration editor is unavailable; edit the role-team row in the profile cordis.patch.yml instead')
  }
  const entry = ctx.fiber?.entry
  if (entry === undefined || entry === null) {
    throw new Error('the role-team plugin is not mounted through the Loader; its configuration cannot be persisted')
  }
  let nextConfig
  await editor.edit(entry, current => {
    const next = isPlainObject(current) ? cloneJson(current) : {}
    const roles = isPlainObject(next.roles) ? next.roles : {}
    if (route === null) Reflect.deleteProperty(roles, role)
    else roles[role] = { provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
    if (Object.keys(roles).length === 0) Reflect.deleteProperty(next, 'roles')
    else next.roles = roles
    nextConfig = next
    return next
  })
  return nextConfig
}

/**
 * Build the client-safe role snapshot served to the settings page.
 * @param {unknown} rawConfig Loader configuration
 * @returns {object} role table with sources, families and independence warnings
 */
export function roleTeamSnapshot(rawConfig) {
  const config = resolveRoleTeamConfig(rawConfig)
  const roles = {}
  for (const role of ROLE_NAMES) {
    const route = config.roles[role] ?? null
    const problem = config.problems.find(candidate => candidate.role === role)
    roles[role] = {
      route: route === null ? null : { ...route },
      source: config.sources[role],
      family: familyOf(route),
      ...(problem === undefined ? {} : { problem: problem.message }),
    }
  }
  return {
    ok: true,
    roles,
    warnings: familyWarnings(config.roles),
    maxRounds: config.maxRounds,
    childMaxDepth: config.childMaxDepth,
  }
}

/**
 * Report whether the browser half is present in the composed client graph.
 * @param {object} ctx Host context
 * @returns {{ clientModule: boolean, rev?: string }} discovery state
 */
function clientModuleStatus(ctx) {
  try {
    const graph = ctx.get('clientModules')?.graph?.()
    if (graph === undefined) return { clientModule: false }
    const entry = graph.entries.find(candidate => candidate.id === '@local/dsh-role-team')
    return {
      clientModule: entry !== undefined,
      ...(entry === undefined ? {} : { url: entry.url }),
      rev: graph.rev,
    }
  } catch {
    return { clientModule: false }
  }
}

/**
 * Whether a hostname names this machine.
 * @param {string} hostname URL hostname
 * @returns {boolean} loopback
 */
function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Whether a Host header names a loopback authority.
 * @param {string} authority Host header value
 * @returns {boolean} loopback
 */
function isLoopbackAuthority(authority) {
  try {
    return isLoopbackHostname(new URL(`http://${authority}`).hostname)
  } catch {
    return false
  }
}

/**
 * Admit only same-origin loopback requests to the settings route.
 * @param {Request} request incoming request
 * @returns {boolean} whether the request may be served
 */
function trustedRoleRouteRequest(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  if (!isLoopbackAuthority(request.headers.get('host') ?? '')) return false
  const origin = request.headers.get('origin')
  if (origin === null || origin === '') return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Render one settings-route response.
 * @param {object} value JSON value
 * @param {number} status HTTP status
 * @returns {Response} JSON response
 */
function roleRouteJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Serve GET and POST for the role settings page.
 *
 * GET returns the effective role table. POST sets one role route or resets it
 * to the recommended default. Mutations validate the route against the live
 * adapter and persist through the profile configuration editor.
 *
 * @param {object} ctx Host context
 * @param {Request} request incoming request
 * @param {unknown} rawConfig current plugin configuration
 * @returns {Promise<Response>} response
 */
export async function handleRolesRoute(ctx, request, rawConfig) {
  if (!trustedRoleRouteRequest(request)) return roleRouteJson({ ok: false, error: 'forbidden' }, 403)
  const method = request.method.toUpperCase()
  if (method === 'GET') return roleRouteJson({ ...roleTeamSnapshot(rawConfig), client: clientModuleStatus(ctx) })
  if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
  if (method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD, POST' } })
  }
  if (request.headers.get('x-role-team-request') !== '1') {
    return roleRouteJson({ ok: false, error: 'forbidden' }, 403)
  }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 8192) {
    return roleRouteJson({ ok: false, error: 'payload too large' }, 413)
  }
  let body
  try {
    const text = await request.text()
    if (text.length > 8192) return roleRouteJson({ ok: false, error: 'payload too large' }, 413)
    body = JSON.parse(text)
  } catch {
    return roleRouteJson({ ok: false, error: 'invalid JSON body' }, 400)
  }
  if (!isPlainObject(body)) return roleRouteJson({ ok: false, error: 'invalid request body' }, 400)
  const role = typeof body.role === 'string' ? body.role.toLowerCase() : ''
  if (!ROLE_NAMES.includes(role)) return roleRouteJson({ ok: false, error: 'unknown role' }, 400)
  try {
    if (body.action === 'reset') {
      const next = await saveRoleRoute(ctx, role, null)
      return roleRouteJson(roleTeamSnapshot(next))
    }
    const parsed = normalizeRoute(body.route)
    if (parsed.error !== undefined || parsed.route === null) {
      return roleRouteJson({ ok: false, error: parsed.error ?? 'a concrete provider/model route is required' }, 400)
    }
    await validateRoute(ctx, role, parsed.route, request.signal)
    const next = await saveRoleRoute(ctx, role, parsed.route)
    return roleRouteJson(roleTeamSnapshot(next))
  } catch (error) {
    return roleRouteJson({ ok: false, error: messageOf(error) }, 400)
  }
}

/**
 * Read one HTTP request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req incoming request
 * @param {number} limit maximum bytes
 * @returns {Promise<string>} body text
 */
function readRoleRouteBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('payload too large')
        error.code = 'ROLE_TEAM_PAYLOAD_TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * Adapt the settings route to the Node HTTP carrier.
 *
 * Resource routes only answer GET and HEAD, so the page's mutations use an
 * exact WebRoute handler and the shared Fetch-shaped handler above.
 *
 * @param {object} ctx Host context
 * @param {import('node:http').IncomingMessage} req incoming request
 * @param {import('node:http').ServerResponse} res outgoing response
 * @param {unknown} rawConfig current plugin configuration
 * @returns {Promise<void>} fulfillment after the response is written
 */
async function handleRolesHttp(ctx, req, res, rawConfig) {
  try {
    const method = (req.method ?? 'GET').toUpperCase()
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : await readRoleRouteBody(req, 8192)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value)
    }
    const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? ROLES_SETTINGS_ROUTE}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
    const response = await handleRolesRoute(ctx, request, rawConfig)
    res.statusCode = response.status
    response.headers.forEach((value, name) => { res.setHeader(name, value) })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    const status = error?.code === 'ROLE_TEAM_PAYLOAD_TOO_LARGE' ? 413 : 400
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ ok: false, error: messageOf(error) }))
  }
}

/**
 * Render the current role table.
 * @param {object} config resolved configuration
 * @returns {string} text
 */
function roleTable(config) {
  const lines = ['Role team routes:']
  for (const role of ROLE_NAMES) {
    const route = config.roles[role]
    const source = config.sources[role]
    const label = route === null
      ? 'inherit session model'
      : formatRoute(route)
    const suffix = source === 'default' ? ' (recommended default)' : source === 'inherit' ? ' (inherited)' : ''
    lines.push(`  ${role.padEnd(8)} ${label}${suffix}`)
  }
  const warnings = familyWarnings(config.roles)
  if (warnings.length > 0) {
    lines.push('')
    for (const warning of warnings) lines.push(`Warning: ${warning}`)
  }
  lines.push('')
  lines.push('Commands: /roles set <role> <provider>/<model>[:effort] · /roles reset <role> · /roles models [provider] · /roles doctor · /roles run <task>')
  return lines.join('\n')
}

/**
 * Family-independence warnings for the configured routes.
 * @param {Record<string, { provider: string, model: string } | null>} roles routes
 * @returns {string[]} warnings
 */
function familyWarnings(roles) {
  const warnings = []
  const worker = familyOf(roles.worker ?? null)
  const advisor = familyOf(roles.advisor ?? null)
  const reviewer = familyOf(roles.reviewer ?? null)
  if (worker !== null && advisor !== null && worker === advisor) {
    warnings.push(`WORKER and ADVISOR both use the ${worker} family; the advisor's independence is weaker. Choose a different family for one of them.`)
  }
  if (worker !== null && reviewer !== null && worker === reviewer) {
    warnings.push(`WORKER and REVIEWER both use the ${worker} family; the final gate is not independent.`)
  }
  if (advisor !== null && reviewer !== null && advisor === reviewer) {
    warnings.push(`ADVISOR and REVIEWER both use the ${advisor} family; the final gate is not independent from the advisor.`)
  }
  if (worker === null || advisor === null || reviewer === null) {
    warnings.push('At least one of WORKER, ADVISOR or REVIEWER inherits the session model, so cross-family independence is not guaranteed.')
  }
  return warnings
}

/**
 * Validate every configured route and report independence warnings.
 * @param {object} ctx Host context
 * @param {object} config resolved configuration
 * @param {AbortSignal} signal cancellation
 * @returns {Promise<string>} report
 */
async function doctorReport(ctx, config, signal) {
  const lines = ['Role team doctor:']
  for (const role of ROLE_NAMES) {
    const route = config.roles[role]
    if (route === null) {
      lines.push(`  ${role.padEnd(8)} inherit session model`)
      continue
    }
    try {
      await validateRoute(ctx, role, route, signal)
      lines.push(`  ${role.padEnd(8)} ok — ${formatRoute(route)} (${familyOf(route) ?? 'unknown'} family; credentials are verified on the first run)`)
    } catch (error) {
      lines.push(`  ${role.padEnd(8)} FAILED — ${formatRoute(route)}: ${messageOf(error)}`)
    }
  }
  for (const problem of config.problems) {
    lines.push(`  ${problem.role.padEnd(8)} config problem: ${problem.message}`)
  }
  const warnings = familyWarnings(config.roles)
  if (warnings.length > 0) {
    lines.push('')
    for (const warning of warnings) lines.push(`Warning: ${warning}`)
  }
  return lines.join('\n')
}

/**
 * List registered providers and their advertised models.
 * @param {object} ctx Host context
 * @param {string | undefined} providerArg one provider id
 * @returns {Promise<string>} report
 */
async function modelsReport(ctx, providerArg) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null) throw new Error('the LLM service is unavailable')
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  if (providerArg !== undefined) {
    const provider = providers.find(candidate => candidate.id === providerArg)
    if (provider === undefined) {
      const available = providers.map(candidate => candidate.id).join(', ') || '(none)'
      throw new Error(`provider "${providerArg}" is not registered; available providers: ${available}`)
    }
    let models = []
    try {
      models = await llm.listModels(providerArg)
    } catch (error) {
      throw new Error(`provider "${providerArg}" could not list models: ${messageOf(error)}`)
    }
    const lines = [`Models for ${provider.name ?? providerArg} (${providerArg}):`]
    for (const model of models) lines.push(`  ${model.id}${model.name === undefined || model.name === model.id ? '' : ` — ${model.name}`}`)
    if (models.length === 0) lines.push('  (the adapter advertises no models)')
    return clip(lines.join('\n'), LIMITS.reportChars)
  }
  const lines = ['Registered providers:']
  for (const provider of providers) {
    let count = '?'
    try {
      const models = await llm.listModels(provider.id)
      count = String(models.length)
    } catch {
      count = 'unavailable'
    }
    lines.push(`  ${provider.id} — ${provider.name ?? provider.id} (${count} models)`)
  }
  if (providers.length === 0) lines.push('  (none)')
  lines.push('')
  lines.push('Use /roles models <provider> to list model ids.')
  return lines.join('\n')
}

/**
 * Execute one `/roles` command line.
 * @param {object} ctx Host context
 * @param {object} config resolved configuration
 * @param {{ agent: object, rawInput: string, signal: AbortSignal }} invocation command invocation
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} command result
 */
async function handleRolesCommand(ctx, config, invocation) {
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  if (raw === '') return { kind: 'success', text: roleTable(config) }
  const space = raw.search(/\s/)
  const verb = (space < 0 ? raw : raw.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : raw.slice(space + 1).trim()
  try {
    if (verb === 'set') {
      const [roleToken, ...routeTokens] = rest.split(/\s+/).filter(Boolean)
      if (roleToken === undefined || routeTokens.length === 0) {
        throw new Error('usage: /roles set <plan|worker|advisor|reviewer> <provider>/<model>[:effort]')
      }
      const role = roleToken.toLowerCase()
      if (!ROLE_NAMES.includes(role)) throw new Error(`unknown role "${roleToken}"; choose one of ${ROLE_NAMES.join(', ')}`)
      const parsed = normalizeRoute(routeTokens.join(' '))
      if (parsed.error !== undefined || parsed.route === null) {
        throw new Error(parsed.error ?? 'a concrete provider/model route is required; use /roles reset to inherit the session model')
      }
      await validateRoute(ctx, role, parsed.route, invocation.signal)
      await saveRoleRoute(ctx, role, parsed.route)
      return { kind: 'success', text: `Role ${role} now uses ${formatRoute(parsed.route)}. The route resolves; credentials are verified by the first role run. Applied and saved to the profile patch.` }
    }
    if (verb === 'reset') {
      const role = rest.toLowerCase()
      if (!ROLE_NAMES.includes(role)) throw new Error(`unknown role "${rest}"; choose one of ${ROLE_NAMES.join(', ')}`)
      await saveRoleRoute(ctx, role, null)
      return { kind: 'success', text: `Role ${role} reset to the recommended default (or the inherited session model when no default is configured).` }
    }
    if (verb === 'models') {
      return { kind: 'success', text: await modelsReport(ctx, rest === '' ? undefined : rest) }
    }
    if (verb === 'doctor') {
      return { kind: 'success', text: await doctorReport(ctx, config, invocation.signal) }
    }
    if (verb === 'run') {
      if (rest === '') throw new Error('usage: /roles run <task>')
      const outcome = await runRoleTeam(ctx, {
        agent: invocation.agent,
        task: rest,
        signal: invocation.signal,
        config,
      })
      return { kind: outcome.status === 'approved' ? 'success' : 'error', text: outcome.report }
    }
    throw new Error(`unknown /roles subcommand "${verb}"; use set, reset, models, doctor or run`)
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
}

/**
 * Register the `/roles` command when the commands service is available.
 * @param {object} ctx Host context
 * @param {object} config resolved configuration
 * @returns {void}
 */
function registerRolesCommand(ctx, config) {
  const commands = ctx.get('commands')
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return
  ctx.effect(() => commands.register({
    name: 'roles',
    description: 'Show or change the role team models, check role routes, or run the full role team.',
    input: { hint: '[set <role> <provider>/<model>[:effort] | reset <role> | models [provider] | doctor | run <task>]' },
    handler: invocation => handleRolesCommand(ctx, config, invocation),
  }))
}

/* ------------------------------------------------------------------------- *
 * Plugin entry
 * ------------------------------------------------------------------------- */

/**
 * Install the role team surface.
 * @param {object} ctx Host plugin context
 * @param {unknown} rawConfig Loader configuration
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveRoleTeamConfig(rawConfig)
  for (const problem of config.problems) {
    ctx.logger?.warn?.(`role-team: role ${problem.role} ${problem.message}`)
  }
  for (const tool of buildTools(ctx, config)) registerTool(ctx, tool)
  registerRolesCommand(ctx, config)
  ctx.inject(['webServer'], routeCtx => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: ROLES_SETTINGS_ROUTE,
      handler: (req, res) => handleRolesHttp(ctx, req, res, rawConfig),
    }), 'role-team: settings route')
  })
  const order = typeof ctx.systemPrompt?.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 10
    : 2810
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:role-team',
    order,
    text: ROLE_GUIDANCE,
  }))
}
