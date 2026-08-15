import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, notEqual, ok, rejects } from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { deriveCollection } from '../src/scope.ts'
import {
  COMPACT_DAY_FILE,
  COMPACT_ONLY_FILE,
  DAY_FILE,
  enoentError,
  INDEXED_STDOUT,
  okResult,
  VERSION_STDOUT,
} from './fixtures.ts'
import { type FakeExecStep, prompt, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[]) {
  const harness = setupExtension(steps, { prefix: 'memory-forget-' })
  const memoryDir = join(harness.root, '.memsearch', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const tool = harness.tools.get('memory_forget')
  ok(tool, 'memory_forget tool is registered')
  return { ...harness, memoryDir, tool }
}

function seedDayFile(memoryDir: string, date = '2026-08-13', content = DAY_FILE): string {
  const file = join(memoryDir, `${date}.md`)
  writeFileSync(file, content)
  return file
}

async function forget(tool: ToolDefinition, ctx: ExtensionContext, params: object) {
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return { details: result.details as { file: string; removed: string }, text: first.text }
}

function expandJson(overrides: {
  anchor?: { session: string; transcript: string; turn: string }
  end_line?: number
  heading?: string
  source: string
  start_line: number
}): string {
  return JSON.stringify({
    ...(overrides.anchor ? { anchor: overrides.anchor } : {}),
    chunk_hash: 'feedface00000000',
    content: '### 22:55\n- dropped the varnish layer',
    end_line: overrides.end_line ?? overrides.start_line + 2,
    heading: overrides.heading ?? '22:55',
    source: overrides.source,
    start_line: overrides.start_line,
  })
}

function lineOf(content: string, line: string): number {
  return content.split('\n').indexOf(line) + 1
}

function lastLineOf(content: string, line: string): number {
  return content.split('\n').lastIndexOf(line) + 1
}

test('date and time remove the matching entry and echo its markdown', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const file = seedDayFile(memoryDir)

  const { details, text } = await forget(tool, ctx, { date: '2026-08-13', time: '22:55' })

  const remaining = readFileSync(file, 'utf8')
  ok(!remaining.includes('- dropped the varnish layer'))
  ok(remaining.includes('- decided to use redis for the hot cache'))
  ok(remaining.includes('- fixed the login redirect bug'))
  ok(text.includes('### 22:55'))
  ok(text.includes('<!-- session:s1 turn:t2 transcript:/tmp/a.jsonl -->'))
  ok(text.includes('- dropped the varnish layer'))
  equal(details.file, file)
})

test('a chunk_hash removes the entry containing the chunk', async () => {
  // Real expand pads the section with context: the window here starts at the previous entry's
  // heading, so resolution must follow the chunk's own heading and anchor, not the window start.
  const { calls, ctx, memoryDir, root, tool } = setup([okResult(VERSION_STDOUT), (call) => {
    const file = join(memoryDir, '2026-08-13.md')
    equal(call.args[call.args.length - 1], 'feedface00000000')
    return Promise.resolve(
      okResult(
        expandJson({
          anchor: { session: 's1', transcript: '/tmp/a.jsonl', turn: 't2' },
          end_line: lineOf(DAY_FILE, '- dropped the varnish layer'),
          source: file,
          start_line: lineOf(DAY_FILE, '### 22:41'),
        }),
      ),
    )
  }])
  const file = seedDayFile(memoryDir)

  const { text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  deepEqual(calls[1]?.args.slice(2), [
    'memsearch',
    'expand',
    '-j',
    '-c',
    deriveCollection(root),
    '--',
    'feedface00000000',
  ])
  const remaining = readFileSync(file, 'utf8')
  ok(!remaining.includes('- dropped the varnish layer'))
  ok(remaining.includes('- decided to use redis for the hot cache'), 'the entry at the window start survived')
  ok(text.includes('- dropped the varnish layer'))
})

test('same-minute entries are told apart by the chunk anchor', async () => {
  const twins = [
    '',
    '## Session 09:00',
    '',
    '### 09:00',
    '<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->',
    '- first twin',
    '',
    '',
    '## Session 09:30',
    '',
    '### 09:00',
    '<!-- session:s2 turn:t9 transcript:/tmp/b.jsonl -->',
    '- second twin',
    '',
    '',
  ]
    .join('\n')
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            anchor: { session: 's2', transcript: '/tmp/b.jsonl', turn: 't9' },
            end_line: twins.split('\n').length,
            heading: '09:00',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: 1,
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', twins)

  await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  const remaining = readFileSync(file, 'utf8')
  ok(remaining.includes('- first twin'))
  ok(!remaining.includes('- second twin'))
})

test('same-minute entries without a distinguishing anchor are rejected as ambiguous', async () => {
  const twins = '\n## Session 09:00\n\n### 09:00\n- first twin\n\n\n## Session 09:30\n\n### 09:00\n- second twin\n\n'
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: twins.split('\n').length,
            heading: '09:00',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: 1,
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', twins)

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /ambiguous/)

  equal(readFileSync(file, 'utf8'), twins)
})

