import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { equal, match, notEqual, ok } from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemsearchExtension } from '../src/extension.ts'
import { createFakeContext, createFakePi, type FakePi, type FakeSession } from './harness.ts'

const BASE_PROMPT = 'You are pi.'

const SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: '/home/user/.pi/agent/sessions/--project--/2026-08-14_abc.jsonl',
}

function setup(options: { clock?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-'))
  mkdirSync(join(root, '.git'))
  const memoryDir = join(root, '.memsearch', 'memory')
  mkdirSync(memoryDir, { recursive: true })

  const { fire, pi, tools } = createFakePi()
  const clock = options.clock ?? (() => new Date(2026, 7, 14, 10, 0))
  createMemsearchExtension({ env: options.env ?? {}, now: clock })(pi)

  const ctx = createFakeContext({ cwd: root, session: SESSION })
  return { ctx, fire, memoryDir, tools }
}

async function startSession(fire: FakePi['fire'], ctx: ExtensionContext) {
  await fire('session_start', { reason: 'startup' }, ctx)
}

async function prompt(fire: FakePi['fire'], ctx: ExtensionContext): Promise<string | undefined> {
  const results = await fire(
    'before_agent_start',
    { prompt: 'hello', systemPrompt: BASE_PROMPT, systemPromptOptions: {} },
    ctx,
  )
  const result = results[0] as { systemPrompt?: string } | undefined
  return result?.systemPrompt
}

function injectedBlock(systemPrompt: string | undefined): string {
  ok(systemPrompt !== undefined, 'before_agent_start returns a system prompt')
  ok(systemPrompt.startsWith(BASE_PROMPT), 'snapshot is appended to the original system prompt')
  return systemPrompt.slice(BASE_PROMPT.length)
}

test('with no daily memory files the snapshot degrades to usage instructions only', async () => {
  const { ctx, fire } = setup()
  await startSession(fire, ctx)

  const block = injectedBlock(await prompt(fire, ctx))

  ok(block.includes('memory_write'), 'instructions tell the model how to write memory')
  ok(!block.includes('### Today'), 'no today section without a daily memory file')
  ok(!block.includes('### Yesterday'), 'no yesterday section without a daily memory file')
  ok(block.length <= 1100, `instructions stay within ~1K chars, got ${block.length}`)
})

test("the snapshot includes the tails of today's and yesterday's daily memory files", async () => {
  const { ctx, fire, memoryDir } = setup()
  writeFileSync(join(memoryDir, '2026-08-14.md'), '- decided today\n')
  writeFileSync(join(memoryDir, '2026-08-13.md'), '- decided yesterday\n')
  await startSession(fire, ctx)

  const block = injectedBlock(await prompt(fire, ctx))

  ok(block.includes('### Today (2026-08-14)'))
  ok(block.includes('- decided today'))
  ok(block.includes('### Yesterday (2026-08-13)'))
  ok(block.includes('- decided yesterday'))
})

test('an empty daily memory file degrades to instructions only', async () => {
  const { ctx, fire, memoryDir } = setup()
  writeFileSync(join(memoryDir, '2026-08-14.md'), '\n\n')
  await startSession(fire, ctx)

  const block = injectedBlock(await prompt(fire, ctx))

  ok(!block.includes('### Today'))
})

test('the snapshot is byte-identical across prompts even when the daily memory file grows', async () => {
  const { ctx, fire, memoryDir } = setup()
  const file = join(memoryDir, '2026-08-14.md')
  writeFileSync(file, '- first entry\n')
  await startSession(fire, ctx)

  const first = await prompt(fire, ctx)
  appendFileSync(file, '- written by another agent\n')
  const second = await prompt(fire, ctx)

  equal(second, first)
  ok(!second?.includes('written by another agent'))
})

test('memory_write does not refresh the snapshot', async () => {
  const { ctx, fire, memoryDir, tools } = setup()
  writeFileSync(join(memoryDir, '2026-08-14.md'), '- first entry\n')
  await startSession(fire, ctx)

  const first = await prompt(fire, ctx)
  const tool = tools.get('memory_write')
  ok(tool)
  await tool.execute('call-1', { content: '- deliberate write' }, undefined, undefined, ctx)
  const second = await prompt(fire, ctx)

  equal(second, first)
  ok(!second?.includes('deliberate write'))
})

test('compaction refreshes the snapshot', async () => {
  const { ctx, fire, memoryDir } = setup()
  const file = join(memoryDir, '2026-08-14.md')
  writeFileSync(file, '- first entry\n')
  await startSession(fire, ctx)

  const first = await prompt(fire, ctx)
  appendFileSync(file, '- post-compaction entry\n')
  await fire('session_compact', { reason: 'threshold' }, ctx)
  const second = await prompt(fire, ctx)

  notEqual(second, first)
  ok(second?.includes('- post-compaction entry'))
})

test('day rollover refreshes the snapshot on the next prompt', async () => {
  let day = 14
  const { ctx, fire, memoryDir } = setup({ clock: () => new Date(2026, 7, day, 10, 0) })
  writeFileSync(join(memoryDir, '2026-08-14.md'), '- written on the 14th\n')
  await startSession(fire, ctx)

  const first = await prompt(fire, ctx)
  ok(first?.includes('### Today (2026-08-14)'))
  day = 15
  const second = await prompt(fire, ctx)

  notEqual(second, first)
  ok(!second?.includes('### Today'), 'no daily memory file exists for the new day')
  ok(second?.includes('### Yesterday (2026-08-14)'))
  ok(second?.includes('- written on the 14th'))
})

test('the first prompt builds the snapshot even when session_start never fired', async () => {
  const { ctx, fire, memoryDir } = setup()
  writeFileSync(join(memoryDir, '2026-08-14.md'), '- today entry\n')

  const block = injectedBlock(await prompt(fire, ctx))

  ok(block.includes('- today entry'))
})

test('per-section budgets cap the snapshot and cut at line boundaries', async () => {
  const { ctx, fire, memoryDir } = setup()
  const todayLines = Array.from({ length: 150 }, (_, i) => `- e${String(i).padStart(3, '0')} ${'x'.repeat(30)}`)
  const yesterdayLines = Array.from({ length: 100 }, (_, i) => `- y${String(i).padStart(3, '0')} ${'x'.repeat(30)}`)
  writeFileSync(join(memoryDir, '2026-08-14.md'), `${todayLines.join('\n')}\n`)
  writeFileSync(join(memoryDir, '2026-08-13.md'), `${yesterdayLines.join('\n')}\n`)
  await startSession(fire, ctx)

  const block = injectedBlock(await prompt(fire, ctx))

  ok(block.length <= 6144, `total snapshot stays within ~6K chars, got ${block.length}`)
  ok(block.includes('- e149'), "the end of today's file is kept")
  ok(!block.includes('- e000'), "the start of today's file is dropped")
  ok(block.includes('- y099'), "the end of yesterday's file is kept")
  ok(!block.includes('- y000'), "the start of yesterday's file is dropped")
  ok(block.includes('[earlier entries truncated]'))

  const today = block.slice(block.indexOf('### Today'), block.indexOf('### Yesterday'))
  for (const line of today.split('\n').filter((line) => line.startsWith('- ')))
    match(line, /^- e\d{3} x{30}$/, 'truncation never leaves a partial line')
})

test('PI_MEMSEARCH_SNAPSHOT=off disables injection but keeps memory_write', async () => {
  const { ctx, fire, tools } = setup({ env: { PI_MEMSEARCH_SNAPSHOT: 'off' } })
  await startSession(fire, ctx)

  equal(await prompt(fire, ctx), undefined)
  ok(tools.has('memory_write'))
})
