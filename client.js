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
    /** How long the host may take before the paste is inserted uncollapsed. */
    const HOST_TIMEOUT_MS = 1500

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
      lost: 'text lost',
      expand: 'show the full text',
      collapse: 'collapse',
    }

    const zh = {
      meta: {
        title: '粘贴折叠',
        description: '大段粘贴折叠成 Codex 同款占位符，模型看到之前换回全文。',
      },
      count: '{count} 字符',
      lost: '原文已丢失',
      expand: '展开全文',
      collapse: '收起',
    }

    /* ---------------- styles ---------------- */

    const STYLE = [
      '.__dpc_root{display:flex;gap:8px;flex-wrap:wrap}',
      '.__dpc_item{display:flex;flex-direction:column;gap:4px;max-width:320px}',
      '.__dpc_pill{display:inline-flex;align-items:center;gap:6px;max-width:320px;padding:4px 10px;border-radius:var(--dsw-radius-sm,8px);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-business-tertiary,color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent));color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-secondary));font-size:12px;line-height:16px;font-family:inherit;cursor:pointer;text-align:left}',
      '.__dpc_pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.__dpc_pill:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.__dpc_icon{display:inline-flex;align-items:center;color:var(--dsw-alias-state-business-primary)}',
      '.__dpc_preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.__dpc_count{color:var(--dsw-alias-label-tertiary);flex:none}',
      '.__dpc_lost{color:var(--dsw-alias-state-error-primary);flex:none}',
      '.__dpc_panel{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:8px;max-height:240px;overflow:auto;white-space:pre-wrap;font-size:12px}',
    ]

    /* ---------------- connection ---------------- */

    let connection = null
    let translate = (key) => key

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

    /* ---------------- the pill row ---------------- */

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
        bump((value) => value + 1)
        // Tell the host the paste is gone, so it does not expand a
        // placeholder the user deleted.
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
          const value = await callWithTimeout('remember', { placeholder, text }, HOST_TIMEOUT_MS)
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
          { placeholder, chars: text.length, text, expanded: false, lost: false, checked: false },
        ]
        bump((value) => value + 1)
      }

      function toggle(placeholder) {
        entriesRef.current = entriesRef.current.map((entry) =>
          entry.placeholder === placeholder ? { ...entry, expanded: !entry.expanded } : entry,
        )
        bump((value) => value + 1)
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
                onClick: () => toggle(entry.placeholder),
                title: entry.expanded ? translate('collapse') : translate('expand'),
                'aria-expanded': entry.expanded ? 'true' : 'false',
              },
              h(
                'span',
                { className: '__dpc_icon' },
                h(
                  'svg',
                  {
                    width: 12,
                    height: 12,
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.6,
                    strokeLinecap: 'round',
                  },
                  h('path', { d: 'M3 4h10M8 4v9' }),
                ),
              ),
              h('span', { className: '__dpc_preview' }, previewText(entry.text)),
              h('span', { className: '__dpc_count' }, format(translate('count'), { count: entry.chars })),
              entry.lost ? h('span', { className: '__dpc_lost' }, translate('lost')) : null,
            ),
            entry.expanded ? h('div', { className: '__dpc_panel' }, entry.text) : null,
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
        setConnection(resolveHandle(client.connection))
      })
      ctx.inject(['connection'], (rpc) => {
        setConnection(resolveHandle(rpc))
      })
    }

    return { inject: ['slots', 'locale', 'connection'], apply }
  },
})
