import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  familyOf,
  formatRoute,
  handleRolesRoute,
  normalizeRoute,
  parseVerdict,
  resolveRoleTeamConfig,
  roleTeamSnapshot,
} from '../index.js'

const AGENT = { session: { id: 'session-1' } }
const SIGNAL = new AbortController().signal

/**
 * Build a fake Host context with the services the plugin consumes.
 * @param {{ config?: object, responses?: Record<string, string[] | ((prompt: string, index: number) => string)>, llm?: object }} options harness options
 * @returns {object} fake harness
 */
function makeHarness(options = {}) {
  const tools = new Map()
  const commands = new Map()
  const calls = []
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
    workingDirectory: { get: () => '/workspace' },
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
  return { ctx, tools, commands, calls, entry }
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
  assert.equal(defaults.childMaxDepth, 2)

  const custom = resolveRoleTeamConfig({
    roles: {
      worker: 'zai/glm-5.3:high',
      advisor: null,
      reviewer: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'high' },
    },
    maxRounds: 5,
    childMaxDepth: 3,
    prompts: { worker: '  be terse  ', unknown: 'ignored' },
  })
  assert.deepEqual(custom.roles.worker, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'high' })
  assert.equal(custom.roles.advisor, null)
  assert.equal(custom.sources.advisor, 'inherit')
  assert.deepEqual(custom.roles.reviewer, { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'high' })
  assert.equal(custom.maxRounds, 5)
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

test('roles_run runs PLAN, then WORKER/ADVISOR twice and REVIEWER only after advisor approval', async () => {
  const harness = makeHarness({
    responses: {
      plan: ['1. Implement X\n2. Test X'],
      worker: ['CHANGES: first\nSTATUS: done', 'CHANGES: second\nSTATUS: done', 'CHANGES: third\nSTATUS: done'],
      advisor: [
        verdict(false, [{ severity: 'blocker', detail: 'first blocker' }]),
        verdict(true, [], 'looks right'),
        verdict(true, [], 'still right'),
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
  assert.match(outcome.text, /Role team: APPROVED after 3 round\(s\)/)
  assert.equal(harness.calls.filter(call => call.role === 'plan').length, 1)
  assert.equal(harness.calls.filter(call => call.role === 'worker').length, 3)
  assert.equal(harness.calls.filter(call => call.role === 'advisor').length, 3)
  assert.equal(harness.calls.filter(call => call.role === 'reviewer').length, 2)

  const roles = harness.calls.map(call => call.role)
  assert.deepEqual(roles.slice(0, 3), ['plan', 'worker', 'advisor'])
  assert.deepEqual(roles.slice(3, 6), ['worker', 'advisor', 'reviewer'])
  assert.deepEqual(roles.slice(6), ['worker', 'advisor', 'reviewer'])

  const workers = harness.calls.filter(call => call.role === 'worker')
  assert.ok(!workers[0].prompt.includes('first blocker'))
  assert.ok(workers[1].prompt.includes('[blocker] first blocker'))
  assert.ok(workers[2].prompt.includes('[major] second issue'))

  const reviewers = harness.calls.filter(call => call.role === 'reviewer')
  assert.ok(reviewers[0].prompt.includes('CHANGES: second'))
  assert.ok(reviewers[0].prompt.includes('first blocker') === false)
})

test('roles_run with a supplied plan skips PLAN and still gates on REVIEWER', async () => {
  const harness = makeHarness({
    responses: {
      worker: ['CHANGES: done\nSTATUS: done'],
      advisor: [verdict(true, [], 'approved')],
      reviewer: [verdict(true, [], 'approved')],
    },
  })
  const outcome = await harness.tools.get('roles_run').execute(
    { task: 'Fix the bug', plan: '1. Edit a.js' },
    { agent: AGENT, signal: SIGNAL },
  )
  assert.match(outcome.text, /APPROVED/)
  assert.equal(harness.calls.filter(call => call.role === 'plan').length, 0)
  assert.equal(harness.calls.filter(call => call.role === 'reviewer').length, 1)
  assert.match(outcome.text, /Fix the bug/)
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
