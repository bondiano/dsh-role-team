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
  assert.deepEqual(moduleFace.inject, ['slots', 'locale', 'remote', 'remote.session'])
  assert.equal(typeof moduleFace.apply, 'function')

  const dictionaries = {}
  const slotInjections = []
  const registrations = []
  const ctx = {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
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
      $on: () => () => {},
    },
  }
  moduleFace.apply(ctx)

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
    for (const key of ['runTitle', 'preparing', 'running', 'pipeline', 'comments', 'approved', 'changes', 'notApproved', 'continued', 'decisions', 'noMeta', 'rawReport', 'inheritRoute']) {
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
})
