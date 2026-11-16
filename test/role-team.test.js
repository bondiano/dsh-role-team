import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  buildPlanAuditPrompt,
  buildPlanPrompt,
  familyOf,
  formatRoute,
  handlePlanSessionRequest,
  handleRolePlanCommand,
  handleRolesRoute,
  handleRunStateRequest,
  normalizeRoute,
  parseVerdict,
  resolveRoleTeamConfig,
  roleTeamSnapshot,
  runStateOf,
} from '../index.js'

const AGENT = { session: { id: 'session-1' } }
const SIGNAL = new AbortController().signal

/**
 * Build a fake Host context with the services the plugin consumes.
 * @param {{ config?: object, responses?: Record<string, string[] | ((prompt: string, index: number) => string)>, llm?: object, userAnswers?: Record<string, string> | ((id: string) => string), cwd?: string }} options harness options
 * @returns {object} fake harness
 */
function makeHarness(options = {}) {
  const tools = new Map()
  const commands = new Map()
  const calls = []
  const created = []
  const prompted = []
  const renamed = []
  const attached = []
  const entry = { id: 'role-team', options: { config: options.config ?? {} } }
  const responses = options.responses ?? {}
  const counters = new Map()
  const services = {
    subagents: {
      getProvider(name) {
        return name === 'spawn'
          ? { name: 'spawn', capabilities: { depthLimit: true, agentOptions: true } }
          : undefined
      },
      async startActivation(request) {
        const role = request.label.startsWith('role ') ? request.label.slice(5) : 'unknown'
        const prompt = request.prompt?.[0]?.text ?? ''
        calls.push({ role, prompt, name: request.name, agentOptions: request.agentOptions })
        const index = (counters.get(role) ?? 0) + 1
        counters.set(role, index)
        const queue = responses[role]
        let reply
        if (typeof queue === 'function') reply = queue(prompt, index)
        else if (Array.isArray(queue)) reply = queue[index - 1]
        if (typeof reply === 'function') reply = reply(prompt, index)
        const text = reply ?? `default ${role} ${index}`
        return {
          name: request.name,
          childId: `child-${calls.length}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    llm: options.llm ?? {
      async resolveCallConfig() {
        return {}
      },
      listProviders() {
        return [
          { id: 'openai-codex', name: 'OpenAI Codex' },
          { id: 'opencode-go', name: 'OpenCode Go' },
          { id: 'zai', name: 'ZAI' },
        ]
      },
      async listModels(provider) {
        return [{ id: `${provider}-model`, name: `${provider} model` }]
      },
    },
    workingDirectory: { get: () => options.cwd ?? '/workspace' },
    configEditor: {
      async edit(targetEntry, change) {
        targetEntry.options.config = change(targetEntry.options.config)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
  }
  if (options.userAnswers !== undefined) {
    services.userQuestions = {
      async ask(request) {
        const questions = Array.isArray(request.questions) ? request.questions : []
        const answers = questions.map(question => {
          const label = typeof options.userAnswers === 'function'
            ? options.userAnswers(question.id)
            : options.userAnswers[question.id]
          return { id: question.id, selected: typeof label === 'string' && label !== '' ? [label] : [] }
        })
        return { answers }
      },
    }
  }
  if (options.sessionController !== false) {
    services.sessionController = {
      async create(request) {
        created.push(request)
        if (options.createError !== undefined) throw options.createError
        return { sessionId: request.sessionId }
      },
      async prompt(request) {
        prompted.push(request)
        if (options.promptError !== undefined) throw options.promptError
      },
      async rename(request) {
        renamed.push(request)
        if (options.renameError !== undefined) throw options.renameError
      },
    }
  }
  if (options.workspace !== false) {
    services.workspaceRegistry = {
      async resolveByPath() {
        return options.workspace ?? { attachSession: async sessionId => { attached.push(sessionId) } }
      },
    }
  }
  const ctx = {
    fiber: { entry },
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      return services[name]
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      getSectionOrder() {
        return 2800
      },
      section() {
        return () => {}
      },
      context() {
        return () => {}
      },
    },
  }
  ctx.inject = (deps, callback) => {
    if (deps.every(name => services[name] !== undefined)) callback(ctx)
  }
  apply(ctx, options.config ?? {})
  return { ctx, tools, commands, calls, created, prompted, renamed, attached, entry }
}

/** A strict JSON verdict for canned role output. */
function verdict(approved, issues = [], summary = '') {
  return JSON.stringify({ approved, summary, issues })
}

test('resolveRoleTeamConfig applies defaults, overrides and inheritance', () => {
  const defaults = resolveRoleTeamConfig({})
  assert.deepEqual(defaults.roles.plan, { provider: 'opencode-go', model: 'gpt-6-luna' })
  assert.equal(defaults.sources.plan, 'default')
  assert.equal(defaults.maxRounds, 3)
  assert.equal(defaults.maxPlanPasses, 2)
  assert.equal(defaults.childMaxDepth, 2)

  const custom = resolveRoleTeamConfig({
    roles: {
      worker: 'zai/glm-5.3:high',
      advisor: null,
      reviewer: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'high' },
    },
    maxRounds: 5,
    maxPlanPasses: 9,
    childMaxDepth: 3,
    prompts: { worker: '  be terse  ', unknown: 'ignored' },
  })
  assert.deepEqual(custom.roles.worker, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' })
  assert.equal(custom.roles.advisor, null)
  assert.equal(custom.sources.advisor, 'inherit')
  assert.deepEqual(custom.roles.reviewer, { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'high' })
  assert.equal(custom.maxRounds, 5)
  assert.equal(custom.maxPlanPasses, 3)
  assert.equal(custom.childMaxDepth, 3)
  assert.deepEqual(custom.prompts, { worker: 'be terse' })

  const invalid = resolveRoleTeamConfig({ roles: { worker: 'no-slash' } })
  assert.equal(invalid.roles.worker, null)
  assert.equal(invalid.problems.length, 1)
  assert.match(invalid.problems[0].message, /not a <provider>\/<model> route/)
})

test('normalizeRoute accepts strings, objects, and inheritance', () => {
  assert.deepEqual(normalizeRoute('openai-codex/gpt-6-sol'), {
    route: { provider: 'openai-codex', model: 'gpt-6-sol' },
  })
  assert.deepEqual(normalizeRoute('openrouter/anthropic/claude-sonnet-5:high'), {
    route: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', reasoningEffort: 'high' },
  })
  assert.deepEqual(normalizeRoute('openrouter/anthropic/claude-sonnet-5'), {
    route: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
  })
  assert.deepEqual(normalizeRoute({ inherit: true }), { route: null })
  assert.equal(normalizeRoute('').route, null)
  assert.match(normalizeRoute('broken').error, /not a <provider>\/<model> route/)
  assert.match(normalizeRoute({ provider: 'zai' }).error, /non-empty provider and model/)
})

test('formatRoute and familyOf describe routes and model families', () => {
  assert.equal(formatRoute(null), 'inherit session model')
  assert.equal(formatRoute({ provider: 'zai', model: 'glm-5.3' }), 'zai/glm-5.3')
  assert.equal(formatRoute({ provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' }), 'zai/glm-5.3 @high')
  assert.equal(familyOf({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }), 'deepseek')
  assert.equal(familyOf({ provider: 'opencode-go', model: 'glm-5.2' }), 'zai')
  assert.equal(familyOf({ provider: 'openai-codex', model: 'gpt-6-sol' }), 'openai')
  assert.equal(familyOf({ provider: 'zai', model: 'claude-opus-5' }), 'anthropic')
  assert.equal(familyOf({ provider: 'local', model: 'my-model' }), 'local')
  assert.equal(familyOf(null), null)
})

test('parseVerdict prefers strict JSON and never approves on a stray word', () => {
  const approved = parseVerdict(verdict(true, [], 'all good'))
  assert.equal(approved.approved, true)
  assert.equal(approved.parsed, true)
  assert.equal(approved.summary, 'all good')

  const rejected = parseVerdict(verdict(false, [{ severity: 'blocker', detail: 'test fails' }]))
  assert.equal(rejected.approved, false)
  assert.deepEqual(rejected.issues, [{ severity: 'blocker', detail: 'test fails' }])

  const fenced = parseVerdict('Here is my verdict:\n```json\n' + verdict(true) + '\n```')
  assert.equal(fenced.approved, true)
  assert.equal(fenced.parsed, true)

  const contradictory = parseVerdict(verdict(true, [{ severity: 'major', detail: 'still broken' }]))
  assert.equal(contradictory.approved, false)
  assert.equal(contradictory.issues.length, 1)

  assert.equal(parseVerdict('APPROVED.').approved, true)
  assert.equal(parseVerdict('I would approve after fixing X.').approved, false)
  assert.equal(parseVerdict('Approved, but blocker: none really').approved, false)
  assert.equal(parseVerdict('').approved, false)
})

test('roles_run audits the plan, revises it, and gates REVIEWER behind ADVISOR', async () => {
  const harness = makeHarness({
    responses: {
      plan: ['STEPS:\n1. Implement X\nVERIFY: npm test', 'STEPS:\n1. Implement X (revised)\nVERIFY: npm test'],
      worker: ['CHANGES: first\nSTATUS: done', 'CHANGES: second\nSTATUS: done'],
      advisor: [
        verdict(false, [{ severity: 'blocker', detail: 'plan misses tests' }]),
        verdict(true, [], 'plan is good'),
        verdict(true, [], 'work is right'),
        verdict(true, [], 'work is right again'),
      ],
      reviewer: [
        verdict(false, [{ severity: 'major', detail: 'second issue' }]),
        verdict(true, [], 'verified'),
      ],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute(
    { task: 'Implement X and prove it' },
    { agent: AGENT, signal: SIGNAL },
  )
  assert.equal(outcome.status, 'approved')
  assert.match(outcome.text, /Role team: APPROVED after 2 round\(s\)/)
  assert.equal(harness.calls.filter(call => call.role === 'plan').length, 2)
  assert.equal(harness.calls.filter(call => call.role === 'worker').length, 2)
  assert.equal(harness.calls.filter(call => call.role === 'reviewer').length, 2)

  const roles = harness.calls.map(call => call.role)
  assert.deepEqual(roles, ['plan', 'advisor', 'plan', 'advisor', 'worker', 'advisor', 'reviewer', 'worker', 'advisor', 'reviewer'])

  const workers = harness.calls.filter(call => call.role === 'worker')
  assert.ok(!workers[0].prompt.includes('plan misses tests'))
  assert.ok(workers[1].prompt.includes('[major] second issue'))

  const planCalls = harness.calls.filter(call => call.role === 'plan')
  assert.ok(planCalls[1].prompt.includes('plan misses tests'))

  assert.match(outcome.text, /ADVISOR AND REVIEWER COMMENTS/)
  assert.match(outcome.text, /plan audit 1/)
  assert.match(outcome.text, /REVIEWER \(opencode-go\/qwen3\.8-max\) — round 2 final gate — APPROVED/)
})

test('roles_run with a supplied plan skips PLAN, audits the plan, and gates on REVIEWER', async () => {
  const harness = makeHarness({
    responses: {
      worker: ['CHANGES: done\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(true, [], 'work ok')],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute(
    { task: 'Fix the bug', plan: '1. Edit a.js' },
    { agent: AGENT, signal: SIGNAL },
  )
  assert.match(outcome.text, /APPROVED/)
  const roles = harness.calls.map(call => call.role)
  assert.deepEqual(roles, ['advisor', 'worker', 'advisor', 'reviewer'])
  assert.match(outcome.text, /Fix the bug/)
})

test('plan issues that survive every audit pass reach the WORKER prompt', async () => {
  const harness = makeHarness({
    responses: {
      plan: ['STEPS:\n1. Do it', 'STEPS:\n1. Do it better'],
      worker: ['CHANGES: done\nSTATUS: done'],
      advisor: [
        verdict(false, [{ severity: 'blocker', detail: 'no verification commands' }]),
        verdict(false, [{ severity: 'major', detail: 'acceptance checks missing' }]),
        verdict(true, [], 'work ok'),
      ],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  await harness.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  const worker = harness.calls.find(call => call.role === 'worker')
  assert.ok(worker.prompt.includes('acceptance checks missing'))
})

test('the PLAN prompt demands the four labeled plan parts', () => {
  const prompt = buildPlanPrompt({ task: 'Build the feature', cwd: '/w' })
  for (const part of ['STEPS:', 'RISKS:', 'VERIFY:', 'ACCEPT:']) {
    assert.ok(prompt.includes(part), `the prompt is missing ${part}`)
  }
  assert.ok(prompt.includes('exact file or module path'))
  const auditPrompt = buildPlanAuditPrompt({ task: 'Build the feature', plan: '1. Do it', cwd: '/w' })
  assert.ok(auditPrompt.includes('auditing the PLAN'))
  assert.ok(auditPrompt.includes('good enough to implement'))
})

test('roles_run refuses an invalid configured role before starting any child', async () => {
  const harness = makeHarness({ config: { roles: { worker: 'broken' } } })
  await assert.rejects(
    harness.tools.get('roles_run').execute({ task: 'do work' }, { agent: AGENT, signal: SIGNAL }),
    /configuration is invalid: worker/,
  )
  assert.equal(harness.calls.length, 0)
})

test('roles_run surfaces a route validation failure with the role name', async () => {
  const harness = makeHarness({
    llm: {
      async resolveCallConfig(config) {
        if (config.model === 'glm-5.3') throw new Error('no credential')
        return {}
      },
      listProviders() {
        return []
      },
      async listModels() {
        return []
      },
    },
  })
  await assert.rejects(
    harness.tools.get('roles_run').execute({ task: 'do work' }, { agent: AGENT, signal: SIGNAL }),
    /role advisor route opencode-go\/glm-5.3 is not usable: no credential/,
  )
  assert.equal(harness.calls.length, 0)
})

test('role_reviewer refuses to run before a worker reports completion', async () => {
  const harness = makeHarness({
    responses: {
      worker: ['CHANGES: done\nSTATUS: done'],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const reviewer = harness.tools.get('role_reviewer')
  await assert.rejects(
    reviewer.execute({ task: 'check it' }, { agent: AGENT, signal: SIGNAL }),
    /REVIEWER is the final gate/,
  )
  await harness.tools.get('role_worker').execute({ task: 'do it' }, { agent: AGENT, signal: SIGNAL })
  const result = await reviewer.execute({ task: 'check it', worker_report: 'done' }, { agent: AGENT, signal: SIGNAL })
  assert.match(result.text, /Role REVIEWER/)
})

test('/roles status reports routes and /roles set persists a route', async () => {
  const harness = makeHarness()
  const command = harness.commands.get('roles')
  assert.ok(command)

  const status = await command.handler({ agent: AGENT, rawInput: '', signal: SIGNAL })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /plan\s+opencode-go\/gpt-6-luna \(recommended default\)/)
  assert.match(status.text, /worker\s+opencode-go\/deepseek-v4\.1-flash/)

  const saved = await command.handler({ agent: AGENT, rawInput: 'set worker zai/glm-5.3:high', signal: SIGNAL })
  assert.equal(saved.kind, 'success')
  assert.deepEqual(harness.entry.options.config.roles.worker, {
    provider: 'zai',
    model: 'glm-5.3',
    reasoningEffort: 'high',
  })

  const reset = await command.handler({ agent: AGENT, rawInput: 'reset worker', signal: SIGNAL })
  assert.equal(reset.kind, 'success')
  assert.equal(harness.entry.options.config.roles?.worker, undefined)
})

test('/roles doctor reports route failures and family independence warnings', async () => {
  const harness = makeHarness({
    config: {
      roles: {
        worker: 'opencode-go/deepseek-v4.1-flash',
        advisor: 'opencode-go/deepseek-v4-pro',
        reviewer: 'zai/glm-5.3',
      },
    },
    llm: {
      async resolveCallConfig(config) {
        if (config.model === 'deepseek-v4-pro') throw new Error('model is unavailable')
        return {}
      },
      listProviders() {
        return []
      },
      async listModels() {
        return []
      },
    },
  })
  const result = await harness.commands.get('roles').handler({ agent: AGENT, rawInput: 'doctor', signal: SIGNAL })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /advisor\s+FAILED/)
  assert.match(result.text, /WORKER and ADVISOR both use the deepseek family/)
})


test('roleTeamSnapshot exposes routes, sources, families and warnings', () => {
  const snapshot = roleTeamSnapshot({})
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.roles.plan.route, { provider: 'opencode-go', model: 'gpt-6-luna' })
  assert.equal(snapshot.roles.plan.source, 'default')
  assert.equal(snapshot.roles.plan.family, 'openai')
  assert.deepEqual(snapshot.roles.worker.route, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(snapshot.roles.reviewer.family, 'qwen')
  assert.equal(snapshot.warnings.length, 0)

  const inherited = roleTeamSnapshot({ roles: { advisor: null } })
  assert.equal(inherited.roles.advisor.route, null)
  assert.equal(inherited.roles.advisor.source, 'inherit')
  assert.equal(inherited.warnings.length, 1)
})

test('the settings route serves GET, requires the mutation header, and persists POST', async () => {
  const harness = makeHarness()
  const url = 'http://127.0.0.1:62592/plugin-api/role-team/roles'
  const host = { host: '127.0.0.1:62592' }

  const get = await handleRolesRoute(harness.ctx, new Request(url, { headers: host }), {})
  assert.equal(get.status, 200)
  const snapshot = await get.json()
  assert.equal(snapshot.roles.worker.route.model, 'deepseek-v4.1-flash')

  const forbidden = await handleRolesRoute(harness.ctx, new Request(url, {
    method: 'POST',
    headers: { ...host, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'worker', route: { provider: 'zai', model: 'glm-5.3' } }),
  }), {})
  assert.equal(forbidden.status, 403)

  const post = await handleRolesRoute(harness.ctx, new Request(url, {
    method: 'POST',
    headers: { ...host, 'content-type': 'application/json', 'x-role-team-request': '1' },
    body: JSON.stringify({ role: 'worker', route: { provider: 'zai', model: 'glm-5.3' } }),
  }), {})
  assert.equal(post.status, 200)
  const saved = await post.json()
  assert.deepEqual(saved.roles.worker.route, { provider: 'zai', model: 'glm-5.3' })
  assert.equal(saved.roles.worker.source, 'config')
  assert.deepEqual(harness.entry.options.config.roles.worker, { provider: 'zai', model: 'glm-5.3' })

  const reset = await handleRolesRoute(harness.ctx, new Request(url, {
    method: 'POST',
    headers: { ...host, 'content-type': 'application/json', 'x-role-team-request': '1' },
    body: JSON.stringify({ role: 'worker', action: 'reset' }),
  }), harness.entry.options.config)
  assert.equal(reset.status, 200)
  const resetSnapshot = await reset.json()
  assert.equal(resetSnapshot.roles.worker.source, 'default')
})

test('the settings route rejects cross-site and unknown-role writes', async () => {
  const harness = makeHarness()
  const url = 'http://127.0.0.1:62592/plugin-api/role-team/roles'
  const crossSite = await handleRolesRoute(harness.ctx, new Request(url, {
    headers: { host: '127.0.0.1:62592', 'sec-fetch-site': 'cross-site' },
  }), {})
  assert.equal(crossSite.status, 403)

  const unknown = await handleRolesRoute(harness.ctx, new Request(url, {
    method: 'POST',
    headers: { host: '127.0.0.1:62592', 'content-type': 'application/json', 'x-role-team-request': '1' },
    body: JSON.stringify({ role: 'nope', route: { provider: 'zai', model: 'glm-5.3' } }),
  }), {})
  assert.equal(unknown.status, 400)
})

test('exhaustion asks the user and honors retry, continue, stop and model choices', async () => {
  const retry = makeHarness({
    config: { maxRounds: 1 },
    userAnswers: { exhaustion: 'Try 3 more rounds' },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done', 'CHANGES: two\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(false, [{ severity: 'major', detail: 'not done' }]), verdict(true, [], 'ok now')],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const retryOutcome = await retry.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(retryOutcome.status, 'approved')
  assert.equal(retry.calls.filter(call => call.role === 'worker').length, 2)
  assert.match(retryOutcome.text, /DECISIONS/)
  assert.match(retryOutcome.text, /- retry/)
  assert.deepEqual(retryOutcome.decisions.map(decision => decision.choice), ['retry'])

  const continued = makeHarness({
    config: { maxRounds: 1 },
    userAnswers: { exhaustion: 'Continue without approval' },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(false, [{ severity: 'major', detail: 'still broken' }])],
    },
  })
  const continuedOutcome = await continued.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(continuedOutcome.status, 'continued')
  assert.match(continuedOutcome.text, /CONTINUED WITHOUT APPROVAL/)
  assert.match(continuedOutcome.text, /still broken/)
  assert.match(continuedOutcome.text, /- continue/)

  const stopped = makeHarness({
    config: { maxRounds: 1 },
    userAnswers: { exhaustion: 'Stop' },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(false, [{ severity: 'major', detail: 'still broken' }])],
    },
  })
  const stoppedOutcome = await stopped.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(stoppedOutcome.status, 'unapproved')
  assert.match(stoppedOutcome.text, /- stop/)

  const model = makeHarness({
    config: { maxRounds: 1 },
    userAnswers: { exhaustion: 'Change the WORKER model', 'worker-model': 'zai/zai-model' },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done', 'CHANGES: two\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(false, [{ severity: 'major', detail: 'not done' }]), verdict(true, [], 'ok now')],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const modelOutcome = await model.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(modelOutcome.status, 'approved')
  const laterWorker = model.calls.filter(call => call.role === 'worker').at(-1)
  assert.deepEqual(laterWorker.agentOptions, { provider: 'zai', model: 'zai-model' })
  assert.match(modelOutcome.text, /- model → zai\/zai-model/)
})

test('exhaustion without an answerer ends NOT APPROVED with a note', async () => {
  const harness = makeHarness({
    config: { maxRounds: 1 },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(false, [{ severity: 'major', detail: 'still broken' }])],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(outcome.status, 'unapproved')
  assert.match(outcome.text, /no interactive answerer/)
  assert.match(outcome.text, /- none/)
})

test('the exhaustion retry respects the hard attempt cap', async () => {
  const harness = makeHarness({
    config: { maxRounds: 6 },
    userAnswers: { exhaustion: 'Try 3 more rounds' },
    responses: {
      plan: ['STEPS:\n1. Do it'],
      advisor: [verdict(true, [], 'plan ok')],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(outcome.status, 'unapproved')
  assert.equal(harness.calls.filter(call => call.role === 'worker').length, 12)
  assert.match(outcome.text, /hard cap of 12 worker attempts/)
  assert.deepEqual(outcome.decisions.map(decision => decision.choice), ['retry', 'retry', 'retry'])
})

/** A loopback request for one plan-session marker. */
function planRouteRequest(sessionId, headers = { host: '127.0.0.1:62592' }) {
  return new Request(`http://127.0.0.1:62592/plugin-api/role-team/plan-session/${encodeURIComponent(sessionId)}`, { headers })
}

test('/role-plan starts the run in a dedicated session instead of the current one', async () => {
  const taskHarness = makeHarness({ cwd: '/workspace' })
  const command = taskHarness.commands.get('role-plan')
  assert.ok(command)

  const usage = await command.handler({ agent: AGENT, rawInput: '', signal: SIGNAL })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /usage: \/role-plan/)

  const taskRun = await command.handler({ agent: AGENT, rawInput: 'Implement Y', signal: SIGNAL })
  assert.equal(taskRun.kind, 'success')
  assert.match(taskRun.text, /started in a new session/)
  assert.equal(taskHarness.calls.length, 0, 'the current session runs no role')

  assert.equal(taskHarness.created.length, 1)
  const sessionId = taskHarness.created[0].sessionId
  assert.match(sessionId, /^session-/)
  assert.equal(taskHarness.created[0].cwd, '/workspace')
  assert.deepEqual(taskHarness.attached, [sessionId])
  assert.equal(taskHarness.renamed.length, 1)
  assert.match(taskHarness.renamed[0].title, /^Role plan: Implement Y$/)

  assert.equal(taskHarness.prompted.length, 1)
  const prompt = taskHarness.prompted[0]
  assert.equal(prompt.sessionId, sessionId)
  assert.equal(prompt.mode, 'queue')
  assert.match(prompt.requestId, /^role-plan-/)
  const text = prompt.content[0].text
  assert.ok(text.includes('Implement Y'))
  assert.match(text, /call the `roles_run` tool exactly once/i)
  assert.match(text, /Do not implement anything yourself/)
  assert.ok(taskRun.text.includes(sessionId))

  const claim = handlePlanSessionRequest(taskHarness.ctx, planRouteRequest(sessionId))
  assert.equal(claim.status, 200)
  assert.deepEqual(await claim.json(), { ok: true, sessionId })
  const replay = handlePlanSessionRequest(taskHarness.ctx, planRouteRequest(sessionId))
  assert.equal(replay.status, 404, 'a claimed marker never opens the session twice')
})

test('/role-plan reads a plan file and hands it to the new session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'role-plan-'))
  const file = join(dir, 'plan.md')
  await writeFile(file, '# Plan\n\n1. Edit a.js\n2. Test a.js\n', 'utf8')
  await writeFile(join(dir, 'empty.md'), '   \n', 'utf8')

  const harness = makeHarness({ cwd: dir })
  const command = harness.commands.get('role-plan')
  const run = await command.handler({ agent: AGENT, rawInput: 'plan.md', signal: SIGNAL })
  assert.equal(run.kind, 'success')
  assert.equal(harness.created[0].cwd, dir)
  const text = harness.prompted[0].content[0].text
  assert.ok(text.includes('1. Edit a.js'))
  assert.ok(text.includes('Execute the plan in plan.md exactly.'))
  assert.match(text, /<<<PLAN/)

  const empty = await command.handler({ agent: AGENT, rawInput: 'empty.md', signal: SIGNAL })
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /is empty/)

  const missing = await command.handler({ agent: AGENT, rawInput: 'no-such.md', signal: SIGNAL })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /could not read the plan file/)
  assert.equal(harness.created.length, 1, 'a rejected input starts nothing')
})

