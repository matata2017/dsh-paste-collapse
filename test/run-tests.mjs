/**
 * dsh-paste-collapse — unit tests.
 *
 * The first section covers the pure helpers in lib/marker.js (SPEC §5.1),
 * the second section runs the client bundle test (SPEC §5.2).
 *
 * Run it with: node test/run-tests.mjs
 */

import { PASTE_THRESHOLD, nextPlaceholder, expandPlaceholders, previewText } from '../lib/marker.js'
import { runClientBundleCheck } from './client-bundle.mjs'

let currentSection = ''
const results = []

function section(name) {
  currentSection = name
  console.log(`\n${name}`)
}

function record(status, name, detail) {
  results.push({ section: currentSection, status, name, detail })
  if (status === 'passed') {
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function test(name, fn) {
  try {
    const result = fn()
    if (result === false) {
      record('failed', name, 'returned false')
      return
    }
    record('passed', name)
  } catch (error) {
    record('failed', name, error?.message ?? String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/* ------------------------------------------------------------------ *
 * 1. lib/marker.js
 * ------------------------------------------------------------------ */

section('lib/marker.js — the threshold')

test('the paste threshold is 1000 characters (Codex: LARGE_PASTE_CHAR_THRESHOLD)', () => {
  assertEqual(PASTE_THRESHOLD, 1000)
})

section('lib/marker.js — nextPlaceholder')

test('the first paste of a size gets the bare placeholder', () => {
  assertEqual(nextPlaceholder({ charCount: 2000, pending: [] }), '[Pasted Content 2000 chars]')
})

test('a second paste of the same size gets #2', () => {
  const pending = [["[Pasted Content 2000 chars]", 'first']]
  assertEqual(nextPlaceholder({ charCount: 2000, pending }), '[Pasted Content 2000 chars] #2')
})

test('a third paste of the same size gets #3', () => {
  const pending = [
    ['[Pasted Content 2000 chars]', 'first'],
    ['[Pasted Content 2000 chars] #2', 'second'],
  ]
  assertEqual(nextPlaceholder({ charCount: 2000, pending }), '[Pasted Content 2000 chars] #3')
})

test('a gap in the numbering is filled with the highest suffix plus one', () => {
  const pending = [['[Pasted Content 2000 chars] #5', 'fifth']]
  assertEqual(nextPlaceholder({ charCount: 2000, pending }), '[Pasted Content 2000 chars] #6')
})

test('every size counts on its own', () => {
  const pending = [['[Pasted Content 2000 chars]', 'first']]
  assertEqual(nextPlaceholder({ charCount: 3000, pending }), '[Pasted Content 3000 chars]')
})

test('an unordered pending list still gives the highest suffix plus one', () => {
  const pending = [
    ['[Pasted Content 2000 chars] #3', 'third'],
    ['[Pasted Content 2000 chars]', 'first'],
    ['[Pasted Content 2000 chars] #2', 'second'],
  ]
  assertEqual(nextPlaceholder({ charCount: 2000, pending }), '[Pasted Content 2000 chars] #4')
})

test('a suffix that is not a number is ignored', () => {
  const pending = [['[Pasted Content 2000 chars] #x', 'weird']]
  assertEqual(nextPlaceholder({ charCount: 2000, pending }), '[Pasted Content 2000 chars]')
})

test('a missing pending list is the same as an empty one', () => {
  assertEqual(nextPlaceholder({ charCount: 1200 }), '[Pasted Content 1200 chars]')
})

section('lib/marker.js — expandPlaceholders')

test('one occurrence is replaced by the full text', () => {
  const pending = [["[Pasted Content 2000 chars]", 'the full text']]
  const result = expandPlaceholders('before [Pasted Content 2000 chars] after', pending)
  assertEqual(result.text, 'before the full text after')
})

test('the same placeholder twice is expanded in order (FIFO)', () => {
  const pending = [
    ['[Pasted Content 2000 chars]', 'first'],
    ['[Pasted Content 2000 chars]', 'second'],
  ]
  const result = expandPlaceholders('[Pasted Content 2000 chars] and [Pasted Content 2000 chars]', pending)
  assertEqual(result.text, 'first and second')
})

test('a placeholder without a text is kept as it is', () => {
  const pending = [['[Pasted Content 2000 chars]', 'first']]
  const result = expandPlaceholders('[Pasted Content 2000 chars] and [Pasted Content 2000 chars]', pending)
  assertEqual(result.text, 'first and [Pasted Content 2000 chars]')
})

test('a hand written placeholder of another size is kept as it is', () => {
  const pending = [['[Pasted Content 2000 chars]', 'first']]
  const result = expandPlaceholders('[Pasted Content 999 chars]', pending)
  assertEqual(result.text, '[Pasted Content 999 chars]')
})

test('text without a placeholder is not touched', () => {
  const pending = [['[Pasted Content 2000 chars]', 'first']]
  const result = expandPlaceholders('nothing to see here', pending)
  assertEqual(result.text, 'nothing to see here')
})

test('the used entries are reported', () => {
  const pending = [
    ['[Pasted Content 2000 chars]', 'first'],
    ['[Pasted Content 3000 chars]', 'second'],
  ]
  const result = expandPlaceholders('[Pasted Content 3000 chars] [Pasted Content 2000 chars]', pending)
  assertEqual(result.text, 'second first')
  assertEqual(JSON.stringify(result.used), JSON.stringify([1, 0]))
})

test('the longer placeholder wins over the bare one', () => {
  const pending = [
    ['[Pasted Content 2000 chars]', 'bare'],
    ['[Pasted Content 2000 chars] #2', 'numbered'],
  ]
  const result = expandPlaceholders('[Pasted Content 2000 chars] #2', pending)
  assertEqual(result.text, 'numbered')
})

section('lib/marker.js — previewText')

test('a short text is returned as it is', () => {
  assertEqual(previewText('short'), 'short')
})

test('a long text is cut and gets an ellipsis', () => {
  const preview = previewText('x'.repeat(40))
  assertEqual(preview, `${'x'.repeat(24)}…`)
})

test('only the first line is used', () => {
  assertEqual(previewText('first line\nsecond line'), 'first line')
})

test('an empty text gives an empty preview', () => {
  assertEqual(previewText(''), '')
})

/* ------------------------------------------------------------------ *
 * 2. the client bundle
 * ------------------------------------------------------------------ */

section('client.js — the composer')

const clientItems = await runClientBundleCheck()
for (const entry of clientItems) {
  // The client bundle groups its own checks; a new group starts a new section.
  if (entry.section && entry.section !== currentSection) section(entry.section)
  record(entry.status, entry.name, entry.detail)
}

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

const passed = results.filter((entry) => entry.status === 'passed').length
const failed = results.filter((entry) => entry.status === 'failed')
const skipped = results.filter((entry) => entry.status === 'skipped')

console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`)
if (failed.length > 0) {
  for (const entry of failed) {
    console.log(`  FAIL ${entry.section} › ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  process.exit(1)
}