test('a chunk_hash combined with date or time is rejected without mutating', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const file = seedDayFile(memoryDir)

  await rejects(
    () => forget(tool, ctx, { chunk_hash: 'feedface00000000', date: '2026-08-13', time: '22:55' }),
    /exactly one address/,
  )

  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('no address at all is rejected', async () => {
  const { ctx, tool } = setup([])

  await rejects(() => forget(tool, ctx, {}), /exactly one address/)
})

test('date without time, and time without date, are rejected', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const file = seedDayFile(memoryDir)

  await rejects(() => forget(tool, ctx, { date: '2026-08-13' }), /date and time together/)
  await rejects(() => forget(tool, ctx, { time: '22:55' }), /date and time together/)

  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('malformed date or time formats are rejected', async () => {
  const { ctx, memoryDir, tool } = setup([])
  seedDayFile(memoryDir)

  await rejects(() => forget(tool, ctx, { date: 'yesterday', time: '22:55' }), /YYYY-MM-DD/)
  await rejects(() => forget(tool, ctx, { date: '2026-08-13', time: '10pm' }), /HH:MM/)
})

test('a time with no matching entry is rejected without mutating', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const file = seedDayFile(memoryDir)

  await rejects(() => forget(tool, ctx, { date: '2026-08-13', time: '09:12' }), /no memory entry at 09:12/)

  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('a time matching several entries is rejected as ambiguous', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const content = '\n## Session 09:00\n\n### 09:00\n- first\n\n\n## Session 09:30\n\n### 09:00\n- second\n\n'
  const file = seedDayFile(memoryDir, '2026-08-13', content)

  await rejects(() => forget(tool, ctx, { date: '2026-08-13', time: '09:00' }), /ambiguous/)

  equal(readFileSync(file, 'utf8'), content)
})

test('a date with no day file is rejected', async () => {
  const { ctx, tool } = setup([])

  await rejects(() => forget(tool, ctx, { date: '2026-08-12', time: '22:55' }), /no daily memory file for 2026-08-12/)
})

test('a chunk outside the memory store is rejected without mutating', async () => {
  const { ctx, memoryDir, root, tool } = setup([
    okResult(VERSION_STDOUT),
    () => Promise.resolve(okResult(expandJson({ heading: 'Readme', source: join(root, 'README.md'), start_line: 1 }))),
  ])
  const file = seedDayFile(memoryDir)

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /outside the memory store/)

  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('a chunk that does not land inside a memory entry is rejected', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            heading: 'Session 22:41',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(DAY_FILE, '## Session 22:41'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir)

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /does not resolve to a memory entry/)

  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('a chunk whose source file is gone is rejected', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () => Promise.resolve(okResult(expandJson({ source: join(memoryDir, '2026-08-01.md'), start_line: 4 }))),
  ])

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /no longer exists/)
})

