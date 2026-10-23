/**
 * dsh-paste-collapse — client bundle test.
 *
 * The client plugin is a browser bundle: it is evaluated inside a fake
 * window with a fake React and a fake DOM, exactly like the shipped
 * dsh-codex-hooks client test does. Nothing here touches the network or the
 * filesystem beyond reading client.js.
 *
 * The checks cover the behaviour SPEC §3.2 and §5.2 ask for:
 *
 * - a paste above the threshold is collapsed into the Codex placeholder
 * - the host is told about the paste
 * - a pill shows the preview and the character count
 * - a second paste of the same size gets the `#2` placeholder
 * - a short paste is left alone
 * - unmounting removes the paste listener
 * - a host that fails or times out keeps the text (no loss)
 * - a deleted placeholder drops the pill (Codex's retain rule)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8')

const THRESHOLD = 1000

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function item(status, name, detail) {
  return { status, name, detail }
}

/* ------------------------------------------------------------------ *
 * The fake React
 * ------------------------------------------------------------------ */

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function createReact(dom) {
  const instances = new Map()
  let current = null

  function stateOf(component) {
    let state = instances.get(component)
    if (!state) {
      state = { hooks: [], effects: [], pending: {}, cursor: 0 }
      instances.set(component, state)
    }
    return state
  }

  function useState(initial) {
    const state = current
    const index = state.cursor++
    if (!state.hooks[index]) {
      const initialValue = typeof initial === 'function' ? initial() : initial
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(state.hooks[index][0]) : next
        state.hooks[index][0] = value
      }
      state.hooks[index] = [initialValue, setValue]
    }
    return state.hooks[index]
  }

  function useRef(initial) {
    const state = current
    const index = state.cursor++
    if (!state.hooks[index]) state.hooks[index] = { current: initial }
    return state.hooks[index]
  }

  function useEffect(fn, deps) {
    const state = current
    const index = state.cursor++
    const previous = state.effects[index]
    const changed = !previous || !sameDeps(previous.deps, deps)
    state.pending[index] = { fn, deps, changed }
  }

  function useCallback(fn) {
    return fn
  }

  function useMemo(fn) {
    return fn()
  }

  return {
    React: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      useState,
      useRef,
      useEffect,
      useCallback,
      useMemo,
      Fragment: 'Fragment',
    },
    renderComponent(component, props) {
      const state = stateOf(component)
      current = state
      state.cursor = 0
      state.pending = {}
      const tree = component(props)
      const rendered = renderTree(tree, dom)
      flushEffects(state)
      return rendered
    },
    unmountComponent(component) {
      const state = instances.get(component)
      if (!state) return
      for (const effect of state.effects) {
        if (effect && typeof effect.cleanup === 'function') effect.cleanup()
      }
      state.effects = []
      instances.delete(component)
    },
  }
}

function flushEffects(state) {
  const indexes = Object.keys(state.pending)
    .map((key) => Number(key))
    .sort((left, right) => left - right)
  for (const index of indexes) {
    const request = state.pending[index]
    if (!request.changed) continue
    const previous = state.effects[index]
    if (previous && typeof previous.cleanup === 'function') previous.cleanup()
    const cleanup = request.fn()
    state.effects[index] = {
      deps: request.deps,
      cleanup: typeof cleanup === 'function' ? cleanup : undefined,
    }
  }
  state.pending = {}
}

/* ------------------------------------------------------------------ *
 * The fake DOM
 * ------------------------------------------------------------------ */

function createDom() {
  const listeners = []
  const editor = {
    nodeType: 1,
    contains(node) {
      return node === editor || node === undefined || node === null
    },
  }
  const card = {
    nodeType: 1,
    listeners,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture })
    },
    removeEventListener(type, fn, capture) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture)
      if (index >= 0) listeners.splice(index, 1)
    },
    querySelector(selector) {
      return selector === '[contenteditable="true"]' ? editor : null
    },
    contains(node) {
      return node === card
    },
  }
  const head = {
    children: [],
    append(node) {
      this.children.push(node)
    },
  }
  const document = {
    head,
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        textContent: '',
        remove() {},
      }
    },
  }
  return { card, editor, document, head, listeners }
}

function createDomNode(tag, props, dom) {
  return {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: props?.className ?? '',
    children: [],
    closest(selector) {
      if (selector === '[data-composer-card]') return dom.card
      return null
    },
    querySelector() {
      return null
    },
    contains(node) {
      return node === dom.editor
    },
  }
}

