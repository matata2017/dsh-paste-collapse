# VERIFY — dsh-paste-collapse

The acceptance checklist of the plugin. Everything in the first three sections
runs without a browser and without a DSH installation.

## 1. Syntax

```bash
node --check lib/marker.js
node --check lib/index.js
node --check client.js
node --check test/run-tests.mjs
node --check test/client-bundle.mjs
node --check selftest/host-e2e.mjs
```

All six commands must exit 0.

## 2. Unit tests

```bash
node test/run-tests.mjs
```

Expected: `38 passed, 0 failed, 0 skipped` (the checklist asks for at least 12
checks). The run covers:

| Section | Checks |
|---|---|
| the threshold | `PASTE_THRESHOLD === 1000` |
| `nextPlaceholder` | first paste, `#2`, `#3`, a gap (`#5` → `#6`), per size counters, an unordered pending list, a suffix that is not a number, a missing pending list |
| `expandPlaceholders` | one occurrence, FIFO for a repeated placeholder, a placeholder without a text, a hand written placeholder of another size, untouched text, the reported `used` indexes, the longer placeholder wins |
| `previewText` | a short text, a cut text with an ellipsis, only the first line, an empty text |
| the client bundle | the paste is intercepted, the placeholder is inserted, the host is told, the pill shows the preview and the count, the second paste gets `#2`, a short paste is left alone, the listener is removed on unmount, a failing host keeps the text, a slow host keeps the text, a deleted placeholder drops the pill |

## 3. Host self test

```bash
node selftest/host-e2e.mjs
```

Expected: `17 passed, 0 failed` (the checklist asks for at least 3 checks).
`DSH_HOME` points at a temporary directory, and the last check proves that the
plugin wrote nothing at all.

## 4. Manual acceptance in the DSH client

Install the plugin into a profile (for example the desktop profile) and start
the web UI.

1. **Paste more than 1000 characters.** The composer must not break, a pill
   appears above the input, and the draft contains `[Pasted Content N chars]`
   instead of the pasted text.
2. **Open the pill.** Clicking it shows the full pasted text, clicking it again
   hides it.
3. **Paste the same size again.** The second pill and the placeholder
   `[Pasted Content N chars] #2` appear.
4. **Paste less than 1000 characters.** Nothing is collapsed, the text is
   inserted as it is.
5. **Send the turn.** The model receives the full pasted text, not the
   placeholder.
6. **Delete the placeholder** and paste the same size again: the bare
   placeholder is used again.
7. **Restart the host** and send a turn that still holds a placeholder: the
   placeholder is sent as it is, and the pill is marked as *text lost*.

## 5. The documentation

`README.md` and `README.zh.md` both state:

* the threshold is 1000 characters, aligned with Codex
* the pill can be opened to see the full text
* after a host restart the text is lost and the placeholder is sent as it is
* the plugin saves no tokens