test('removing the sole entry deletes the day file', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const content =
    '\n## Session 22:41\n\n### 22:41\n<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->\n- only entry\n\n'
  const file = seedDayFile(memoryDir, '2026-08-13', content)

  const { text } = await forget(tool, ctx, { date: '2026-08-13', time: '22:41' })

  ok(!existsSync(file))
  ok(text.includes('deleted'))
  ok(text.includes('- only entry'))
})

test('removing the last entry of a session removes its session heading', async () => {
  const { ctx, memoryDir, tool } = setup([])
  const file = seedDayFile(memoryDir)

  await forget(tool, ctx, { date: '2026-08-13', time: '23:10' })

  ok(!readFileSync(file, 'utf8').includes('## Session 23:10'))
})

test('memory_forget schedules a debounced background reindex', async () => {
  let notify: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    notify = resolve
  })
  const indexStep: FakeExecStep = async () => {
    notify()
    return okResult(INDEXED_STDOUT)
  }
  const { calls, ctx, memoryDir, tool } = setup([okResult(VERSION_STDOUT), indexStep])
  seedDayFile(memoryDir)

  await forget(tool, ctx, { date: '2026-08-13', time: '22:55' })
  await done

  equal(calls.filter((call) => call.args[3] === 'index').length, 1)
})

test('memory_forget refreshes the stable snapshot immediately', async () => {
  const { ctx, fire, memoryDir, tool } = setup([okResult(VERSION_STDOUT), okResult(INDEXED_STDOUT)])
  seedDayFile(memoryDir)

  const first = await prompt(fire, ctx)
  ok(first?.includes('- dropped the varnish layer'))
  await forget(tool, ctx, { date: '2026-08-13', time: '22:55' })
  const second = await prompt(fire, ctx)

  notEqual(second, first)
  ok(!second?.includes('- dropped the varnish layer'))
  ok(second?.includes('- decided to use redis for the hot cache'))
})

test('missing uv returns install instructions for chunk addressing', async () => {
  const { ctx, memoryDir, tool } = setup([enoentError()])
  const file = seedDayFile(memoryDir)

  const { text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  match(text, /astral\.sh\/uv\/install\.sh/)
  equal(readFileSync(file, 'utf8'), DAY_FILE)
})

test('a chunk_hash inside a compact block removes the whole block', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_DAY_FILE, '- login redirect resolved'),
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_DAY_FILE, '## Memory Compact'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  const { details, text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  const remaining = readFileSync(file, 'utf8')
  ok(!remaining.includes('- redis owns the hot cache'))
  ok(!remaining.includes('### Decisions'))
  ok(remaining.includes('- decided to use redis for the hot cache'), 'entries survive')
  ok(remaining.includes('- second pass: dropped duplicate notes'), 'the other compact block survives')
  ok(text.includes('Memory compact block redacted'))
  ok(text.includes('## Memory Compact'))
  ok(details.removed.includes('- login redirect resolved'))
})

test('a chunk stamped with a summary sub-heading removes its whole compact block', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_DAY_FILE, '- login redirect resolved'),
            heading: 'Fixes',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_DAY_FILE, '### Fixes'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  const { text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  const remaining = readFileSync(file, 'utf8')
  ok(!remaining.includes('### Decisions'), 'the block is removed beyond the stamped sub-section')
  ok(!remaining.includes('- login redirect resolved'))
  ok(remaining.includes('- second pass: dropped duplicate notes'))
  ok(text.includes('### Decisions'))
  ok(text.includes('### Fixes'))
})

test('only the enclosing compact block is removed when several accumulate', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_DAY_FILE, '- second pass: dropped duplicate notes'),
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lastLineOf(COMPACT_DAY_FILE, '## Memory Compact'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  const remaining = readFileSync(file, 'utf8')
  ok(remaining.includes('- redis owns the hot cache'), 'the first compact block survives')
  ok(!remaining.includes('- second pass: dropped duplicate notes'))
})

