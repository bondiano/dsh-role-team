import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRoute, roleTeamSnapshot, resolveRoleTeamConfig, runRoleTeam } from '../index.js'
import { runRuntimeRole } from '../runtime-role.js'

test('external runtime routes preserve runtime in normalized and settings snapshots', () => {
  const route = { runtime: 'droid', model: 'factory-model' }
  const normalized = normalizeRoute(route).route
  assert.deepEqual(normalized, { runtime: 'droid', provider: 'droid', model: 'factory-model' })
  assert.equal(roleTeamSnapshot({ roles: { worker: route } }).roles.worker.route.runtime, 'droid')
  assert.match(normalizeRoute({ runtime: 'invalid', provider: 'p', model: 'm' }).error, /runtime/)
})

test('external WORKER results are reviewed in candidate cwd and artifacts appear in team report', async () => {
  const calls = []
  const verdict = JSON.stringify({ approved: true, summary: 'ok', issues: [] })
  const runtime = {
    async list() { return { runtimes: [{ id: 'droid' }] } },
    async create(options) { calls.push({ type: 'runtime', options }); return { id: 'candidate', cwd: '/worktrees/worker' } },
    async *send() { yield { type: 'text', text: 'implemented' }; yield { type: 'artifact', path: '/private/result.patch' }; yield { type: 'settled', status: 'completed' } },
    async close() {},
  }
  const subagents = {
    getProvider() { return { capabilities: {} } },
    async startActivation(request) {
      calls.push({ type: 'native', request })
      return { name: 'native-role', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: verdict }] }), async dispose() {} }
    },
  }
  const ctx = { get(name) { return ({ agentRuntime: runtime, subagents, workingDirectory: { get: () => '/source' } })[name] } }
  const config = resolveRoleTeamConfig({ roles: { plan: null, worker: { runtime: 'droid', model: 'test' }, advisor: null, reviewer: null } })
  const result = await runRoleTeam(ctx, { agent: { session: {} }, task: 'change file', plan: 'existing plan', config })
  assert.equal(result.status, 'approved')
  const reviewers = calls.filter(call => call.type === 'native').slice(1)
  assert.equal(reviewers.length, 2)
  for (const call of reviewers) {
    assert.equal(call.request.cwd, '/worktrees/worker')
    assert.match(call.request.prompt[0].text, /\/worktrees\/worker/)
  }
  assert.equal(calls.find(call => call.type === 'runtime').options.cwd, '/source')
  assert.match(result.report, /\/private\/result.patch/)
  assert.match(result.report, /Candidate workspace: \/worktrees\/worker/)
})

test('external role cwd resolves from live parent and no native services are required', async () => {
  let request
  const parent = {}
  const runtime = {
    async create(options) { request = options; return { id: 's', cwd: '/isolated' } },
    async *send() { yield { type: 'completed', text: 'result', status: 'completed' } },
    async close() {},
  }
  const ctx = { get(name) { return name === 'agentRuntime' ? runtime : { async ensure(agent) { assert.equal(agent, parent); return '/actual' } } } }
  const result = await runRuntimeRole(ctx, { route: { runtime: 'cursor', provider: 'cursor', model: 'm' }, role: 'worker', prompt: 'go', parent })
  assert.equal(request.cwd, '/actual')
  assert.equal(result.text, 'result')
  assert.equal(result.cwd, '/isolated')
})
