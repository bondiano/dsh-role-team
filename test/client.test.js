import test from 'node:test'
import assert from 'node:assert/strict'

test('the client half registers the settings section and the five role tool cards', async () => {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured = options
      },
    },
  }
  globalThis.document = {
    createElement() {
      return { dataset: {}, textContent: '', remove() {} }
    },
    head: { append() {} },
    querySelectorAll() { return [] },
  }
  await import('../client.js')
  assert.equal(captured.id, '@local/dsh-role-team')
  assert.equal(typeof captured.factory, 'function')

  const fakeReact = {
    createElement: (...args) => args,
    Fragment: 'Fragment',
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useRef: () => ({ current: null }),
  }
  const moduleFace = captured.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected external: ${name}`)
  })
  assert.deepEqual(moduleFace.inject, ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace'])
  assert.equal(typeof moduleFace.apply, 'function')

  const dictionaries = {}
  const slotInjections = []
  const registrations = []
  const openedSessions = []
  let sessionAddedListener
  const ctx = {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    uiWorkspace: {
      openSession(sessionId) {
        openedSessions.push(sessionId)
      },
    },
    locale: {
      register(namespace, values) {
        dictionaries[namespace] = values
        return () => {}
      },
      bind() {
        return key => key
      },
    },
    slots: {
      inject(name, callback) {
        slotInjections.push(name)
        const out = callback()
        if (out !== null && out !== undefined && typeof out[Symbol.iterator] === 'function') {
          for (const _ of out) {
            // each yield already registered itself through ctx.slots.register
          }
        }
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
      $on(event, listener) {
        if (event === 'api-session/added') sessionAddedListener = listener
        return () => {}
      },
    },
  }
  moduleFace.apply(ctx)

  // A session `/role-plan` created is claimed through the marker route and opened;
  // an unrelated session is left where it is.
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    const planSession = String(url).includes('session-new')
    return { ok: planSession, async json() { return { ok: true, sessionId: 'session-new' } } }
  }
  try {
    assert.equal(typeof sessionAddedListener, 'function')
    sessionAddedListener({ sessionId: 'session-new' })
    await new Promise(resolve => setTimeout(resolve, 0))
    sessionAddedListener({ sessionId: 'session-foreign' })
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests.length, 2)
  assert.ok(requests[0].url.endsWith('/plugin-api/role-team/plan-session/session-new'))
  assert.equal(requests[0].init.credentials, 'same-origin')
  assert.deepEqual(openedSessions, ['session-new'])

  assert.deepEqual(slotInjections, ['settings.models.footer', 'tool.call.toolview'])

  assert.equal(registrations[0].options.name, 'settings.models.footer')
  assert.equal(registrations[0].options.id, 'role-team')
  assert.equal(registrations[0].options.order, 20)
  assert.equal(registrations[0].options.locale, 'roleTeam')
  assert.equal(typeof registrations[0].component, 'function')

  const toolviews = registrations.slice(1)
  assert.deepEqual(toolviews.map(entry => entry.options.key),
    ['roles_run', 'role_plan', 'role_worker', 'role_advisor', 'role_reviewer'])
  for (const entry of toolviews) {
    assert.equal(entry.options.name, 'tool.call.toolview')
    assert.equal(entry.options.locale, 'roleTeam')
    assert.equal(typeof entry.component, 'function')
  }

  for (const language of ['en', 'ru', 'zh']) {
    const dict = dictionaries.roleTeam[language]
    for (const key of ['runTitle', 'preparing', 'running', 'pipeline', 'comments', 'approved', 'changes', 'notApproved', 'continued', 'finished', 'decisions', 'noMeta', 'noReport', 'rawReport', 'inheritRoute', 'liveUnavailable', 'decisionContinue', 'decisionRetry', 'decisionModel', 'decisionStop', 'decisionNone', 'severityBlocker', 'severityMajor', 'severityMinor']) {
      assert.ok(dict[key], `missing locale key ${language}.${key}`)
    }
  }

  const Card = toolviews[0].component
  const rendered = Card({
    toolName: 'roles_run',
    callId: 'call-1',
    t: key => key,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: {
      kind: 'tool-result',
      isError: false,
      meta: {
        v: 1,
        tool: 'roles_run',
        status: 'approved',
        task: 'Do it',
        stages: [{ role: 'advisor', route: { provider: 'opencode-go', model: 'glm-5.3' }, status: 'done' }],
        comments: [{
          role: 'reviewer',
          stage: 'round 1 final gate',
          route: { provider: 'opencode-go', model: 'qwen3.8-max' },
          approved: true,
          summary: 'verified',
          issues: [],
        }],
        decisions: [],
      },
      content: [{ type: 'text', text: 'Role team: APPROVED' }],
      call: { name: 'roles_run', argsRaw: '{"task":"Do it"}' },
    },
  })
  assert.equal(rendered[0], 'div')
  assert.ok(rendered[1].className.includes('dsh-rt-tool'))
  const button = rendered[2]
  assert.equal(button[0], 'button')
  assert.ok(JSON.stringify(button).includes('approved'))
  assert.ok(JSON.stringify(button).includes('Do it'))
  const body = rendered[3]
  const bodyText = JSON.stringify(body)
  assert.ok(bodyText.includes('round 1 final gate'))
  assert.ok(bodyText.includes('qwen3.8-max'))
  assert.ok(bodyText.includes('verified'))
  assert.ok(bodyText.includes('Role team: APPROVED'))

  // Per-state renders: preparing, running, error, meta-less, and single-role results.
  const preparing = Card({
    toolName: 'roles_run',
    callId: 'c2',
    t: key => key,
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
    block: { phase: 'preparing' },
  })
  assert.ok(JSON.stringify(preparing).includes('preparing'))

  const running = Card({
    toolName: 'roles_run',
    callId: 'c3',
    t: key => key,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: { phase: 'start', name: 'roles_run', argsRaw: '{"task":"Live task"}' },
  })
  const runningText = JSON.stringify(running)
  assert.ok(runningText.includes('running'))
  assert.ok(runningText.includes('liveUnavailable'))
  assert.ok(runningText.includes('Live task'))

  const failed = Card({
    toolName: 'roles_run',
    callId: 'c4',
    t: key => key,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: {
      kind: 'tool-result',
      isError: true,
      content: [{ type: 'text', text: 'Error: provider failed' }],
      call: { name: 'roles_run', argsRaw: '{"task":"Broken"}' },
    },
  })
  const failedText = JSON.stringify(failed)
  assert.ok(failedText.includes('failed'))
  assert.ok(failedText.includes('Error: provider failed'))

  const metaLess = Card({
    toolName: 'roles_run',
    callId: 'c5',
    t: key => key,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: {
      kind: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: 'Old result without metadata' }],
      call: { name: 'roles_run', argsRaw: '{"task":"Old"}' },
    },
  })
  const metaLessText = JSON.stringify(metaLess)
  assert.ok(metaLessText.includes('finished'), 'a settled result without a verdict must show the neutral finished pill, not changes')
  assert.ok(metaLessText.includes('noMeta'))
  assert.ok(metaLessText.includes('Old result without metadata'))

  const planCard = toolviews[1].component
  const planResult = planCard({
    toolName: 'role_plan',
    callId: 'c6',
    t: key => key,
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
    block: {
      kind: 'tool-result',
      isError: false,
      meta: { v: 1, tool: 'role_plan', role: 'plan', route: { provider: 'codex', model: 'gpt-6-astra' }, status: 'completed', durationMs: 5 },
      content: [{ type: 'text', text: 'Role PLAN finished' }],
      call: { name: 'role_plan', argsRaw: '{"task":"Plan it"}' },
    },
  })
  const planText = JSON.stringify(planResult)
  assert.ok(planText.includes('finished'), 'a successful non-verdict single-role result must show the neutral finished pill')
  assert.ok(planText.includes('runTitle · PLAN'), 'single-role cards carry the role-team context in their title')

  const advisorCard = toolviews[3].component
  const advisorResult = advisorCard({
    toolName: 'role_advisor',
    callId: 'c7',
    t: key => key,
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: {
      kind: 'tool-result',
      isError: false,
      meta: {
        v: 1,
        tool: 'role_advisor',
        role: 'advisor',
        route: { provider: 'zai', model: 'glm-5.3' },
        status: 'completed',
        durationMs: 9,
        verdict: { approved: false, summary: 'needs work', issues: [{ severity: 'major', detail: 'tests missing' }] },
      },
      content: [{ type: 'text', text: 'Role ADVISOR finished' }],
      call: { name: 'role_advisor', argsRaw: '{"task":"Check it"}' },
    },
  })
  const advisorText = JSON.stringify(advisorResult)
  assert.ok(advisorText.includes('changes'))
  assert.ok(advisorText.includes('needs work'), 'a standalone ADVISOR verdict renders as a comment card')
  assert.ok(advisorText.includes('glm-5.3'))
  assert.ok(advisorText.includes('tests missing'))
  assert.ok(advisorText.includes('severityMajor'))
})
