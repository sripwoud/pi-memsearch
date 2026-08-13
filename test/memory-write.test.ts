import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { equal, ok, rejects } from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemsearchExtension } from '../src/extension.ts'
import { createFakeContext, createFakePi, type FakeSession } from './harness.ts'

const TRANSCRIPT = '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl'

const SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: TRANSCRIPT,
}

function setup(options: { clock?: () => Date; env?: NodeJS.ProcessEnv; session?: FakeSession } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-write-'))
  mkdirSync(join(root, '.git'))
  const cwd = join(root, 'packages', 'core')
  mkdirSync(cwd, { recursive: true })

  const { pi, tools } = createFakePi()
  const clock = options.clock ?? (() => new Date(2026, 7, 13, 22, 41))
  createMemsearchExtension({ env: options.env ?? {}, now: clock })(pi)

  const tool = tools.get('memory_write')
  ok(tool, 'memory_write tool is registered')
  const ctx = createFakeContext({ cwd, session: options.session ?? SESSION })
  return { ctx, root, tool }
}

async function write(tool: ToolDefinition, ctx: ExtensionContext, content: string) {
  return tool.execute('call-1', { content }, undefined, undefined, ctx)
}

test('first write creates the daily file with session heading, anchor and content', async () => {
  const { ctx, root, tool } = setup()

  const result = await write(tool, ctx, '- decided to adopt TDD for the write path')

  const file = join(root, '.memsearch', 'memory', '2026-08-13.md')
  equal(
    readFileSync(file, 'utf8'),
    `\n## Session 22:41\n\n### 22:41\n<!-- session:${SESSION.sessionId} turn:ab12cd34 transcript:${TRANSCRIPT} -->\n- decided to adopt TDD for the write path\n\n`,
  )
  const first = result.content[0]
  ok(first?.type === 'text' && first.text.includes(file))
})

test('later writes in the same session reuse its heading', async () => {
  let minutes = 41
  const { ctx, root, tool } = setup({ clock: () => new Date(2026, 7, 13, 22, minutes) })

  await write(tool, ctx, '- first entry')
  minutes = 55
  await write(tool, ctx, '- second entry')

  const content = readFileSync(join(root, '.memsearch', 'memory', '2026-08-13.md'), 'utf8')
  equal(content.match(/^## Session /gm)?.length, 1)
  ok(
    content.endsWith(
      `### 22:55\n<!-- session:${SESSION.sessionId} turn:ab12cd34 transcript:${TRANSCRIPT} -->\n- second entry\n\n`,
    ),
  )
})

test('a different session gets its own heading in the same daily file', async () => {
  const { ctx, root, tool } = setup()
  await write(tool, ctx, '- first session entry')

  const other = createFakeContext({
    cwd: ctx.cwd,
    session: { ...SESSION, sessionId: '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a' },
  })
  await write(tool, other, '- second session entry')

  const content = readFileSync(join(root, '.memsearch', 'memory', '2026-08-13.md'), 'utf8')
  equal(content.match(/^## Session /gm)?.length, 2)
})

test('day rollover starts a new daily file with a fresh session heading', async () => {
  let day = 13
  const { ctx, root, tool } = setup({ clock: () => new Date(2026, 7, day, 23, 59) })

  await write(tool, ctx, '- before midnight')
  day = 14
  await write(tool, ctx, '- after midnight')

  const content = readFileSync(join(root, '.memsearch', 'memory', '2026-08-14.md'), 'utf8')
  ok(content.startsWith('\n## Session 23:59\n'))
})

test('MEMSEARCH_DIR routes writes to its own memory dir', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'memory-shared-'))
  const { ctx, tool } = setup({ env: { MEMSEARCH_DIR: shared } })

  await write(tool, ctx, '- global scope entry')

  ok(existsSync(join(shared, 'memory', '2026-08-13.md')))
})

test('a session without a transcript file is rejected instead of writing a broken anchor', async () => {
  const { ctx, root, tool } = setup({ session: { ...SESSION, transcriptPath: undefined } })

  await rejects(() => write(tool, ctx, '- lost entry'), /persisted session/)

  ok(!existsSync(join(root, '.memsearch', 'memory', '2026-08-13.md')))
})
