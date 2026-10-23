/**
 * End to end self check for the host plugin (lib/index.js).
 *
 *   node selftest/host-e2e.mjs
 *
 * The plugin runs against a fake Cordis context: the remote method is
 * called the way the gateway calls it, the `agent/pre-step` waterfall is
 * driven the way the agent loop drives it.
 *
 * Nothing is written outside a temporary directory — and the plugin itself
 * writes nothing at all, which is checked at the end.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The home directory has to point at a temporary directory before the plugin
// is loaded.
const home = mkdtempSync(join(tmpdir(), 'dsh-paste-collapse-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

const DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

let passed = 0
const failures = []

function check(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function checkAsync(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/* ---------------- fake cordis context ---------------- */

function createCtx() {
  const listeners = new Map()
  const services = new Map()
  return {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
      return () => {}
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    get(name) {
      return services.get(name)
    },
    inject(deps, callback) {
      const resolved = deps.map((name) => services.get(name))
      if (resolved.every((value) => value !== undefined)) {
        const scope = { get: (name) => services.get(name) }
        for (const [index, name] of deps.entries()) scope[name] = resolved[index]
        callback(scope)
      }
      return () => {}
    },
    effect(run) {
      return run()
    },
    services,
    async emit(name, ...args) {
      const handlers = listeners.get(name) ?? []
      let result
      for (const handler of handlers) result = await handler(...args)
      return result
    },
  }
}

/* ---------------- fixtures ---------------- */

let messageId = 0
function userMessage(text) {
  messageId += 1
  return {
    id: `message-${messageId}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistantMessage(text) {
  messageId += 1
  return {
    id: `message-${messageId}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'system' },
  }
}

/* ---------------- run the plugin ---------------- */

const ctx = createCtx()
apply(ctx, {})

const controller = ctx.services.get('pasteController')

console.log('plugin wiring')
check('registers the pasteController service', () => {
  assert.ok(controller, 'the pasteController service is missing')
})
check('the service is reachable through ctx.get()', () => {
  assert.equal(ctx.get('pasteController'), controller)
})
check('the remote descriptor lists the methods', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(controller), DESCRIPTOR_KEY)
  assert.ok(descriptor, 'the remote method descriptor is missing')
  const methods = descriptor.value.methods.map((entry) => entry.method)
  assert.deepEqual(methods, ['remember', 'has', 'text'])
  assert.equal(descriptor.value.version, 1)
})
check('the remote namespace is paste', () => {
  assert.equal(controller.typertRemote.namespace, 'paste')
  assert.equal(controller.typertRemote.serviceKey, 'pasteController')
  assert.equal(controller.typertRemote.service, controller)
})

console.log('the remote method')
check('remember() stores the pasted text', () => {
  const result = controller.remember('[Pasted Content 2000 chars]', 'the full text')
  assert.deepEqual(result, { ok: true })
  assert.equal(controller.pending.size(), 1)
  assert.equal(controller.pending.has('[Pasted Content 2000 chars]'), true)
})
check('remember() rejects an empty placeholder', () => {
  const result = controller.remember('', 'text')
  assert.equal(result.ok, false)
})
check('remember() with text=null keeps the text until the turn had its chance', () => {
  controller.remember('[Pasted Content 3000 chars]', 'another text')
  assert.equal(controller.pending.size(), 2)
  const result = controller.remember('[Pasted Content 3000 chars]', null)
  assert.deepEqual(result, { ok: true })
  // The composer clears the draft when the turn is submitted and the
  // expansion runs on the host after that: the text has to survive the
  // revoke, or the model would only ever see the placeholder.
  assert.equal(controller.pending.size(), 2)
  assert.equal(controller.pending.has('[Pasted Content 3000 chars]'), true)
})
check('has() reports whether the host still holds the text', () => {
  assert.deepEqual(controller.has('[Pasted Content 2000 chars]'), { ok: true, has: true })
  assert.deepEqual(controller.has('[Pasted Content 9999 chars]'), { ok: true, has: false })
})

