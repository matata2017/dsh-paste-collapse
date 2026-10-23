/**
 * dsh-paste-collapse — host plugin.
 *
 * The client folds a large paste into a Codex style placeholder
 * (`[Pasted Content N chars]`) and hands the full text to this host. When the
 * turn is submitted, the host swaps every placeholder back for its text, so
 * the model reads exactly what the user pasted — the same thing Codex does,
 * only the expansion happens here instead of in the composer.
 *
 * Nothing is written to disk: the pending pastes live in memory only, like
 * Codex's `pending_pastes`.
 *
 * Zero bare imports: the plugin only uses the Cordis services handed to
 * `apply()`.
 */

import { createExpander } from './marker.js'

const DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/* ------------------------------------------------------------------ *
 * The pending pastes
 * ------------------------------------------------------------------ */

/**
 * The in-memory list of pastes waiting to be expanded.
 *
 * Codex keeps `Vec<(String, String)>` and drops an entry as soon as its
 * placeholder leaves the draft; the same rules are implemented here:
 *
 * - `add` registers a paste, dropping the already expanded entries for the
 *   same placeholder first (a second paste of the same size must not be
 *   shadowed by the text of the first one).
 * - `settle` marks the entries the last expansion consumed and drops the
 *   ones that were not used, which is how a paste whose placeholder the user
 *   deleted disappears again.
 */
export class PendingPastes {
  /** @type {{ placeholder: string, text: string, consumed: boolean }[]} */
  #entries = []

  /**
   * @param {string} placeholder
   * @param {string} text
   */
  add(placeholder, text) {
    this.#entries = this.#entries.filter(
      (entry) => !(entry.consumed && entry.placeholder === placeholder),
    )
    this.#entries.push({ placeholder, text, consumed: false })
    return this
  }

  /**
   * Drop the most recent entry for a placeholder (the client revokes a
   * paste when it could not insert the placeholder).
   *
   * @param {string} placeholder
   * @returns {boolean} whether something was dropped
   */
  forget(placeholder) {
    const index = this.#entries.findLastIndex((entry) => entry.placeholder === placeholder)
    if (index < 0) return false
    this.#entries = this.#entries.filter((_, at) => at !== index)
    return true
  }

  /**
   * @param {string} placeholder
   * @returns {boolean} whether the host still holds a text for it
   */
  has(placeholder) {
    return this.#entries.some((entry) => entry.placeholder === placeholder)
  }

  /** @returns {number} how many pastes are registered */
  size() {
    return this.#entries.length
  }

  /** @returns {Array<[string, string]>} the pending list in registration order */
  toArray() {
    return this.#entries.map((entry) => [entry.placeholder, entry.text])
  }

  /**
   * Close an expansion: only the entries the expansion used are kept, the
   * ones it did not use go away.
   *
   * This is Codex's rule (`pending_pastes.retain(...)`): a paste whose
   * placeholder is not in the turn that is being sent is not pending any
   * more. The used entries stay (marked as consumed) so a repeated
   * pre-step expands the same way.
   *
   * @param {number[]} used indexes into the list handed to the expander
   */
  settle(used) {
    const usedIndexes = new Set(Array.isArray(used) ? used : [])
    this.#entries = this.#entries
      .map((entry, index) => (usedIndexes.has(index) ? { ...entry, consumed: true } : null))
      .filter((entry) => entry !== null)
    return this
  }
}

/* ------------------------------------------------------------------ *
 * Remote namespace `paste` (SRC, hand rolled — no typert import)
 * ------------------------------------------------------------------ */

export class PasteController {
  /**
   * @param {PendingPastes} pending
   */
  constructor(pending) {
    this.pending = pending
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: 'pasteController',
      namespace: 'paste',
    })
  }

  /**
   * Remember one pasted text, or revoke it.
   *
   * The wire fields are the parameter names: the client sends
   * `{ placeholder, text }` and `text === null` revokes the paste.
   *
   * @param {string} placeholder
   * @param {string | null} text
   * @returns {{ ok: boolean, error?: string }}
   */
  remember(placeholder, text) {
    if (typeof placeholder !== 'string' || placeholder === '') {
      return { ok: false, error: 'invalid placeholder' }
    }
    if (text === null) {
      this.pending.forget(placeholder)
      return { ok: true }
    }
    if (typeof text !== 'string') {
      return { ok: false, error: 'invalid text' }
    }
    this.pending.add(placeholder, text)
    return { ok: true }
  }

  /**
   * Whether the host still holds the text for a placeholder — the client
   * marks the pill as "text lost" when the host was restarted.
   *
   * @param {string} placeholder
   * @returns {{ ok: boolean, has?: boolean, error?: string }}
   */
  has(placeholder) {
    if (typeof placeholder !== 'string' || placeholder === '') {
      return { ok: false, error: 'invalid placeholder' }
    }
    return { ok: true, has: this.pending.has(placeholder) }
  }
}

Object.defineProperty(PasteController.prototype, DESCRIPTOR_KEY, {
  value: {
    version: 1,
    methods: [
      { method: 'remember', invocation: { kind: 'direct' } },
      { method: 'has', invocation: { kind: 'direct' } },
    ],
  },
  configurable: true,
})

/* ------------------------------------------------------------------ *
 * Expanding the placeholders in the user messages
 * ------------------------------------------------------------------ */

/**
 * Expand one message, keeping every other field untouched.
 *
 * @param {unknown} message
 * @param {{ expand(text: string): { text: string } }} expander
 */
function expandMessage(message, expander) {
  if (!message || typeof message !== 'object') return message
  if (message.role !== 'user') return message
  const content = message.content
  if (typeof content === 'string') {
    const result = expander.expand(content)
    if (result.text === content) return message
    return { ...message, content: result.text }
  }
  if (!Array.isArray(content)) return message
  let changed = false
  const blocks = content.map((block) => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
    const result = expander.expand(block.text)
    if (result.text === block.text) return block
    changed = true
    return { ...block, text: result.text }
  })
  if (!changed) return message
  return { ...message, content: blocks }
}

/**
 * Replace every placeholder in the user messages with its text.
 *
 * The same array comes back when nothing changed, so the caller can leave
 * the decision alone.
 *
 * @param {unknown} messages
 * @param {{ expand(text: string): { text: string } }} expander
 */
export function mapUserText(messages, expander) {
  if (!Array.isArray(messages)) return messages
  let changed = false
  const mapped = messages.map((message) => {
    const next = expandMessage(message, expander)
    if (next !== message) changed = true
    return next
  })
  return changed ? mapped : messages
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx, config) {
  const pending = new PendingPastes()
  ctx.provide('pasteController', new PasteController(pending))

  // agent/pre-step — before the model sees the prompt. The placeholders in
  // the user messages are swapped back for the text they stand for.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const messages = decision.messages ?? payload?.messages ?? []
    const snapshot = pending.toArray()
    if (snapshot.length === 0) return decision
    const expander = createExpander(snapshot)
    const expanded = mapUserText(messages, expander)
    if (expanded === messages) return decision
    pending.settle(expander.used)
    return { ...decision, kind: 'enter', messages: expanded }
  })
}