test('/role-plan reports a Host without a session controller or a failed start', async () => {
  const bare = makeHarness({ sessionController: false })
  const result = await handleRolePlanCommand(bare.ctx, resolveRoleTeamConfig({}), { agent: AGENT, rawInput: 'plain task', signal: SIGNAL })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no session controller/)
  assert.equal(bare.calls.length, 0)

  const failing = makeHarness({ createError: new Error('claim exploded') })
  const failed = await handleRolePlanCommand(failing.ctx, resolveRoleTeamConfig({}), { agent: AGENT, rawInput: 'task', signal: SIGNAL })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /could not create the role-team session: claim exploded/)
  assert.equal(handlePlanSessionRequest(failing.ctx, planRouteRequest(failing.created[0].sessionId)).status, 404, 'a failed creation leaves no marker')

  const unprompted = makeHarness({ promptError: new Error('no admission') })
  const stuck = await handleRolePlanCommand(unprompted.ctx, resolveRoleTeamConfig({}), { agent: AGENT, rawInput: 'task', signal: SIGNAL })
  assert.equal(stuck.kind, 'error')
  assert.match(stuck.text, /was created, but the run could not be started: no admission/)

  const renameFails = makeHarness({ renameError: new Error('title taken') })
  const stillRuns = await handleRolePlanCommand(renameFails.ctx, resolveRoleTeamConfig({}), { agent: AGENT, rawInput: 'task', signal: SIGNAL })
  assert.equal(stillRuns.kind, 'success', 'a title failure never blocks the run')
  assert.equal(renameFails.prompted.length, 1)
})

