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
function item(status, name, detail, section) {
  return { status, name, detail, section }
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
    props: props ?? {},
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
 * @param {{ host?: 'ok' | 'fail' | 'hang', rememberFailures?: number, hostText?: string | null }} [options]
 */
function createEnvironment(options = {}) {
  const dom = createDom()
  const hostCalls = []
  const { React, renderComponent, unmountComponent } = createReact(dom)
  // How often the mock refuses to store a paste before it answers.
  let rememberFailures = Number.isInteger(options.rememberFailures) ? options.rememberFailures : 0

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
        if (method === 'paste/text') {
          return { ok: true, value: { ok: true, text: options.hostText ?? null } }
        }
        if (method === 'paste/remember' && rememberFailures > 0) {
          // The host is busy: it does not take the paste this time.
          rememberFailures -= 1
          return { ok: false, error: { message: 'the host is busy' } }
        }
        return { ok: true, value: { ok: true } }
      },
    },
  }

  const window = {
    __DSH_BOOT__: { entries: [{ id: 'dsh-paste-collapse' }] },
    addEventListener() {},
    removeEventListener() {},
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
    navigator: { clipboard: { writeText: async () => {} } },
    // The client waits five seconds for the host before it gives up on the
    // collapse. The fake clock shortens every timer, so the test does not
    // have to wait for it.
    setTimeout: (fn, ms, ...rest) => setTimeout(fn, Math.min(Number(ms) || 0, 50), ...rest),
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
        // A slot injection returns a disposer, a generator of disposers, or
        // — in this test — the registration itself.
        const produced = factory()
        const entries = []
        if (produced && typeof produced.next === 'function') {
          let step = produced.next()
          while (!step.done) {
            entries.push(step.value)
            step = produced.next()
          }
        } else if (produced) {
          entries.push(produced)
        }
        registrations.push({ name, entry: entries[0], entries })
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
  const drawerRegistration = registrations.find((entry) => entry.name === 'shell.overlay')
  const drawerComponent = drawerRegistration?.entry?.component
  const userTextRegistration = registrations.find((entry) => entry.name === 'conversation.user.text.node')
  const userTextComponent = userTextRegistration?.entry?.component

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
    drawerComponent,
    renderDrawer(props) {
      return renderComponent(drawerComponent, props)
    },
    userTextComponent,
    /** Render the text of a user message the way the chat bubble does. */
    renderUserText(props) {
      return renderComponent(userTextComponent, props)
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
 * @returns {Promise<Array<{ status: 'passed' | 'failed', name: string, detail?: string, section?: string }>>}
 */
export async function runClientBundleCheck() {
  const items = []
  let currentSection = 'client.js — the composer'
  const record = (status, name, detail) => {
    items.push(item(status, name, detail, currentSection))
  }
  const check = (name, ok, detail) => {
    record(ok ? 'passed' : 'failed', name, ok ? undefined : detail)
  }
  /** Start a new group of checks, so the report tells them apart. */
  const section = (name) => {
    currentSection = name
  }

  const pasteText = `HEAD-${'z'.repeat(2000 - 5)}`
  const shortText = 'too short'

  const env = createEnvironment()
  env.render()

  // --- 0. the stylesheet reaches the browser as CSS, not as a JS array --
  // A style element's textContent takes only a string. An array stringifies to
  // ".a{..},.b{..}" and the browser drops every rule after the first, which
  // left the drawer unstyled (position:static, full width) in the real app.
  // The fake DOM stores whatever was assigned, so stringify the way a browser would.
  const styleText = String(env.dom.head.children.at(-1)?.textContent ?? '')
  const styleRules = styleText.split('\n').filter((line) => line.trim().startsWith('.__dpc'))
  check('the stylesheet is injected', styleText.length > 0, 'no style element was appended')
  check(
    'the browser receives every rule, not a comma-joined JS array',
    !styleText.includes('},.') && styleRules.length === 25,
    `rules=${styleRules.length} commaJoined=${styleText.includes('},.')}`,
  )
  check(
    'the drawer rule keeps its fixed side panel positioning',
    styleText.includes('.__dpc_drawer{position:fixed;top:0;right:0;bottom:0;'),
    'the drawer rule lost its fixed positioning',
  )

  // --- 1. a large paste becomes the Codex placeholder -----------------
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
  check('the pill shows the character count', pillText.includes('2k'), `pill text=${JSON.stringify(pillText)}`)

  // --- 2b. the pill opens a side panel with the whole text ------------
  check(
    'the side panel is closed at first',
    findByClass(env.renderDrawer(), '__dpc_drawer') === null,
    'the side panel was open before any click',
  )
  findByClass(tree, '__dpc_pill')?.props?.onClick?.()
  const drawer = env.renderDrawer()
  const drawerText = collectText(findByClass(drawer, '__dpc_drawer')).join('')
  check(
    'clicking the pill opens the side panel',
    findByClass(drawer, '__dpc_drawer') !== null,
    'no .__dpc_drawer found after the click',
  )
  check(
    'the side panel shows the whole text',
    drawerText.includes('HEAD-') && drawerText.includes('z'),
    `drawer text=${JSON.stringify(drawerText.slice(0, 60))}`,
  )
  check('the side panel shows the character count', drawerText.includes('2000'), `drawer text=${JSON.stringify(drawerText)}`)
  findByClass(drawer, '__dpc_iconBtn')?.props?.onClick?.()
  check(
    'the side panel closes again',
    findByClass(env.renderDrawer(), '__dpc_drawer') === null,
    'the side panel stayed open after the close button',
  )

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

  // --- 9. a submitted turn must not take the text away ---------------
  const submitting = createEnvironment()
  submitting.render()
  submitting.paste(pasteText)
  await settle()
  submitting.render()
  check('the pill is there before the turn is sent', countByClass(submitting.render(), '__dpc_pill') === 1, 'no pill')
  submitting.setInputState({ draft: '', draftRev: 2 })
  submitting.render()
  await settle()
  const revoke = submitting.hostCalls.find((call) => call.method === 'paste/remember' && call.args?.text === null)
  check(
    'a cleared draft does not tell the host to forget the paste',
    revoke === undefined,
    `call=${JSON.stringify(revoke?.args)}`,
  )
  check('the pill is gone after the turn was sent', countByClass(submitting.render(), '__dpc_pill') === 0, 'the pill is still there')

  // --- 10. a busy host is tried twice --------------------------------
  const busy = createEnvironment({ rememberFailures: 1 })
  busy.render()
  busy.paste(pasteText)
  await settle()
  const busyRemembers = busy.hostCalls.filter((call) => call.method === 'paste/remember')
  check('the host is asked twice when it is busy', busyRemembers.length === 2, `calls=${busyRemembers.length}`)
  check(
    'the paste is collapsed when the second attempt works',
    busy.inserted[0]?.text === '[Pasted Content 2000 chars]',
    `inserted=${JSON.stringify(busy.inserted[0]?.text)}`,
  )
  check('the text is not inserted raw when the collapse worked', busy.inserted.length === 1, `inserted=${busy.inserted.length}`)

  // --- 11. a host that never answers keeps the text ------------------
  const busyTwice = createEnvironment({ rememberFailures: 2 })
  busyTwice.render()
  busyTwice.paste(pasteText)
  await settle()
  const busyTwiceRemembers = busyTwice.hostCalls.filter((call) => call.method === 'paste/remember')
  check('the host is asked twice and not more', busyTwiceRemembers.length === 2, `calls=${busyTwiceRemembers.length}`)
  check(
    'the text is inserted raw when the host never answers',
    busyTwice.inserted[0]?.text === pasteText,
    `inserted=${JSON.stringify(busyTwice.inserted[0]?.text?.slice(0, 12))}`,
  )
  check('no placeholder is left in the draft', busyTwice.inserted.length === 1, `inserted=${busyTwice.inserted.length}`)

  // --- 12. the text of a sent message is rendered as a pill -----------
  section('client.js — the sent message')
  const bubble = createEnvironment()
  bubble.render()
  bubble.paste(pasteText)
  await settle()
  const bubbleText = `before ${pasteText} after`
  let bubbleTree = bubble.renderUserText({ node: { id: 'text', data: { text: bubbleText } }, raw: bubbleText })
  check(
    'a sent message shows the pasted text as a pill',
    countByClass(bubbleTree, '__dpc_inlinePill') === 1,
    `pills=${countByClass(bubbleTree, '__dpc_inlinePill')}`,
  )
  const bubblePillText = collectText(findByClass(bubbleTree, '__dpc_inlinePill')).join('')
  check('the pill in the message shows the preview', bubblePillText.includes('HEAD-'), `pill text=${JSON.stringify(bubblePillText)}`)
  check('the pill in the message shows the character count', bubblePillText.includes('2k'), `pill text=${JSON.stringify(bubblePillText)}`)
  const bubbleText2 = collectText(bubbleTree).join('')
  check(
    'the message keeps the text around the paste',
    bubbleText2.includes('before') && bubbleText2.includes('after'),
    `message=${JSON.stringify(bubbleText2.slice(0, 40))}`,
  )

  // --- 13. a message that still carries the placeholder --------------
  const placeholderText = 'before [Pasted Content 2000 chars] after'
  bubbleTree = bubble.renderUserText({ node: { id: 'text', data: { text: placeholderText } }, raw: placeholderText })
  check(
    'a message with a placeholder shows a pill',
    countByClass(bubbleTree, '__dpc_inlinePill') === 1,
    `pills=${countByClass(bubbleTree, '__dpc_inlinePill')}`,
  )
  const placeholderPill = collectText(findByClass(bubbleTree, '__dpc_inlinePill')).join('')
  check('the placeholder pill shows the preview', placeholderPill.includes('HEAD-'), `pill text=${JSON.stringify(placeholderPill)}`)
  check('the placeholder pill shows the character count', placeholderPill.includes('2k'), `pill text=${JSON.stringify(placeholderPill)}`)

  // --- 14. clicking the pill in the message opens the side panel ------
  findByClass(bubbleTree, '__dpc_inlinePill')?.props?.onClick?.()
  const bubbleDrawer = bubble.renderDrawer()
  const bubbleDrawerText = collectText(findByClass(bubbleDrawer, '__dpc_drawer')).join('')
  check(
    'clicking the pill in the message opens the side panel',
    findByClass(bubbleDrawer, '__dpc_drawer') !== null,
    'no .__dpc_drawer found after the click',
  )
  check(
    'the side panel shows the whole pasted text',
    bubbleDrawerText.includes(pasteText),
    `drawer text=${JSON.stringify(bubbleDrawerText.slice(0, 40))}`,
  )
  findByClass(bubbleDrawer, '__dpc_iconBtn')?.props?.onClick?.()

  // --- 15. a message without a paste stays plain text ----------------
  const plainTree = bubble.renderUserText({ node: { id: 'text', data: { text: 'just a normal message' } }, raw: 'just a normal message' })
  check('a message without a paste shows no pill', countByClass(plainTree, '__dpc_inlinePill') === 0, 'a pill was rendered')
  check(
    'a message without a paste keeps its text',
    collectText(plainTree).join('') === 'just a normal message',
    `message=${JSON.stringify(collectText(plainTree).join(''))}`,
  )

  // --- 16. the host hands out a text the client lost -----------------
  const lost = createEnvironment({ hostText: 'the text the host kept' })
  lost.render()
  const lostText = 'before [Pasted Content 3000 chars] after'
  const lostTree = lost.renderUserText({ node: { id: 'text', data: { text: lostText } }, raw: lostText })
  check(
    'a message with a placeholder shows a pill without a local copy',
    countByClass(lostTree, '__dpc_inlinePill') === 1,
    `pills=${countByClass(lostTree, '__dpc_inlinePill')}`,
  )
  findByClass(lostTree, '__dpc_inlinePill')?.props?.onClick?.()
  // The panel opens and asks the host for the text it does not have.
  lost.renderDrawer()
  await settle()
  const lostDrawer = lost.renderDrawer()
  const lostDrawerText = collectText(findByClass(lostDrawer, '__dpc_drawer')).join('')
  check(
    'the side panel asks the host for the text',
    lost.hostCalls.some((call) => call.method === 'paste/text'),
    `calls=${JSON.stringify(lost.hostCalls.map((call) => call.method))}`,
  )
  check(
    'the side panel shows the text the host kept',
    lostDrawerText.includes('the text the host kept'),
    `drawer text=${JSON.stringify(lostDrawerText.slice(0, 40))}`,
  )

  return items
}
