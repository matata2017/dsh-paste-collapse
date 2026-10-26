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

Every collapsed paste gets a pill on the top edge of the composer:

* the first line of the pasted text, cut to 16 characters
* the number of characters, shortened (`6.7k` instead of `6684`)
* click it to open the full text in a side panel

The side panel is the drawer Codex and WorkBuddy use: the whole text, the
character count, a copy button and a close button. `Esc` or a click outside
closes it.

The pill uses the DSH native colours (CSS variables only, no hard coded hex),
so it follows the light and the dark theme.

## The sent message shows a pill

The turn you already sent shows the collapsed paste as a pill as well, instead
of a wall of text: the bubble renders the pasted text as a small chip with the
preview and the character count, and clicking it opens the same side panel
with the whole text.

The bubble asks the client first and the host second, so a message still shows
its pill after the client lost its copy (after a restart, for example). When
neither of them has the text any more, the message simply shows the plain
text.

### Two things worth knowing about the pill in a message

**The bubble carries the expanded text, not the placeholder.** The host swaps
the placeholder back for the full text in `agent/pre-step`, and that expanded
text is what the session stores and what the bubble shows. The pill is
therefore found by looking for *the pasted text the client remembers* inside
the message. When neither the client nor the host holds that text any more —
after a host restart, for example — the message falls back to the plain text.

**The slot is won, not negotiated.** The host renders the text of a user
message with the `text` key of the `conversation.user.text.node` slot, and
this plugin takes that seat. In the browser the priority is allocated by the
`cordis-client-runner` facade (`guard.ts`, `allocatePriority()`), and a plugin
half that registers later naturally gets the lower priority — so it wins over
the host's 100. The `priority: 50` this plugin passes explicitly only really
takes effect on the static bundled path. Both paths win, but that is a
precondition, not a coincidence: do not rely on being able to reorder the
registrations.

## Install

```bash
# in the DSH profile
dsh plugin --profile desktop add github:matata2017/dsh-paste-collapse
```

Use the `github:` form: this plugin is not published to npm, and the name
`dsh-paste-collapse` on npm belongs to a different author's package.

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
* **A paste is only collapsed when the host answers.** The host is asked twice
  and every attempt waits up to 5 seconds, so the paste waits at most 10
  seconds. When the host still does not answer, the text is inserted as it
  is — the paste is never lost.
* **A placeholder the user deletes is dropped.** The client tells the host, and
  the host forgets the text once the turn has had its chance to use it — so
  the next paste of the same size starts at the bare placeholder again.
* **A submitted turn keeps its text.** The composer clears the draft when the
  turn is sent, and the expansion on the host runs after that. The text
  therefore survives the clear: the model reads the full text, not the
  placeholder.
* **The texts are forgotten one by one.** The host keeps the 50 newest texts
  it delivered and the client keeps the 100 newest texts it sent; the two
  limits are independent. Older ones are dropped, and the message that held
  one falls back to the plain text.

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
node test/run-tests.mjs      # 66 checks: the marker rules and the client bundle
node selftest/host-e2e.mjs   # 24 checks: the host plugin end to end
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
