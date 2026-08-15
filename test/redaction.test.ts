import { deepEqual, equal, ok } from 'node:assert/strict'
import { test } from 'node:test'
import {
  compactBlocksForSection,
  listCompactBlocks,
  listEntries,
  removeCompactBlock,
  removeEntry,
} from '../src/redaction.ts'
import { COMPACT_DAY_FILE, COMPACT_ONLY_FILE, DAY_FILE } from './fixtures.ts'

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

test('a level-1 title above the sessions is never removed', () => {
  const content = '# 2026-08-13\n\n## Session 09:00\n\n### 09:00\n- first\n\n### 09:30\n- second\n'
  const target = listEntries(content).find((entry) => entry.time === '09:30')
  ok(target)

  const remaining = removeEntry(content, target)

  equal(remaining, '# 2026-08-13\n\n## Session 09:00\n\n### 09:00\n- first\n')
})

test('a session heading with freeform content under it is kept', () => {
  const content = '\n## Session 09:00\n\n- handwritten note\n\n### 09:12\n- a real entry\n'
  const target = listEntries(content)[0]
  ok(target)

  const remaining = removeEntry(content, target)

  equal(remaining, '\n## Session 09:00\n\n- handwritten note\n')
})

test('listCompactBlocks finds every compact block with its line range', () => {
  const blocks = listCompactBlocks(COMPACT_DAY_FILE)

  deepEqual(blocks.map((block) => block.start), [9, 18])
  deepEqual(blocks.map((block) => block.end), [17, 21])
})

test('a compact block spans its heading through summary sub-headings, without trailing blanks', () => {
  const blocks = listCompactBlocks(COMPACT_DAY_FILE)

  equal(
    blocks[0]?.text,
    '## Memory Compact\n\n### Decisions\n- redis owns the hot cache\n\n### Fixes\n- login redirect resolved',
  )
  equal(blocks[1]?.text, '## Memory Compact\n\n- second pass: dropped duplicate notes')
})

test('a file without compact blocks has none', () => {
  deepEqual(listCompactBlocks(DAY_FILE), [])
})

test('a compact block ends at the next session heading', () => {
  const content = '\n## Memory Compact\n\n- condensed\n\n## Session 09:00\n\n### 09:00\n- entry\n'

  const blocks = listCompactBlocks(content)

  deepEqual(blocks.map((block) => [block.start, block.end]), [[2, 5]])
  equal(blocks[0]?.text, '## Memory Compact\n\n- condensed')
})

test('a same-session entry appended after a compact block is not part of the block', () => {
  const content =
    '\n## Session 09:00\n\n### 09:00\n<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->\n- before compact\n\n\n## Memory Compact\n\n- condensed\n\n### 09:30\n<!-- session:s1 turn:t2 transcript:/tmp/a.jsonl -->\n- after compact\n\n'

  const blocks = listCompactBlocks(content)
  deepEqual(blocks.map((block) => [block.start, block.end]), [[9, 12]])
  equal(blocks[0]?.text, '## Memory Compact\n\n- condensed')
  const target = blocks[0]
  ok(target)

  const remaining = removeCompactBlock(content, target)

  ok(remaining.includes('- after compact'))
  ok(!remaining.includes('- condensed'))
})

test('a section window inside a summary sub-heading resolves to its enclosing block', () => {
  const blocks = compactBlocksForSection(COMPACT_DAY_FILE, { end_line: 15, heading: 'Fixes', start_line: 14 })

  deepEqual(blocks.map((block) => block.start), [9])
})

test('a section window covering a whole block resolves to that block alone', () => {
  const blocks = compactBlocksForSection(COMPACT_DAY_FILE, { end_line: 17, heading: 'Memory Compact', start_line: 9 })

  deepEqual(blocks.map((block) => block.start), [9])
})

test('a padded window reaching into a neighboring entry still resolves to one block', () => {
  const blocks = compactBlocksForSection(COMPACT_DAY_FILE, { end_line: 12, heading: 'Memory Compact', start_line: 6 })

  deepEqual(blocks.map((block) => block.start), [9])
})

test('a window spanning two compact blocks returns both', () => {
  const blocks = compactBlocksForSection(COMPACT_DAY_FILE, { end_line: 19, heading: 'Memory Compact', start_line: 15 })

  deepEqual(blocks.map((block) => block.start), [9, 18])
})

test('a window over plain entries resolves to no block', () => {
  deepEqual(compactBlocksForSection(COMPACT_DAY_FILE, { end_line: 6, heading: '22:41', start_line: 2 }), [])
})

test('removeCompactBlock removes exactly the addressed block and keeps the rest', () => {
  const blocks = listCompactBlocks(COMPACT_DAY_FILE)
  const first = blocks[0]
  ok(first)

  const remaining = removeCompactBlock(COMPACT_DAY_FILE, first)

  equal(
    remaining,
    `
## Session 22:41

### 22:41
<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->
- decided to use redis for the hot cache


## Memory Compact

- second pass: dropped duplicate notes
`,
  )
})

test('removing the later of two compact blocks keeps the earlier one', () => {
  const blocks = listCompactBlocks(COMPACT_DAY_FILE)
  const second = blocks[1]
  ok(second)

  const remaining = removeCompactBlock(COMPACT_DAY_FILE, second)

  ok(remaining.includes('- redis owns the hot cache'))
  ok(!remaining.includes('- second pass: dropped duplicate notes'))
  ok(remaining.includes('- decided to use redis for the hot cache'))
})

test('removing the only block of a title-only file leaves an empty store', () => {
  const target = listCompactBlocks(COMPACT_ONLY_FILE)[0]
  ok(target)

  equal(removeCompactBlock(COMPACT_ONLY_FILE, target), '')
})

test('removing a block from a file with real entries keeps its date title', () => {
  const content = '# 2026-08-13\n\n## Session 09:00\n\n### 09:00\n- entry\n\n\n## Memory Compact\n\n- condensed\n'
  const target = listCompactBlocks(content)[0]
  ok(target)

  const remaining = removeCompactBlock(content, target)

  equal(remaining, '# 2026-08-13\n\n## Session 09:00\n\n### 09:00\n- entry\n\n')
})
