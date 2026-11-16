import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (!Array.isArray(tree) && predicate(tree)) return tree
  for (const child of Array.isArray(tree) ? tree : tree.children ?? []) {
    const found = find(child, predicate)
    if (found) return found
  }
}

async function pickerHarness(route, groups = []) {
  let captured
  let states = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment', useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useEffect() {}, useCallback: fn => fn, useRef: () => ({ current: null }),
  }
  runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: options => { captured = options } } },
  })
  const face = captured.factory(() => React)
  let Section
  face.apply({ effect() {}, locale: { bind: () => key => key }, slots: {
    inject(name, callback) { const value = callback(); if (value?.[Symbol.iterator]) for (const ignored of value) {} },
    register(options, component) { if (options.name === 'settings.models.footer') Section = component },
  } })
  states = [{ status: 'ready', snapshot: { roles: { worker: { route } } }, catalog: { groups } }, { role: 'worker' }, false, undefined, '']
  const section = Section({ api: {}, t: key => key })
  const element = find(section, node => node.type?.name === 'ModelPicker')
  let saved
  states = []; cursor = 0
  const props = { ...element.props, onApply: value => { saved = value } }
  const render = () => { cursor = 0; return element.type(props) }
  return { render, saved: () => saved }
}

test('runtime picker preserves external route on reopen and allows manual model entry without native providers', async () => {
  const picker = await pickerHarness({ runtime: 'droid', provider: 'droid', model: 'factory-model', reasoningEffort: 'high' })
  let tree = picker.render()
  assert.equal(find(tree, node => node.type === 'select').props.value, 'droid')
  const field = find(tree, node => node.type === 'input' && node.props['aria-label'] === 'externalModel')
  assert.equal(field.props.value, 'factory-model')
  field.props.onChange({ target: { value: 'another-model' } })
  tree = picker.render()
  const apply = find(tree, node => node.type === 'button' && node.children.includes('apply'))
  assert.equal(apply.props.disabled, false)
  apply.props.onClick()
  assert.equal(picker.saved().runtime, 'droid')
  assert.equal(picker.saved().provider, 'droid')
  assert.equal(picker.saved().model, 'another-model')
})

test('native selection retains provider/model behavior and runtime can switch to Cursor', async () => {
  const picker = await pickerHarness({ provider: 'p', model: 'm' }, [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }])
  let tree = picker.render()
  find(tree, node => node.type === 'button' && node.children.includes('apply')).props.onClick()
  assert.equal(picker.saved().runtime, undefined)
  assert.equal(picker.saved().provider, 'p')
  find(tree, node => node.type === 'select').props.onChange({ target: { value: 'cursor' } })
  tree = picker.render()
  find(tree, node => node.type === 'button' && node.children.includes('apply')).props.onClick()
  assert.equal(picker.saved().runtime, 'cursor')
  assert.equal(picker.saved().provider, 'cursor')
  assert.equal(picker.saved().model, 'm')
})