test('a stale entry chunk overlapping a compact block is rejected without mutating', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_DAY_FILE, '- redis owns the hot cache'),
            heading: '22:55',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_DAY_FILE, '- decided to use redis for the hot cache'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /does not resolve/)

  equal(readFileSync(file, 'utf8'), COMPACT_DAY_FILE)
})

test('a window spanning two compact blocks is rejected as ambiguous', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lastLineOf(COMPACT_DAY_FILE, '## Memory Compact') + 1,
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_DAY_FILE, '### Fixes'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  await rejects(() => forget(tool, ctx, { chunk_hash: 'feedface00000000' }), /ambiguous/)

  equal(readFileSync(file, 'utf8'), COMPACT_DAY_FILE)
})

test('a compact-block forget spares a same-session entry appended after the block', async () => {
  const interleaved =
    '\n## Session 09:00\n\n### 09:00\n<!-- session:s1 turn:t1 transcript:/tmp/a.jsonl -->\n- before compact\n\n\n## Memory Compact\n\n- condensed\n\n### 09:30\n<!-- session:s1 turn:t2 transcript:/tmp/a.jsonl -->\n- after compact\n\n'
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(interleaved, '- after compact'),
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(interleaved, '## Memory Compact'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', interleaved)

  const { text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  const remaining = readFileSync(file, 'utf8')
  ok(remaining.includes('- after compact'), 'the appended entry survives the block forget')
  ok(remaining.includes('- before compact'))
  ok(!remaining.includes('- condensed'))
  ok(!text.includes('- after compact'), 'the echo contains only the block')
})

test('removing the only compact block deletes a file holding just the date title', async () => {
  const { ctx, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_ONLY_FILE, '- the whole store in one line'),
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_ONLY_FILE, '## Memory Compact'),
          }),
        ),
      ),
  ])
  const file = seedDayFile(memoryDir, '2026-08-13', COMPACT_ONLY_FILE)

  const { text } = await forget(tool, ctx, { chunk_hash: 'feedface00000000' })

  ok(!existsSync(file))
  ok(text.includes('deleted'))
  ok(text.includes('- the whole store in one line'))
})

test('a compact-block forget reindexes and refreshes the stable snapshot', async () => {
  let notify: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    notify = resolve
  })
  const indexStep: FakeExecStep = async () => {
    notify()
    return okResult(INDEXED_STDOUT)
  }
  const { calls, ctx, fire, memoryDir, tool } = setup([
    okResult(VERSION_STDOUT),
    () =>
      Promise.resolve(
        okResult(
          expandJson({
            end_line: lineOf(COMPACT_DAY_FILE, '- login redirect resolved'),
            heading: 'Memory Compact',
            source: join(memoryDir, '2026-08-13.md'),
            start_line: lineOf(COMPACT_DAY_FILE, '## Memory Compact'),
          }),
        ),
      ),
    indexStep,
  ])
  seedDayFile(memoryDir, '2026-08-13', COMPACT_DAY_FILE)

  const first = await prompt(fire, ctx)
  ok(first?.includes('- redis owns the hot cache'))
  await forget(tool, ctx, { chunk_hash: 'feedface00000000' })
  const second = await prompt(fire, ctx)
  await done

  ok(!second?.includes('- redis owns the hot cache'))
  ok(second?.includes('- second pass: dropped duplicate notes'))
  equal(calls.filter((call) => call.args[3] === 'index').length, 1)
})

test('no copy of the redacted content survives anywhere under the project root', async () => {
  const { ctx, memoryDir, root, tool } = setup([])
  seedDayFile(memoryDir)

  const { details } = await forget(tool, ctx, { date: '2026-08-13', time: '22:55' })

  ok(details.removed.includes('- dropped the varnish layer'))
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name)
    ok(!readFileSync(path, 'utf8').includes('varnish'), `${path} keeps a copy of the redacted content`)
  }
})