function renderTree(node, dom) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => renderTree(child, dom)).filter((child) => child !== null)
  if (typeof node.type === 'function') return renderTree(node.type(node.props), dom)
  const element = createDomNode(node.type, node.props, dom)
  if (node.props && node.props.ref) node.props.ref.current = element
  element.children = node.children.map((child) => renderTree(child, dom)).filter((child) => child !== null)
  return element
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (node.children) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

function findByClass(node, className) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found) return found
    }
    return null
  }
  if (node.className && String(node.className).split(/\s+/).includes(className)) return node
  if (node.children) return findByClass(node.children, className)
  return null
}

function countByClass(node, className) {
  if (node === null || node === undefined) return 0
  if (Array.isArray(node)) return node.reduce((total, child) => total + countByClass(child, className), 0)
  const own = node.className && String(node.className).split(/\s+/).includes(className) ? 1 : 0
  return own + (node.children ? countByClass(node.children, className) : 0)
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await flushAsync()
  }
}

/* ------------------------------------------------------------------ *
 * The environment
 * ------------------------------------------------------------------ */

/**
 * @param {{ host?: 'ok' | 'fail' | 'hang' }} [options]
 */
function createEnvironment(options = {}) {
  const dom = createDom()
  const hostCalls = []
  const { React, renderComponent, unmountComponent } = createReact(dom)

  const host = {
    rpc: {
      async call(scope, method, payload) {
        hostCalls.push({ scope, method, args: payload?.args })
        if (options.host === 'hang') {
          return new Promise(() => {})
        }
        if (options.host === 'fail') {
          return { ok: false, error: { message: 'host is down' } }
        }
        if (method === 'paste/has') {
          return { ok: true, value: { ok: true, has: true } }
        }
        return { ok: true, value: { ok: true } }
      },
    },
  }

  const window = {
    __DSH_BOOT__: { entries: [{ id: 'dsh-paste-collapse' }] },
    __ModuleLoader__: {
      load(spec) {
        window.__ModuleLoader__.module = spec.factory((name) => {
          if (name === 'react') return React
          if (name === 'react-dom') return { createPortal: (node) => node }
          throw new Error(`unexpected module: ${name}`)
        })
      },
    },
  }

  const context = {
    window,
    document: dom.document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.runInNewContext(SOURCE, context)

  const module = window.__ModuleLoader__.module
  const registrations = []
  // The real locale service: the client registers its dictionaries and the
  // translator reads the English one, so a missing key shows up here.
  const dictionaries = { en: {}, zh: {} }
  const scope = {
    locale: {
      bind: () => (key) => (key in dictionaries.en ? dictionaries.en[key] : key),
      register: (_namespace, dict) => {
        dictionaries.en = dict?.en ?? {}
        dictionaries.zh = dict?.zh ?? {}
      },
    },
    slots: {
      inject: (name, factory) => {
        registrations.push({ name, entry: factory() })
      },
      register: (spec, component) => ({ spec, component }),
    },
    connection: host,
    effect: (run) => run(),
  }
  module.apply({
    inject: (deps, callback) => {
      callback(scope)
    },
  })

  const registration = registrations.find((entry) => entry.name === 'conversation.input.overlay')
  const component = registration?.entry?.component

  const inserted = []
  const inputActions = {
    captureInsertion: () => ({ token: inserted.length }),
    insertText: (text, span) => {
      inserted.push({ text, span })
      return true
    },
    setDraft: () => {},
    persistDraft: () => {},
    submit: () => {},
  }

  let inputState = { draft: '', draftRev: 1 }
  const useInput = (selector) => (selector ? selector(inputState) : inputState)

  return {
    dom,
    hostCalls,
    registrations,
    component,
    inputActions,
    inserted,
    setInputState(next) {
      inputState = next
    },
    render(props) {
      return renderComponent(component, { inputActions, useInput, ...props })
    },
    unmount() {
      unmountComponent(component)
    },
    /** Dispatch a paste event on the composer card. */
    paste(text) {
      const event = {
        type: 'paste',
        target: dom.editor,
        defaultPrevented: false,
        propagationStopped: false,
        clipboardData: {
          getData: (kind) => (kind === 'text/plain' ? text : ''),
        },
        preventDefault() {
          this.defaultPrevented = true
        },
        stopPropagation() {
          this.propagationStopped = true
        },
      }
      for (const entry of [...dom.listeners]) {
        if (entry.type !== 'paste') continue
        entry.fn(event)
      }
      return event
    },
  }
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<Array<{ status: 'passed' | 'failed', name: string, detail?: string }>>}
 */
export async function runClientBundleCheck() {
  const items = []
  const record = (status, name, detail) => {
    items.push(item(status, name, detail))
  }
  const check = (name, ok, detail) => {
    record(ok ? 'passed' : 'failed', name, ok ? undefined : detail)
  }

  const pasteText = `HEAD-${'z'.repeat(2000 - 5)}`
  const shortText = 'too short'

  // --- 1. a large paste becomes the Codex placeholder -----------------
  const env = createEnvironment()
  env.render()
  const event = env.paste(pasteText)
  await settle()

  check(
    'a paste above the threshold is intercepted',
    event.defaultPrevented === true,
    `defaultPrevented=${event.defaultPrevented}`,
  )
  check(
    'the placeholder is inserted into the draft',
    env.inserted[0]?.text === '[Pasted Content 2000 chars]',
    `inserted=${JSON.stringify(env.inserted[0]?.text)}`,
  )
  const rememberCall = env.hostCalls.find((call) => call.method === 'paste/remember')
  check(
    'the host is told about the paste',
    rememberCall?.args?.placeholder === '[Pasted Content 2000 chars]' && rememberCall?.args?.text === pasteText,
    `call=${JSON.stringify(rememberCall?.args)}`,
  )

  // --- 2. the pill shows the preview and the count --------------------
  let tree = env.render()
  const pill = findByClass(tree, '__dpc_pill')
  const pillText = collectText(pill).join('')
  check('a pill is rendered', pill !== null, 'no .__dpc_pill found')
  check('the pill shows the preview', pillText.includes('HEAD-'), `pill text=${JSON.stringify(pillText)}`)
  check('the pill shows the character count', pillText.includes('2000'), `pill text=${JSON.stringify(pillText)}`)

  // --- 3. a second paste of the same size gets #2 ---------------------
  env.paste(pasteText)
  await settle()
  tree = env.render()
  check(
    'a second paste of the same size gets the #2 placeholder',
    env.inserted[1]?.text === '[Pasted Content 2000 chars] #2',
    `inserted=${JSON.stringify(env.inserted[1]?.text)}`,
  )
  check('both pills are rendered', countByClass(tree, '__dpc_pill') === 2, `pills=${countByClass(tree, '__dpc_pill')}`)

  // --- 4. a short paste is left alone ---------------------------------
  const before = env.inserted.length
  const shortEvent = env.paste(shortText)
  await settle()
  check('a short paste is not intercepted', shortEvent.defaultPrevented === false, 'the short paste was prevented')
  check('a short paste is not inserted', env.inserted.length === before, `inserted grew to ${env.inserted.length}`)

  // --- 5. unmounting removes the listener -----------------------------
  env.unmount()
  check('the paste listener is removed on unmount', env.dom.listeners.length === 0, `listeners=${env.dom.listeners.length}`)

  // --- 6. a host that fails keeps the text ---------------------------
  const failing = createEnvironment({ host: 'fail' })
  failing.render()
  failing.paste(pasteText)
  await settle()
  check(
    'a failing host falls back to the plain text',
    failing.inserted[0]?.text === pasteText,
    `inserted=${JSON.stringify(failing.inserted[0]?.text?.slice(0, 12))}`,
  )
  check(
    'a failing host does not create a pill',
    countByClass(failing.render(), '__dpc_pill') === 0,
    'a pill was rendered',
  )

  // --- 7. a host that times out keeps the text ------------------------
  const hanging = createEnvironment({ host: 'hang' })
  hanging.render()
  hanging.paste(pasteText)
  await settle(2)
  check(
    'a host that does not answer keeps the paste pending',
    hanging.inserted.length === 0,
    `inserted=${hanging.inserted.length}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await settle(2)
  check(
    'a host that times out falls back to the plain text',
    hanging.inserted[0]?.text === pasteText,
    `inserted=${JSON.stringify(hanging.inserted[0]?.text?.slice(0, 12))}`,
  )

  // --- 8. a deleted placeholder drops the pill ------------------------
  const deleting = createEnvironment()
  deleting.render()
  deleting.paste(pasteText)
  await settle()
  deleting.render()
  check('the pill is there before the placeholder is deleted', countByClass(deleting.render(), '__dpc_pill') === 1, 'no pill')
  deleting.setInputState({ draft: 'nothing here', draftRev: 2 })
  deleting.render()
  await settle()
  const revokeCall = deleting.hostCalls.find((call) => call.method === 'paste/remember' && call.args?.text === null)
  check('the host is told to forget the paste', revokeCall?.args?.placeholder === '[Pasted Content 2000 chars]', `call=${JSON.stringify(revokeCall?.args)}`)
  check('the pill is gone after the placeholder was deleted', countByClass(deleting.render(), '__dpc_pill') === 0, 'the pill is still there')

  return items
}
