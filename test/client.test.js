import test from 'node:test'
import assert from 'node:assert/strict'

test('the client half registers the Role team footer in Settings -> Models', async () => {
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

  const fakeReact = { createElement: (...args) => args, Fragment: 'Fragment' }
  const moduleFace = captured.factory(name => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected external: ${name}`)
  })
  assert.deepEqual(moduleFace.inject, ['slots', 'locale', 'remote', 'remote.session'])
  assert.equal(typeof moduleFace.apply, 'function')

  const dictionaries = {}
  let slotName
  let registration
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
        slotName = name
        callback()
      },
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
      $on: () => () => {},
    },
  }
  moduleFace.apply(ctx)

  assert.equal(slotName, 'settings.models.footer')
  assert.equal(registration.options.name, 'settings.models.footer')
  assert.equal(registration.options.id, 'role-team')
  assert.equal(registration.options.order, 20)
  assert.equal(registration.options.locale, 'roleTeam')
  assert.equal(typeof registration.component, 'function')
  assert.ok(dictionaries.roleTeam.en.title)
  assert.ok(dictionaries.roleTeam.ru.title)
  assert.ok(dictionaries.roleTeam.zh.title)
})
