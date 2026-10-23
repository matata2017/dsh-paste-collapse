// dsh-paste-collapse — client plugin.
//
// The composer collapses a large paste into a Codex style placeholder
// (`[Pasted Content N chars]`) and shows a pill above the editor. The full
// text lives on the host, which expands the placeholder back before the
// model reads the turn.
//
// The marker rules below are a copy of lib/marker.js: the browser bundle
// cannot import from the package, and test/client-bundle.mjs asserts that
// both copies agree.
//
// The browser loader concatenates every installed plugin's client bundle into
// one script, so a top-level name belongs to all of them: two plugins calling
// theirs `SELF_ID` is a syntax error that takes the whole app down. Keep this
// file's names to itself.
;(function () {
const SELF_ID = (() => {
  const entries = (typeof window !== 'undefined' && window.__DSH_BOOT__?.entries) || []
  const ids = entries.map((entry) => entry?.id).filter((id) => typeof id === 'string')
  return ids.find((id) => id === 'dsh-paste-collapse') ?? 'dsh-paste-collapse'
})()

window.__ModuleLoader__.load({
  id: SELF_ID,
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-paste-collapse'

    /* ---------------- marker rules (mirror of lib/marker.js) ---------------- */

    /** Codex's paste threshold (chat_composer.rs:457). */
    const PASTE_THRESHOLD = 1000
    /**
     * How long the host may take before the paste is inserted uncollapsed.
     *
     * The host is busy while an agent turn runs, and a busy host answers
     * late: a paste that lands in the middle of a turn must not be
     * uncollapsed just because the host did not answer within a second and
     * a half.
     */
    const HOST_TIMEOUT_MS = 5000
    /**
     * How often the paste is handed to the host before the text is inserted
     * as it is. The first attempt can lose the race with a busy host, the
     * second one usually wins.
     */
    const HOST_ATTEMPTS = 2

    /**
     * Codex's numbering rule (`next_large_paste_placeholder`).
     *
     * @param {{ charCount: number, pending: Array<[string, string]> }} options
     * @returns {string}
     */
    function nextPlaceholder({ charCount, pending }) {
      const count = Number(charCount)
      const size = Number.isFinite(count) ? Math.trunc(count) : 0
      const base = `[Pasted Content ${size} chars]`
      const prefix = `${base} #`
      let maxSuffix = 0
      for (const entry of pending ?? []) {
        const placeholder = Array.isArray(entry) ? entry[0] : entry
        if (typeof placeholder !== 'string') continue
        if (placeholder === base) {
          maxSuffix = Math.max(maxSuffix, 1)
          continue
        }
        if (!placeholder.startsWith(prefix)) continue
        const suffix = placeholder.slice(prefix.length)
        if (!/^\d+$/.test(suffix)) continue
        const value = Number(suffix)
        if (!Number.isSafeInteger(value)) continue
        maxSuffix = Math.max(maxSuffix, value)
      }
      return maxSuffix === 0 ? base : `${base} #${maxSuffix + 1}`
    }

    /**
     * The one line preview shown on the pill.
     *
     * @param {string} text
     * @param {number} [max]
     * @returns {string}
     */
    function previewText(text, max = 24) {
      if (typeof text !== 'string' || text === '') return ''
      const wanted = Number(max)
      const limit = Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : 24
      const line = text.split(/\r?\n/, 1)[0]
      if (line.length <= limit) return line
      return `${line.slice(0, limit)}…`
    }

    /* ---------------- dictionaries ---------------- */

    const en = {
      meta: {
        title: 'Paste Collapse',
        description: 'Large pastes collapse into a Codex-style placeholder and expand back to the full text before the model reads them.',
      },
      count: '{count} chars',
      countK: '{value}k chars',
      lost: 'text lost',
      loading: 'loading…',
      expand: 'show the full text',
      collapse: 'collapse',
      drawerTitle: 'Pasted text',
      view: 'view',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
    }

    const zh = {
      meta: {
        title: '粘贴折叠',
        description: '大段粘贴折叠成 Codex 同款占位符，模型看到之前换回全文。',
      },
      count: '{count} 字符',
      countK: '{value}k 字符',
      lost: '原文已丢失',
      loading: '加载中…',
      expand: '展开全文',
      collapse: '收起',
      drawerTitle: '粘贴文本',
      view: '查看',
      copy: '复制',
      copied: '已复制',
      close: '关闭',
    }

    /* ---------------- styles ---------------- */

    const STYLE = [
      // The composer renders this slot into a zero height anchor that sits on
      // the top edge of the card, so a plain flow box would spill over the
      // card's border. Float the row above the composer, the way the slash
      // menu does (bottom: 100% + gap). The row sits ON the edge (no gap) so
      // the pill reads as a tab of the input box instead of a floating box.
      '.__dpc_root{position:absolute;bottom:100%;left:0;right:0;display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap;padding:0 12px 6px;pointer-events:none;z-index:5}',
      '.__dpc_item{position:relative;pointer-events:auto;display:flex;flex-direction:column;gap:4px;max-width:240px;min-width:0}',
      '.__dpc_pill{display:inline-flex;align-items:center;gap:6px;max-width:240px;min-width:0;height:24px;padding:0 10px;border-radius:999px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 22%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 8%,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary));font-size:12px;line-height:1;font-family:inherit;cursor:pointer;text-align:left;box-shadow:var(--dsw-elevation-2,0 1px 2px rgb(0 0 0 / 6%));transition:background-color 120ms ease,border-color 120ms ease}',
      '.__dpc_pill:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 14%,var(--dsw-alias-bg-layer-2,#fff));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 38%,transparent)}',
      '.__dpc_pill:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.__dpc_icon{display:inline-flex;align-items:center;color:var(--dsw-alias-state-business-primary);flex:none;opacity:0.9}',
      '.__dpc_preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}',
      '.__dpc_count{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}',
      '.__dpc_pill .__dpc_count{margin-left:2px;padding-left:8px;border-left:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);font-size:11px}',
      '.__dpc_lost{color:var(--dsw-alias-state-error-primary);flex:none}',
      // The pill inside a sent message: the same chip as the one in the
      // composer, sized for a line of text. No literal colors: the theme
      // variables decide.
      '.__dpc_inlinePill{display:inline-flex;align-items:center;gap:4px;max-width:260px;padding:0 6px;border-radius:999px;border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-layer-2,transparent));color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary));font-size:0.92em;line-height:1.6;font-family:inherit;cursor:pointer;vertical-align:baseline;white-space:nowrap;overflow:hidden}',
      '.__dpc_inlinePill:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,var(--dsw-alias-bg-layer-2,transparent))}',
      '.__dpc_inlinePill:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.__dpc_inlinePill .__dpc_preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:100%}',
      '.__dpc_inlinePill .__dpc_icon{flex:none}',
      // The side panel: the full pasted text, the way Codex and WorkBuddy open
      // a drawer instead of squeezing the text into a popover.
      '.__dpc_backdrop{position:fixed;inset:0;z-index:1199;background:rgb(0 0 0 / 18%)}',
      '.__dpc_drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,92vw);z-index:1200;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-left:0.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent,0 4px 24px rgb(0 0 0 / 12%))}',
      '.__dpc_drawerHead{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}',
      '.__dpc_drawerTitle{font-size:13px;font-weight:600;flex:none;color:var(--dsw-alias-label-primary)}',
      '.__dpc_drawerBody{flex:1;min-height:0;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary)}',
      '.__dpc_drawerActions{display:flex;gap:8px;padding:10px 14px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.__dpc_btn{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:var(--dsw-radius-sm,6px);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-family:inherit;cursor:pointer}',
      '.__dpc_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 4%))}',
      '.__dpc_iconBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--dsw-radius-sm,6px);border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1}',
      '.__dpc_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 4%))}',
    ]

    /* ---------------- connection ---------------- */

    let connection = null
    let translate = (key) => key

    /* ---------------- the side panel ---------------- */

    /**
     * The text of every collapsed paste, by placeholder. The drawer reads it
     * from here so the drawer can live in its own slot (the shell overlay)
     * while the composer keeps the pills.
     *
     * @type {Map<string, string>}
     */
    const pasteTexts = new Map()

    /**
     * The text of every paste that left the composer, by placeholder.
     *
     * The draft is cleared when the turn is sent, and the message of that
     * turn is still on its way to the bubble: the text moves here instead of
     * being dropped, so the bubble can show the paste again.
     *
     * @type {Map<string, string>}
     */
    const sentTexts = new Map()

    /** How many sent pastes are kept around. */
    const SENT_TEXT_LIMIT = 100

    /**
     * @param {string} placeholder
     * @param {string} text
     */
    function rememberSentText(placeholder, text) {
      sentTexts.delete(placeholder)
      sentTexts.set(placeholder, text)
      while (sentTexts.size > SENT_TEXT_LIMIT) {
        const oldest = sentTexts.keys().next()
        if (oldest.done) break
        sentTexts.delete(oldest.value)
      }
    }

    /**
     * The text of a paste, wherever this client knows it: in the composer or
     * in a message that was sent.
     *
     * @param {string} placeholder
     * @returns {string | undefined}
     */
    function localPasteText(placeholder) {
      return pasteTexts.get(placeholder) ?? sentTexts.get(placeholder)
    }

    /** The paste the drawer shows, or null when it is closed. */
    let drawerState = null
    const drawerListeners = new Set()

    /**
     * @param {{ placeholder: string, chars: number } | null} next
     */
    function setDrawer(next) {
      drawerState = next
      for (const listener of drawerListeners) listener()
    }

    /**
     * Open the side panel for a paste — from the composer pill or from the
     * pill inside a sent message.
     *
     * @param {string} placeholder
     * @param {number} chars
     */
    function openPasteDrawer(placeholder, chars) {
      setDrawer({ placeholder, chars })
    }

    /**
     * @returns {{ placeholder: string, chars: number } | null}
     */
    function useDrawer() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        drawerListeners.add(listener)
        return () => {
          drawerListeners.delete(listener)
        }
      }, [])
      return drawerState
    }

    function setConnection(value) {
      connection = value ?? null
    }

    function resolveHandle(service) {
      if (!service) return null
      if (service.rpc && typeof service.rpc.call === 'function') return service
      if (service.connection && service.connection.rpc && typeof service.connection.rpc.call === 'function') {
        return service.connection
      }
      return null
    }

    async function call(method, args) {
      if (!connection) throw new Error('paste service is not connected')
      const response = await connection.rpc.call('/api', `paste/${method}`, { args })
      if (!response || response.ok !== true) {
        throw new Error(response?.error?.message ?? 'paste call failed')
      }
      return response.value
    }

    /**
     * Call the host, but never wait longer than `ms`: a slow host must not
     * hold the paste hostage, the text is inserted uncollapsed instead.
     *
     * @param {string} method
     * @param {object} args
     * @param {number} ms
     */
    async function callWithTimeout(method, args, ms) {
      let timer
      try {
        return await Promise.race([
          call(method, args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('paste call timed out')), ms)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        values && name in values ? String(values[name]) : match,
      )
    }

    /**
     * The character count, kept short so a pill stays small: 6.7k instead of
     * 6684, 12k instead of 12000. The exact number is in the drawer.
     *
     * @param {number} chars
     * @returns {string}
     */
    function countText(chars) {
      const n = Number(chars)
      if (!Number.isFinite(n) || n <= 0) return format(translate('count'), { count: 0 })
      if (n < 1000) return format(translate('count'), { count: n })
      const k = n >= 10000 ? Math.round(n / 1000) : Math.round(n / 100) / 10
      return format(translate('countK'), { value: String(k) })
    }

    /**
     * Call the host, and try again when it did not answer.
     *
     * The host is busy while an agent turn runs, and a busy host answers
     * late. The paste is handed over once more before the text is inserted
     * as it is — the text must not be lost because the host was busy.
     *
     * @param {string} method
     * @param {object} args
     * @param {number} ms
     * @param {number} [attempts]
     */
    async function callWithRetries(method, args, ms, attempts = HOST_ATTEMPTS) {
      let lastError
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await callWithTimeout(method, args, ms)
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error('paste call failed')
    }

    /* ---------------- the pill row ---------------- */

    /**
     * The document icon on a pill and in the drawer header.
     *
     * @returns {React.ReactNode}
     */
    function pasteIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M4 2.5h4.5L12 6v7.5H4z' }),
        h('path', { d: 'M8.5 2.5V6H12' }),
        h('path', { d: 'M6 9h4M6 11.5h3' }),
      )
    }

    /**
     * The overlay slot component: one pill per collapsed paste.
     *
     * @param {{ inputActions?: unknown, useInput?: unknown }} props
     */
    function PastePills(props) {
      const inputActions = props.inputActions
      const useInput = props.useInput
      const hostRef = React.useRef(null)
      /** @type {{ placeholder: string, chars: number, text: string, expanded: boolean, lost: boolean }[]} */
      const entriesRef = React.useRef([])
      const actionsRef = React.useRef(inputActions)
      const [, bump] = React.useState(0)
      actionsRef.current = inputActions

      // The pending list Codex keeps: the pills and the placeholder numbering
      // read the same entries, so the numbers cannot drift apart.
      const pending = () => entriesRef.current.map((entry) => [entry.placeholder, entry.text])

      // Codex drops a pending paste as soon as its placeholder leaves the
      // draft (chat_composer.rs:2053-2055), so the next paste of the same
      // size starts over at the bare placeholder again.
      const input = typeof useInput === 'function' ? useInput((state) => state) : undefined
      const draftRev = input?.draftRev
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const seenRevRef = React.useRef(undefined)

      React.useEffect(() => {
        if (draftRev === undefined) return
        if (seenRevRef.current === undefined) {
          seenRevRef.current = draftRev
          return
        }
        if (seenRevRef.current === draftRev) return
        seenRevRef.current = draftRev
        const kept = entriesRef.current.filter((entry) => draft.includes(entry.placeholder))
        if (kept.length === entriesRef.current.length) return
        const dropped = entriesRef.current.filter((entry) => !draft.includes(entry.placeholder))
        entriesRef.current = kept
        if (draft === '') {
          // The turn was sent: the composer is empty, but the message that
          // carries the paste is on its way. The text moves to the sent
          // texts — the bubble shows the paste as a pill and needs the text
          // to open it.
          for (const entry of dropped) {
            rememberSentText(entry.placeholder, entry.text)
            pasteTexts.delete(entry.placeholder)
          }
          bump((value) => value + 1)
          return
        }
        for (const entry of dropped) pasteTexts.delete(entry.placeholder)
        bump((value) => value + 1)
        // Tell the host the paste is gone — the placeholder left the draft
        // while the draft still had something else in it. An empty draft
        // means the turn was submitted: the host expands the placeholder
        // after that, so it still needs the text.
        for (const entry of dropped) {
          void callWithTimeout('remember', { placeholder: entry.placeholder, text: null }, HOST_TIMEOUT_MS).catch(
            () => {},
          )
        }
      }, [draftRev])

      // The paste interceptor. It listens on the composer card in the
      // capture phase: Lexical registers its own paste listener on the
      // editor, and only an ancestor in the capture phase runs before it.
      React.useEffect(() => {
        const node = hostRef.current
        if (!node || typeof node.closest !== 'function') return undefined
        const card = node.closest('[data-composer-card]')
        if (!card) return undefined
        const editor = card.querySelector('[contenteditable="true"]')
        const onPaste = (event) => {
          void handlePaste(event, editor)
        }
        card.addEventListener('paste', onPaste, true)
        return () => {
          card.removeEventListener('paste', onPaste, true)
        }
      }, [inputActions])

      // The host may have been restarted: the text is gone and the pill says
      // so. Every placeholder is checked once, the result is kept on the pill.
      React.useEffect(() => {
        const unchecked = entriesRef.current.filter((entry) => !entry.checked)
        if (unchecked.length === 0) return undefined
        let cancelled = false
        void (async () => {
          for (const entry of unchecked) {
            let lost = false
            try {
              const value = await callWithTimeout('has', { placeholder: entry.placeholder }, HOST_TIMEOUT_MS)
              lost = value?.has !== true
            } catch {
              // The host is not reachable: do not claim the text is lost.
              continue
            }
            if (cancelled) return
            entriesRef.current = entriesRef.current.map((item) =>
              item.placeholder === entry.placeholder ? { ...item, checked: true, lost } : item,
            )
            bump((value) => value + 1)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [entriesRef.current.length])

      /**
       * Insert the placeholder into the draft, retrying once with a fresh
       * insertion span.
       */
      function insertPlaceholder(actions, placeholder) {
        let span = actions.captureInsertion()
        if (actions.insertText(placeholder, span) !== false) return true
        span = actions.captureInsertion()
        return actions.insertText(placeholder, span) !== false
      }

      /**
       * Insert the pasted text as it is. This is the fallback whenever the
       * collapse cannot be completed: the text must never be lost.
       */
      function insertRaw(actions, text) {
        let span = actions.captureInsertion()
        if (actions.insertText(text, span) !== false) return true
        span = actions.captureInsertion()
        if (actions.insertText(text, span) !== false) return true
        if (typeof actions.setDraft === 'function') {
          try {
            actions.setDraft(text)
            return true
          } catch {
            /* fall through to the warning below */
          }
        }
        console.warn('[dsh-paste-collapse] the pasted text could not be inserted')
        return false
      }

      /**
       * The paste handler. A paste above the threshold is collapsed into a
       * placeholder and the text is handed to the host; when the host cannot
       * be reached the text is inserted as it is.
       */
      async function handlePaste(event, editor) {
        const actions = actionsRef.current
        if (!actions) return
        if (editor && event.target && typeof editor.contains === 'function' && !editor.contains(event.target)) {
          return
        }
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (typeof text !== 'string' || text.length <= PASTE_THRESHOLD) return
        event.preventDefault()
        event.stopPropagation()
        const placeholder = nextPlaceholder({ charCount: text.length, pending: pending() })
        let stored = false
        try {
          // The host is busy while an agent turn runs: hand the text over
          // once more before the collapse is given up. Nothing is inserted
          // yet, so a retry cannot leave two placeholders behind.
          const value = await callWithRetries('remember', { placeholder, text }, HOST_TIMEOUT_MS)
          stored = value?.ok === true
        } catch {
          stored = false
        }
        if (!stored) {
          // The host is not there: keep the text, drop the collapse.
          insertRaw(actions, text)
          return
        }
        if (!insertPlaceholder(actions, placeholder)) {
          // The placeholder did not make it into the draft: revoke it on the
          // host and keep the text.
          try {
            await callWithTimeout('remember', { placeholder, text: null }, HOST_TIMEOUT_MS)
          } catch {
            /* the host will drop the unused entry on the next expansion */
          }
          insertRaw(actions, text)
          return
        }
        entriesRef.current = [
          ...entriesRef.current,
          { placeholder, chars: text.length, text, lost: false, checked: false },
        ]
        pasteTexts.set(placeholder, text)
        bump((value) => value + 1)
      }

      function openDrawer(entry) {
        setDrawer({ placeholder: entry.placeholder, chars: entry.chars })
      }

      if (!inputActions) return null
      return h(
        'div',
        { className: '__dpc_root', ref: hostRef },
        entriesRef.current.map((entry) =>
          h(
            'div',
            { key: entry.placeholder, className: '__dpc_item' },
            h(
              'button',
              {
                type: 'button',
                className: '__dpc_pill',
                onClick: () => openDrawer(entry),
                title: `${previewText(entry.text, 90)} · ${countText(entry.chars)}`,
                'aria-haspopup': 'dialog',
              },
              h('span', { className: '__dpc_icon' }, pasteIcon()),
              h('span', { className: '__dpc_preview' }, previewText(entry.text, 16)),
              h('span', { className: '__dpc_count' }, countText(entry.chars)),
              entry.lost ? h('span', { className: '__dpc_lost' }, translate('lost')) : null,
            ),
          ),
        ),
      )
    }

    /* ---------------- the pill inside a message ---------------- */

    /**
     * The Codex placeholder as it is written in a message.
     *
     * @type {RegExp}
     */
    const PLACEHOLDER_PATTERN = /\[Pasted Content (\d+) chars\](?: #(\d+))?/g

    /**
     * Every paste this client knows about: the ones in the composer and the
     * ones that were sent.
     *
     * @returns {Array<[string, string]>}
     */
    function knownPastes() {
      return [...pasteTexts.entries(), ...sentTexts.entries()]
    }

    /**
     * Split a message into plain text and the collapsed pastes inside it.
     *
     * Two things can mark a paste in a message:
     *
     * - the placeholder itself, when the message still carries it
     * - the pasted text, when the message carries the expanded text: the
     *   host swaps the placeholder back before the model reads the turn, and
     *   the message the user reads is that expanded one
     *
     * A pasted text is a thousand characters at least, so finding it inside
     * a message cannot match the wrong thing.
     *
     * @param {string} text
     * @returns {Array<{ kind: 'text', text: string } | { kind: 'paste', placeholder: string, chars: number, text?: string }>}
     */
    function splitPasteParts(text) {
      if (typeof text !== 'string' || text === '') return []
      /** @type {Array<{ start: number, end: number, placeholder: string, chars: number, text?: string }>} */
      const spans = []
      PLACEHOLDER_PATTERN.lastIndex = 0
      let match = PLACEHOLDER_PATTERN.exec(text)
      while (match !== null) {
        const chars = Number(match[1])
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          placeholder: match[0],
          chars: Number.isFinite(chars) ? chars : 0,
        })
        match = PLACEHOLDER_PATTERN.exec(text)
      }
      for (const [placeholder, pasted] of knownPastes()) {
        if (typeof pasted !== 'string' || pasted.length < PASTE_THRESHOLD) continue
        let at = text.indexOf(pasted)
        while (at >= 0) {
          spans.push({
            start: at,
            end: at + pasted.length,
            placeholder,
            chars: pasted.length,
            text: pasted,
          })
          at = text.indexOf(pasted, at + pasted.length)
        }
      }
      if (spans.length === 0) return []
      spans.sort((left, right) => {
        if (left.start !== right.start) return left.start - right.start
        return right.end - right.start - (left.end - left.start)
      })
      const kept = []
      for (const span of spans) {
        const previous = kept[kept.length - 1]
        if (!previous || span.start >= previous.end) {
          kept.push(span)
          continue
        }
        // The two overlap: the longer one wins.
        if (span.end - span.start > previous.end - previous.start) kept[kept.length - 1] = span
      }
      const parts = []
      let cursor = 0
      for (const span of kept) {
        if (span.start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, span.start) })
        parts.push({
          kind: 'paste',
          placeholder: span.placeholder,
          chars: span.chars,
          text: span.text,
        })
        cursor = span.end
      }
      if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
      return parts
    }

    /**
     * The pill inside a message bubble: the collapsed paste, clickable.
     *
     * @param {{ placeholder: string, chars: number, text?: string }} props
     */
    function PasteInlinePill(props) {
      const placeholder = props.placeholder
      const chars = props.chars
      const text = props.text ?? localPasteText(placeholder)
      return h(
        'button',
        {
          type: 'button',
          className: '__dpc_inlinePill',
          onClick: () => openPasteDrawer(placeholder, chars),
          title: translate('view'),
          'aria-haspopup': 'dialog',
        },
        h('span', { className: '__dpc_icon' }, pasteIcon()),
        h('span', { className: '__dpc_preview' }, previewText(text ?? '', 24)),
        h('span', { className: '__dpc_count' }, countText(chars)),
      )
    }

    /**
     * The renderer for the text of a user message.
     *
     * The host renders the plain text of a message with the `text` key of
     * the `conversation.user.text.node` slot. This renderer takes that seat
     * and turns every collapsed paste in the message into a pill, so the
     * bubble shows the same thing the composer showed.
     *
     * @param {{ node?: { data?: { text?: string, display?: string } }, raw?: string }} props
     */
    function PasteAwareText(props) {
      let text = ''
      try {
        text = props?.node?.data?.display ?? props?.node?.data?.text ?? props?.raw ?? ''
        const parts = splitPasteParts(text)
        if (parts.length === 0) return h('span', null, text)
        return h(
          React.Fragment,
          null,
          parts.map((part, index) =>
            part.kind === 'text'
              ? h('span', { key: `text-${index}` }, part.text)
              : h(PasteInlinePill, {
                  key: `paste-${index}`,
                  placeholder: part.placeholder,
                  chars: part.chars,
                  text: part.text,
                }),
          ),
        )
      } catch {
        // A paste that cannot be rendered must never break the message.
        return h('span', null, text)
      }
    }

    /* ---------------- the side panel ---------------- */

    /**
     * The drawer with the full pasted text. Codex and WorkBuddy open a side
     * panel for a collapsed paste; the composer keeps only the tab.
     */
    function PasteDrawer() {
      const state = useDrawer()
      const [copied, setCopied] = React.useState(false)
      /** The text the host handed out, `null` when it does not have it. */
      const [remoteText, setRemoteText] = React.useState(undefined)

      React.useEffect(() => {
        if (!state) return undefined
        // The client may have lost its own copy — after a reload, or when
        // the paste belongs to another window. The host keeps the text of a
        // delivered paste and hands it out again.
        setRemoteText(undefined)
        if (typeof localPasteText(state.placeholder) === 'string') return undefined
        let cancelled = false
        void (async () => {
          try {
            const value = await callWithRetries('text', { placeholder: state.placeholder }, HOST_TIMEOUT_MS)
            if (!cancelled) setRemoteText(typeof value?.text === 'string' ? value.text : null)
          } catch {
            if (!cancelled) setRemoteText(null)
          }
        })()
        return () => {
          cancelled = true
        }
      }, [state?.placeholder])

      React.useEffect(() => {
        if (!state) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setDrawer(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state])

      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])

      if (!state) return null
      const text = localPasteText(state.placeholder) ?? remoteText
      // `undefined` means the host did not answer yet, `null` means it does
      // not have the text any more.
      const body =
        typeof text === 'string' ? text : remoteText === null ? translate('lost') : translate('loading')

      async function copy() {
        if (typeof text !== 'string') return
        try {
          await navigator.clipboard?.writeText(text)
          setCopied(true)
        } catch {
          /* the clipboard may be denied: the text stays on screen */
        }
      }

      return h(
        React.Fragment,
        null,
        h('div', { className: '__dpc_backdrop', onClick: () => setDrawer(null) }),
        h(
          'aside',
          {
            className: '__dpc_drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': translate('drawerTitle'),
          },
          h(
            'div',
            { className: '__dpc_drawerHead' },
            h('span', { className: '__dpc_icon' }, pasteIcon()),
            h('span', { className: '__dpc_drawerTitle' }, translate('drawerTitle')),
            h('span', { className: '__dpc_count' }, format(translate('count'), { count: state.chars })),
            h(
              'button',
              {
                type: 'button',
                className: '__dpc_iconBtn',
                'aria-label': translate('close'),
                onClick: () => setDrawer(null),
              },
              '✕',
            ),
          ),
          h(
            'div',
            { className: '__dpc_drawerBody' },
            body,
          ),
          h(
            'div',
            { className: '__dpc_drawerActions' },
            h(
              'button',
              { type: 'button', className: '__dpc_btn', onClick: () => { void copy() } },
              copied ? translate('copied') : translate('copy'),
            ),
            h('button', { type: 'button', className: '__dpc_btn', onClick: () => setDrawer(null) }, translate('close')),
          ),
        ),
      )
    }

    /* ---------------- plugin entry ---------------- */

    function apply(ctx) {
      ctx.inject(['locale', 'slots', 'connection'], (client) => {
        translate = client.locale.bind(NS)
        client.effect(() => client.locale.register(NS, { zh, en }), 'dsh-paste-collapse: dictionaries')
        client.effect(() => {
          const style = document.createElement('style')
          style.textContent = STYLE
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-paste-collapse: style')
        try {
          client.slots.inject('conversation.input.overlay', () =>
            client.slots.register(
              {
                name: 'conversation.input.overlay',
                id: 'dsh-paste-collapse/pills',
                order: 5,
                locale: NS,
                inject: () => ({ t: translate }),
              },
              PastePills,
            ),
          )
        } catch {
          /* the composer overlay slot is optional */
        }
        try {
          client.slots.inject('shell.overlay', () =>
            client.slots.register(
              {
                name: 'shell.overlay',
                id: 'dsh-paste-collapse/drawer',
                order: 40,
                locale: NS,
                inject: () => ({ t: translate }),
              },
              PasteDrawer,
            ),
          )
        } catch {
          /* the shell overlay slot is optional */
        }
        try {
          // The text of a user message: the host renders it with the `text`
          // key of this slot. A smaller priority wins the cell, so this
          // renderer takes the seat and shows the collapsed pastes as pills.
          client.slots.inject('conversation.user.text.node', function* () {
            yield client.slots.register(
              {
                name: 'conversation.user.text.node',
                key: 'text',
                priority: 50,
                locale: NS,
                inject: () => ({ t: translate }),
              },
              PasteAwareText,
            )
          })
        } catch {
          /* the user text slot is optional */
        }
        setConnection(resolveHandle(client.connection))
      })
      ctx.inject(['connection'], (rpc) => {
        setConnection(resolveHandle(rpc))
      })
    }

    return { inject: ['slots', 'locale', 'connection'], apply }
  },
})

})()
