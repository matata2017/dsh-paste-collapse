/**
 * dsh-paste-collapse — marker helpers.
 *
 * Pure functions, zero I/O, zero dependencies: the host plugin (lib/index.js)
 * and the unit tests both import this module, and nothing here touches the
 * filesystem, the network or a browser.
 *
 * The rules are a line by line port of Codex
 * (`codex-rs/tui/src/bottom_pane/chat_composer.rs`):
 *
 * - `const LARGE_PASTE_CHAR_THRESHOLD: usize = 1000;` (chat_composer.rs:457)
 * - `next_large_paste_placeholder` (chat_composer.rs:1921-1943)
 * - `expand_pending_pastes` (chat_composer.rs:2561-2604)
 */

/**
 * Codex's paste threshold. A paste of at most this many characters is left
 * alone and follows the default composer behaviour.
 */
export const PASTE_THRESHOLD = 1000

/**
 * Codex's placeholder for one paste: `[Pasted Content <N> chars]`.
 *
 * @param {number} charCount
 * @returns {string}
 */
function basePlaceholder(charCount) {
  return `[Pasted Content ${charCount} chars]`
}

/**
 * Normalise a pending list into `[{ placeholder, text }]`.
 *
 * Codex stores `Vec<(String, String)>`; a plain `Array<[placeholder, text]>`
 * is accepted as well, and a bare string is read as a placeholder with no
 * text (such an entry can never be expanded).
 *
 * @param {Array<[string, string] | string>} pending
 * @returns {{ placeholder: string, text: string }[]}
 */
function normalizePending(pending) {
  if (!Array.isArray(pending)) return []
  const entries = []
  for (const entry of pending) {
    if (typeof entry === 'string') {
      entries.push({ placeholder: entry, text: '' })
      continue
    }
    if (!Array.isArray(entry) || entry.length === 0) continue
    const placeholder = entry[0]
    const text = entry[1]
    if (typeof placeholder !== 'string' || placeholder === '') continue
    if (typeof text !== 'string') continue
    entries.push({ placeholder, text })
  }
  return entries
}

/**
 * Codex's numbering rule (`next_large_paste_placeholder`).
 *
 * The first paste of a given size gets the bare placeholder, every later
 * paste of the same size gets `#2`, `#3`, … The counter is per size: a
 * 3000 character paste starts its own sequence.
 *
 * @param {{ charCount: number, pending?: Array<[string, string]> }} options
 * @returns {string} the placeholder to put into the draft
 */
export function nextPlaceholder({ charCount, pending } = {}) {
  const count = Number(charCount)
  const size = Number.isFinite(count) ? Math.trunc(count) : 0
  const base = basePlaceholder(size)
  const prefix = `${base} #`
  let maxSuffix = 0
  for (const entry of normalizePending(pending)) {
    const placeholder = entry.placeholder
    if (placeholder === base) {
      maxSuffix = Math.max(maxSuffix, 1)
      continue
    }
    if (!placeholder.startsWith(prefix)) continue
    const suffix = placeholder.slice(prefix.length)
    // Rust's `suffix.parse::<usize>()` only accepts digits.
    if (!/^\d+$/.test(suffix)) continue
    const value = Number(suffix)
    if (!Number.isSafeInteger(value)) continue
    maxSuffix = Math.max(maxSuffix, value)
  }
  return maxSuffix === 0 ? base : `${base} #${maxSuffix + 1}`
}

/**
 * Build an expander that shares one FIFO queue per placeholder across many
 * texts — Codex expands a whole turn, not one string at a time.
 *
 * The k-th occurrence of a placeholder is replaced by the k-th text
 * registered for it; a placeholder without a matching text is kept verbatim.
 *
 * @param {Array<[string, string]>} pending
 * @returns {{ expand(text: string): { text: string, used: number[] }, used: number[] }}
 */
export function createExpander(pending) {
  const entries = normalizePending(pending)
  /** @type {Map<string, { placeholder: string, text: string, index: number }[]>} */
  const queues = new Map()
  entries.forEach((entry, index) => {
    const queue = queues.get(entry.placeholder)
    const record = { placeholder: entry.placeholder, text: entry.text, index }
    if (queue) queue.push(record)
    else queues.set(entry.placeholder, [record])
  })
  // Longest first: `[Pasted Content 2000 chars #2]` starts with the bare
  // placeholder, so the longer one has to win at the same offset.
  const placeholders = [...queues.keys()].sort((left, right) => right.length - left.length)
  const cursor = new Map()
  const used = []

  function nextHit(text, from) {
    let best = -1
    for (const placeholder of placeholders) {
      const at = text.indexOf(placeholder, from)
      if (at < 0) continue
      if (best < 0 || at < best) best = at
    }
    return best
  }

  function expand(text) {
    if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', used: [] }
    const parts = []
    let index = 0
    while (index < text.length) {
      const hit = placeholders.find((placeholder) => text.startsWith(placeholder, index))
      if (hit === undefined) {
        const next = nextHit(text, index)
        if (next < 0) {
          parts.push(text.slice(index))
          break
        }
        parts.push(text.slice(index, next))
        index = next
        continue
      }
      const queue = queues.get(hit)
      const at = cursor.get(hit) ?? 0
      if (at >= queue.length) {
        // No text left for this placeholder: keep it as it is.
        parts.push(hit)
        index += hit.length
        continue
      }
      const record = queue[at]
      cursor.set(hit, at + 1)
      used.push(record.index)
      parts.push(record.text)
      index += hit.length
    }
    return { text: parts.join(''), used }
  }

  return {
    expand,
    get used() {
      return used.slice()
    },
  }
}

/**
 * Codex's expansion rule (`expand_pending_pastes`).
 *
 * @param {string} text
 * @param {Array<[string, string]>} pending
 * @returns {{ text: string, used: number[] }} the expanded text and the
 *   indexes of the pending entries that were consumed
 */
export function expandPlaceholders(text, pending) {
  return createExpander(pending).expand(text)
}

/**
 * The one line preview shown on the pill.
 *
 * @param {string} text
 * @param {number} [max] how many characters of the first line to keep
 * @returns {string}
 */
export function previewText(text, max = 24) {
  if (typeof text !== 'string' || text === '') return ''
  const wanted = Number(max)
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : 24
  const line = text.split(/\r?\n/, 1)[0]
  if (line.length <= limit) return line
  return `${line.slice(0, limit)}…`
}
