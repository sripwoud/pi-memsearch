import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deriveCollection } from '../src/scope.ts'
import {
  CHUNK_NOT_FOUND_STDERR,
  enoentError,
  errResult,
  EXPAND_RESULT,
  MISSING_COLLECTION_STDERR,
  okResult,
  VERSION_STDOUT,
} from './fixtures.ts'
import { createFakeContext, type FakeExecStep, setupExtension, TEST_SESSION } from './harness.ts'

function setup(steps: FakeExecStep[]) {
  const { calls, ctx, root, tools } = setupExtension(steps, { prefix: 'memory-expand-' })
  const tool = tools.get('memory_expand')
  ok(tool, 'memory_expand tool is registered')
  return { calls, ctx, root, tool }
}

async function expand(
  tool: ToolDefinition,
  ctx: ExtensionContext,
  chunkHash: string,
  project?: string,
): Promise<string> {
  const params = project === undefined ? { chunk_hash: chunkHash } : { chunk_hash: chunkHash, project }
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('returns the full section for a chunk hash', async () => {
  const { calls, ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(JSON.stringify(EXPAND_RESULT))])

  const text = await expand(tool, ctx, EXPAND_RESULT.chunk_hash)

  deepEqual(calls[1]?.args.slice(2), [
    'memsearch',
    'expand',
    '-j',
    '-c',
    deriveCollection(root),
    '--',
    EXPAND_RESULT.chunk_hash,
  ])
  equal(calls[1]?.options.timeoutMs, 10_000)
  ok(text.includes(EXPAND_RESULT.content))
  ok(text.includes(`${EXPAND_RESULT.source}:${EXPAND_RESULT.start_line}-${EXPAND_RESULT.end_line}`))
  ok(text.includes(EXPAND_RESULT.anchor.transcript))
  ok(text.includes(EXPAND_RESULT.anchor.session))
  ok(text.includes(EXPAND_RESULT.anchor.turn))
})

test('an origin project routes expansion to that project collection', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'expand-origin-'))
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(JSON.stringify(EXPAND_RESULT))])

  await expand(tool, ctx, EXPAND_RESULT.chunk_hash, origin)

  deepEqual(calls[1]?.args.slice(2), [
    'memsearch',
    'expand',
    '-j',
    '-c',
    deriveCollection(origin),
    '--',
    EXPAND_RESULT.chunk_hash,
  ])
})

test('an empty origin project is treated as absent, not as a path', async () => {
  const { calls, ctx: _ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(JSON.stringify(EXPAND_RESULT))])
  const nested = join(root, 'packages', 'core')
  mkdirSync(nested, { recursive: true })
  const ctx = createFakeContext({ cwd: nested, session: TEST_SESSION })

  await expand(tool, ctx, EXPAND_RESULT.chunk_hash, '')

  ok(calls[1]?.args.includes(deriveCollection(root)), 'expansion stays on the session scope collection')
})

test('expanding into a never-indexed collection reports it plainly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), errResult(1, MISSING_COLLECTION_STDERR)])

  await rejects(() => expand(tool, ctx, 'abc'), /never indexed/)
})

test('a section without an anchor renders without an origin line', async () => {
  const { anchor: _anchor, ...unanchored } = EXPAND_RESULT
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(JSON.stringify(unanchored))])

  const text = await expand(tool, ctx, unanchored.chunk_hash)

  ok(text.includes(unanchored.content))
  ok(!text.includes('origin:'))
})

test('an unknown chunk hash fails with the backend message', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), errResult(1, CHUNK_NOT_FOUND_STDERR)])

  await rejects(() => expand(tool, ctx, 'deadbeef00000000'), /Chunk not found/)
})

test('json shape drift fails loudly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('{"chunk_hash":"abc"}')])

  await rejects(() => expand(tool, ctx, 'abc'), /content/)
})

test('missing uv returns install instructions instead of an error', async () => {
  const { ctx, tool } = setup([enoentError()])

  const text = await expand(tool, ctx, 'abc')

  match(text, /astral\.sh\/uv\/install\.sh/)
})