test('the plan session route is loopback-guarded and one-shot', () => {
  const harness = makeHarness()
  const unknown = handlePlanSessionRequest(harness.ctx, planRouteRequest('session-unknown'))
  assert.equal(unknown.status, 404)
  const crossSite = handlePlanSessionRequest(harness.ctx, planRouteRequest('session-unknown', {
    host: '127.0.0.1:62592',
    'sec-fetch-site': 'cross-site',
  }))
  assert.equal(crossSite.status, 403)
  const nested = handlePlanSessionRequest(harness.ctx, new Request('http://127.0.0.1:62592/plugin-api/role-team/plan-session/a/b', {
    headers: { host: '127.0.0.1:62592' },
  }))
  assert.equal(nested.status, 404)
})

test('the tools carry structured presentation metadata', async () => {
  const harness = makeHarness({
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: done\nSTATUS: done'],
      advisor: [verdict(true, [], 'plan ok'), verdict(true, [], 'work ok')],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const runTool = harness.tools.get('roles_run')
  const value = await runTool.execute({ task: 'Do it' }, { agent: AGENT, signal: SIGNAL })
  const meta = runTool.output.presentationMeta({}, value)
  assert.equal(meta.tool, 'roles_run')
  assert.equal(meta.status, 'approved')
  assert.equal(meta.stages.length, 5)
  assert.ok(meta.stages.every(stage => stage.route === null || (typeof stage.route === 'object' && typeof stage.route.model === 'string')))
  assert.ok(meta.comments.some(comment => comment.stage === 'plan audit 1' && comment.approved === true))
  assert.ok(meta.comments.some(comment => comment.role === 'reviewer' && comment.approved === true))
  assert.equal(value.rounds[0].worker.route.model, 'deepseek-v4.1-flash')
  assert.equal(value.planAudits[0].route.model, 'glm-5.3')

  const advisorTool = harness.tools.get('role_advisor')
  const advisorValue = await advisorTool.execute({ task: 'check it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(advisorValue.role, 'advisor')
  assert.equal(advisorValue.route.model, 'glm-5.3')
  const advisorMeta = advisorTool.output.presentationMeta({}, advisorValue)
  assert.equal(advisorMeta.tool, 'role_advisor')
  assert.equal(advisorMeta.role, 'advisor')
  assert.equal(advisorMeta.route.model, 'glm-5.3')
  assert.equal(typeof advisorMeta.verdict.approved, 'boolean')

  const planTool = harness.tools.get('role_plan')
  const planValue = await planTool.execute({ task: 'plan it' }, { agent: AGENT, signal: SIGNAL })
  assert.equal(planValue.role, 'plan')
  assert.ok(planValue.verdict === undefined)
  assert.match(planValue.text, /Role PLAN/)
})

test('the live run state tracks stages and is served by the run route', async () => {
  let midRun
  let routeSnapshot
  const harness = makeHarness({
    responses: {
      plan: ['STEPS:\n1. Do it'],
      worker: ['CHANGES: one\nSTATUS: done', (prompt, index) => {
        if (index === 2) {
          midRun = runStateOf('call-1')
          routeSnapshot = handleRunStateRequest(harness.ctx, new Request('http://127.0.0.1:62592/plugin-api/role-team/run/call-1', { headers: { host: '127.0.0.1:62592' } }))
        }
        return 'CHANGES: two\nSTATUS: done'
      }],
      advisor: [verdict(true, [], 'plan ok'), verdict(true, [], 'ok'), verdict(true, [], 'ok again')],
      reviewer: [verdict(false, [{ severity: 'major', detail: 'one more' }]), verdict(true, [], 'approved')],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute(
    { task: 'Do it' },
    { agent: AGENT, signal: SIGNAL, callId: 'call-1' },
  )
  assert.equal(outcome.status, 'approved')
  assert.equal(runStateOf('call-1'), undefined)

  assert.ok(midRun !== undefined)
  assert.equal(midRun.tool, 'roles_run')
  assert.equal(midRun.currentRole, 'worker')
  assert.deepEqual(midRun.stages.map(stage => stage.role), ['plan', 'advisor', 'worker', 'advisor', 'reviewer', 'worker'])
  assert.equal(midRun.stages.at(-1).status, 'running')
  assert.equal(midRun.stages[0].status, 'done')
  assert.equal(midRun.stages[0].route.model, 'gpt-6-luna')

  assert.ok(routeSnapshot !== undefined)
  assert.equal(routeSnapshot.status, 200)
  const body = await routeSnapshot.json()
  assert.equal(body.ok, true)
  assert.equal(body.run.stages.at(-1).role, 'worker')

  const unknown = handleRunStateRequest(harness.ctx, new Request('http://127.0.0.1:62592/plugin-api/role-team/run/missing', { headers: { host: '127.0.0.1:62592' } }))
  assert.equal(unknown.status, 404)
  const crossSite = handleRunStateRequest(harness.ctx, new Request('http://127.0.0.1:62592/plugin-api/role-team/run/call-1', {
    headers: { host: '127.0.0.1:62592', 'sec-fetch-site': 'cross-site' },
  }))
  assert.equal(crossSite.status, 403)
  const bare = handleRunStateRequest(harness.ctx, new Request('http://127.0.0.1:62592/plugin-api/role-team/run', { headers: { host: '127.0.0.1:62592' } }))
  assert.equal(bare.status, 404)
})