console.log('agent/pre-step')
await checkAsync('the placeholder is replaced by the full text', async () => {
  const messages = [userMessage('before [Pasted Content 2000 chars] after')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages[0].content[0].text, 'before the full text after')
})
await checkAsync('the role and the other fields are kept', async () => {
  const original = userMessage('[Pasted Content 2000 chars]')
  const payload = { agent: { id: 'agent-1' }, messages: [original], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [original] }))
  assert.equal(decision.messages[0].role, 'user')
  assert.equal(decision.messages[0].id, original.id)
  assert.deepEqual(decision.messages[0].source, original.source)
})
await checkAsync('two pastes of the same size are expanded in order (FIFO)', async () => {
  controller.remember('[Pasted Content 4000 chars]', 'first')
  controller.remember('[Pasted Content 4000 chars]', 'second')
  const messages = [userMessage('[Pasted Content 4000 chars] and [Pasted Content 4000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages[0].content[0].text, 'first and second')
})
await checkAsync('a message without a placeholder is not touched', async () => {
  const messages = [userMessage('nothing to expand here'), assistantMessage('[Pasted Content 2000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages, messages, 'the messages array was replaced')
  assert.equal(decision.messages[0].content[0].text, 'nothing to expand here')
})
await checkAsync('a rejected decision is passed through', async () => {
  const payload = { agent: { id: 'agent-1' }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject')
})
await checkAsync('a repeated pre-step does not expand the text twice', async () => {
  controller.remember('[Pasted Content 5000 chars]', 'once')
  const messages = [userMessage('[Pasted Content 5000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const first = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(first.messages[0].content[0].text, 'once')
  const second = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages: first.messages }))
  assert.equal(second.messages[0].content[0].text, 'once')
})
await checkAsync('a paste that was not in the sent turn stays until the client revokes it', async () => {
  controller.remember('[Pasted Content 7000 chars]', 'used')
  controller.remember('[Pasted Content 6000 chars]', 'not in this turn')
  const messages = [userMessage('[Pasted Content 7000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages[0].content[0].text, 'used')
  assert.equal(controller.pending.has('[Pasted Content 7000 chars]'), true)
  // The host cannot tell a paste the user deleted from one that is still in
  // the composer, so it keeps it until the client revokes it.
  assert.equal(controller.pending.has('[Pasted Content 6000 chars]'), true)
})
await checkAsync('a paste that was not sent yet is not dropped', async () => {
  controller.remember('[Pasted Content 8000 chars]', 'still in the composer')
  const messages = [userMessage('a turn without any placeholder')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(controller.pending.has('[Pasted Content 8000 chars]'), true)
})
await checkAsync('a revoked paste is still expanded in the turn that is on its way', async () => {
  controller.remember('[Pasted Content 9000 chars]', 'the text the turn needs')
  // The client revokes when the placeholder leaves the draft — and the draft
  // is cleared when the turn is submitted, which happens before the host
  // expands it.
  controller.remember('[Pasted Content 9000 chars]', null)
  const messages = [userMessage('[Pasted Content 9000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages[0].content[0].text, 'the text the turn needs')
})
await checkAsync('a revoked paste the turn does not use is dropped', async () => {
  controller.remember('[Pasted Content 11000 chars]', 'gone')
  controller.remember('[Pasted Content 11000 chars]', null)
  const messages = [userMessage('a turn without any placeholder')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(controller.pending.has('[Pasted Content 11000 chars]'), false)
})
await checkAsync('a new paste of the same size is not shadowed by a revoked one', async () => {
  controller.remember('[Pasted Content 12000 chars]', 'old')
  controller.remember('[Pasted Content 12000 chars]', null)
  controller.remember('[Pasted Content 12000 chars]', 'new')
  const messages = [userMessage('[Pasted Content 12000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  const decision = await ctx.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages[0].content[0].text, 'new')
})

console.log('the retained texts')
await checkAsync('the host hands out the text of a paste the turn used', async () => {
  const fresh = createCtx()
  apply(fresh, {})
  const freshController = fresh.services.get('pasteController')
  freshController.remember('[Pasted Content 2000 chars]', 'the full text')
  const messages = [userMessage('[Pasted Content 2000 chars]')]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  await fresh.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  // The bubble shows the expanded text, so the client asks the host for the
  // original — the host has to keep it.
  assert.deepEqual(freshController.text('[Pasted Content 2000 chars]'), { ok: true, text: 'the full text' })
})
check('text() returns null for a placeholder the host does not know', () => {
  assert.deepEqual(controller.text('[Pasted Content 9999 chars]'), { ok: true, text: null })
})
check('text() rejects an empty placeholder', () => {
  const result = controller.text('')
  assert.equal(result.ok, false)
})
await checkAsync('the host keeps the 50 newest used texts', async () => {
  const fresh = createCtx()
  apply(fresh, {})
  const freshController = fresh.services.get('pasteController')
  const placeholders = []
  for (let index = 0; index < 60; index += 1) {
    const placeholder = `[Pasted Content ${20000 + index} chars]`
    placeholders.push(placeholder)
    freshController.remember(placeholder, `text ${index}`)
  }
  const messages = [userMessage(placeholders.join(' '))]
  const payload = { agent: { id: 'agent-1' }, messages, turn: 1, step: 1, signal: new AbortController().signal }
  await fresh.emit('agent/pre-step', payload, async () => ({ kind: 'enter', messages }))
  assert.equal(freshController.pending.size(), 50)
  assert.deepEqual(freshController.text(placeholders[0]), { ok: true, text: null })
  assert.deepEqual(freshController.text(placeholders[59]), { ok: true, text: 'text 59' })
})

console.log('the plugin stays in memory')
check('nothing was written to the home directory', () => {
  assert.deepEqual(readdirSync(home), [])
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  process.exit(1)
}
