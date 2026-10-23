# dsh-paste-collapse

Collapse a large paste in the DeepSeek Harness composer into a Codex style
placeholder, show a pill for it, and expand it back to the full text on the
host right before the model reads the turn.

The model still sees every character you pasted. Nothing is written to disk and
no tokens are saved — the placeholder is a display convenience, not a
compression.

```
you paste 12 000 characters
        │
        ▼
the composer shows   [Pasted Content 12000 chars]   and a pill with a preview
        │
        ▼  you press send
the host swaps the placeholder for the original text
        │
        ▼
the model reads the full 12 000 characters
```

## The rules (the same ones Codex uses)

| | |
|---|---|
| Threshold | 1000 characters (`LARGE_PASTE_CHAR_THRESHOLD` in Codex) |
| Placeholder | `[Pasted Content 12000 chars]` |
| A second paste of the same size | `[Pasted Content 12000 chars] #2`, then `#3`, … |
| The counter | per size: a 3000 character paste starts its own sequence |
| Expansion | FIFO: the first occurrence of a placeholder gets the first text |
| A placeholder without a text | left alone, sent to the model as it is |

The placeholder text, the numbering and the FIFO expansion are a port of
Codex (`codex-rs/tui/src/bottom_pane/chat_composer.rs`): `next_large_paste_placeholder`
and `expand_pending_pastes`.

## The pill

Every collapsed paste gets a pill above the composer:

* the first line of the pasted text, cut to 24 characters
* the number of characters
* click it to open the full text in a panel, click it again to close it

The pill uses the DSH native colours (CSS variables only, no hard coded hex),
so it follows the light and the dark theme.

## Install

```bash
# in the DSH profile
dsh plugin add dsh-paste-collapse
```

or link a checkout:

```json
{
  "dependencies": {
    "dsh-paste-collapse": "link:D:\\work\\huanghao\\dsh-paste-collapse"
  }
}
```

The plugin has two halves: the host half (`lib/index.js`) and the client half
(`client.js`). The client half is what turns the paste into a placeholder, the
host half is what expands it again.

## Limits

* **The text only lives in memory.** The host keeps the pasted texts in a
  plain array. Nothing is written to disk, nothing is uploaded, and the texts
  are gone when the host process ends.
* **After a host restart the text is lost.** The placeholder stays in the
  composer, but the host no longer knows the text, so the placeholder is sent
  to the model as it is. The pill marks this state as *text lost*.
* **No token saving.** The model reads the full text, exactly as if you had
  pasted it directly. The plugin only makes the composer readable.
* **A paste is only collapsed when the host answers.** If the host call fails
  or takes longer than 1.5 seconds, the text is inserted as it is — the paste
  is never lost.
* **A placeholder the user deletes is dropped.** Both the client and the host
  forget the text, and the next paste of the same size starts at the bare
  placeholder again.

## Differences from Codex

Only two:

1. **When the expansion happens.** Codex expands the placeholder in the
   composer, DSH expands it on the host in `agent/pre-step`, right before the
   model reads the turn.
2. **How the placeholder looks.** Codex shows plain text, DSH shows the same
   placeholder plus a pill.

## Tests

```bash
node --check lib/marker.js
node --check lib/index.js
node --check client.js
node test/run-tests.mjs      # 38 checks: the marker rules and the client bundle
node selftest/host-e2e.mjs   # 17 checks: the host plugin end to end
```

`test/client-bundle.mjs` runs `client.js` inside a fake window with a fake
React and a fake DOM, so the composer behaviour is tested without a browser.
`selftest/host-e2e.mjs` runs the host plugin against a fake Cordis context and
uses a temporary `DSH_HOME`.

See [VERIFY.md](./VERIFY.md) for the full acceptance checklist.

## License

MIT

## A note on top-level names

The browser loader concatenates every installed plugin client bundle into one script, so a top-level `const` belongs to all plugins. This file runs inside its own function for that reason: two plugins declaring the same top-level name is a syntax error that stops the app from booting.
