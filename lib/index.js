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

/**
 * How many delivered texts the host keeps around.
 *
 * The client asks the host for a text when a sent message shows its pill,
 * and a delivered text is worth keeping for a while — but not forever. The
 * newest ones are the interesting ones, so the oldest go first once there
 * are more than this. A paste that is still waiting for its turn is never
 * dropped: it carries the text the model still needs.
 */
const RETAINED_LIMIT = 50

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
    // A new paste of the same size must not be shadowed by the text of an
    // earlier one: the delivered (consumed) and the revoked entries of that
    // placeholder go away first.
    this.#entries = this.#entries.filter(
      (entry) => !(entry.placeholder === placeholder && (entry.consumed || entry.revoked)),
    )
    this.#entries.push({ placeholder, text, consumed: false, revoked: false })
    this.#trim()
    return this
  }

  /**
   * Mark a paste as gone.
   *
   * The client tells the host that a placeholder left the draft — but that is
   * also what happens when the turn is submitted: the composer clears the
   * draft, and the expansion runs here *after* that. Deleting the text right
   * away would lose the paste, so the text is kept until the turn has had its
   * chance to use it; `settle` drops whatever the turn did not use.
   *
   * @param {string} placeholder
   * @returns {boolean} whether something was marked
   */
  forget(placeholder) {
    const index = this.#entries.findLastIndex((entry) => entry.placeholder === placeholder)
    if (index < 0) return false
    this.#entries = this.#entries.map((entry, at) => (at === index ? { ...entry, revoked: true } : entry))
    return true
  }

  /**
   * @param {string} placeholder
   * @returns {boolean} whether the host still holds a text for it
   */
  has(placeholder) {
    return this.#entries.some((entry) => entry.placeholder === placeholder)
  }

  /**
   * The text of a paste, or null when the host does not have it.
   *
   * A delivered paste keeps its text: the client asks for it when a sent
   * message shows the pill, and the message the user reads is the expanded
   * one.
   *
   * @param {string} placeholder
   * @returns {string | null}
   */
  text(placeholder) {
    if (typeof placeholder !== 'string' || placeholder === '') return null
    const entry = this.#entries.findLast(
      (item) => item.placeholder === placeholder && !item.revoked,
    )
    return entry ? entry.text : null
  }

  /** @returns {number} how many pastes are registered */
  size() {
    return this.#entries.length
  }

  /**
   * Drop the oldest delivered texts once there are more than the limit.
   *
   * Only the expanded (delivered) entries go: a paste that is still waiting
   * for its turn carries the text the model still needs, so it stays.
   */
  #trim() {
    const delivered = this.#entries.filter((entry) => entry.consumed)
    const excess = delivered.length - RETAINED_LIMIT
    if (excess <= 0) return
    const doomed = new Set(delivered.slice(0, excess))
    this.#entries = this.#entries.filter((entry) => !doomed.has(entry))
  }

  /** @returns {Array<[string, string]>} the pending list in registration order */
  toArray() {
    return this.#entries.map((entry) => [entry.placeholder, entry.text])
  }

  /**
   * Close an expansion: the entries the expansion used stay (a repeated
   * pre-step expands the same way), the ones the client revoked and the turn
   * did not use go away.
   *
   * @param {number[]} used indexes into the list handed to the expander
   */
  settle(used) {
    const usedIndexes = new Set(Array.isArray(used) ? used : [])
    this.#entries = this.#entries
      .map((entry, index) => {
        if (usedIndexes.has(index)) return { ...entry, consumed: true, revoked: false }
        if (entry.revoked) return null
        return entry
      })
      .filter((entry) => entry !== null)
    this.#trim()
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

  /**
   * The text of a paste, or null when the host does not have it.
   *
   * The client asks for it when a sent message shows the pill: the host
   * keeps the text of a delivered paste, so the bubble can show the whole
   * text again even when the client lost its own copy.
   *
   * @param {string} placeholder
   * @returns {{ ok: boolean, text?: string | null, error?: string }}
   */
  text(placeholder) {
    if (typeof placeholder !== 'string' || placeholder === '') {
      return { ok: false, error: 'invalid placeholder' }
    }
    return { ok: true, text: this.pending.text(placeholder) }
  }
}

Object.defineProperty(PasteController.prototype, DESCRIPTOR_KEY, {
  value: {
    version: 1,
    methods: [
      { method: 'remember', invocation: { kind: 'direct' } },
      { method: 'has', invocation: { kind: 'direct' } },
      { method: 'text', invocation: { kind: 'direct' } },
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
    // Always settle: a paste the client revoked and this turn did not use is
    // gone, the ones this turn used are marked as delivered.
    pending.settle(expander.used)
    if (expanded === messages) return decision
    return { ...decision, kind: 'enter', messages: expanded }
  })
}
