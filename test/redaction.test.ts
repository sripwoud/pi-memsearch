import { deepEqual, equal, ok } from 'node:assert/strict'
import { test } from 'node:test'
import { listEntries, removeEntry } from '../src/redaction.ts'

const DAY_FILE = `
## Session 22:41

### 22:41
<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->
- decided to use redis for the hot cache

### 22:55
<!-- session:s1 turn:t2 transcript:/tmp/a.jsonl -->
- dropped the varnish layer


## Session 23:10

### 23:10
<!-- session:s2 turn:t3 transcript:/tmp/b.jsonl -->
- fixed the login redirect bug

`

test('listEntries finds every timestamp entry with its line range', () => {
  const entries = listEntries(DAY_FILE)

  deepEqual(entries.map((entry) => entry.time), ['22:41', '22:55', '23:10'])
  deepEqual(entries.map((entry) => entry.start), [4, 8, 15])
  deepEqual(entries.map((entry) => entry.end), [7, 12, 19])
})

test('an entry text is the heading, anchor and bullets without trailing blanks', () => {
  const entries = listEntries(DAY_FILE)

  equal(
    entries[0]?.text,
    '### 22:41\n<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->\n- decided to use redis for the hot cache',
  )
})

test('level-3 headings that are not timestamps are not entries', () => {
  const entries = listEntries('\n## Session 09:00\n\n### notes\n- freeform\n\n### 09:12\n- a real entry\n')

  deepEqual(entries.map((entry) => entry.time), ['09:12'])
})

test('a file without headings has no entries', () => {
  deepEqual(listEntries('- decided today\n'), [])
})

test('entries sharing a time across sessions are all listed', () => {
  const content = '\n## Session 09:00\n\n### 09:00\n- first\n\n\n## Session 09:30\n\n### 09:00\n- second\n\n'

  deepEqual(listEntries(content).map((entry) => entry.time), ['09:00', '09:00'])
})

test('removeEntry removes exactly the addressed entry and keeps its session heading', () => {
  const entries = listEntries(DAY_FILE)
  const target = entries[1]
  equal(target?.time, '22:55')

  const remaining = removeEntry(DAY_FILE, target)

  equal(
    remaining,
    `
## Session 22:41

### 22:41
<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->
- decided to use redis for the hot cache

## Session 23:10

### 23:10
<!-- session:s2 turn:t3 transcript:/tmp/b.jsonl -->
- fixed the login redirect bug

`,
  )
})

test('removing the sole entry of a session removes its session heading', () => {
  const entries = listEntries(DAY_FILE)
  const target = entries[2]
  equal(target?.time, '23:10')

  const remaining = removeEntry(DAY_FILE, target)

  equal(
    remaining,
    `
## Session 22:41

### 22:41
<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->
- decided to use redis for the hot cache

### 22:55
<!-- session:s1 turn:t2 transcript:/tmp/a.jsonl -->
- dropped the varnish layer

`,
  )
})

test('removing the last entry leaves an empty store', () => {
  const content =
    '\n## Session 22:41\n\n### 22:41\n<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->\n- only entry\n\n'
  const target = listEntries(content)[0]
  ok(target)

  equal(removeEntry(content, target), '')
})

test('removing every entry one by one drains the file to empty', () => {
  let content = DAY_FILE
  for (let round = 0; round < 3; round++) {
    const target = listEntries(content)[0]
    ok(target)
    content = removeEntry(content, target)
  }

  equal(content, '')
})

test('a session heading with freeform content under it is kept', () => {
  const content = '\n## Session 09:00\n\n- handwritten note\n\n### 09:12\n- a real entry\n'
  const target = listEntries(content)[0]
  ok(target)

  const remaining = removeEntry(content, target)

  equal(remaining, '\n## Session 09:00\n\n- handwritten note\n')
})
