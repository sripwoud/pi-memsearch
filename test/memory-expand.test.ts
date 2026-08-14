import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { deriveCollection } from '../src/scope.ts'
import { CHUNK_NOT_FOUND_STDERR, enoentError, errResult, EXPAND_RESULT, okResult, VERSION_STDOUT } from './fixtures.ts'
import { type FakeExecStep, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[]) {
  const { calls, ctx, root, tools } = setupExtension(steps, { prefix: 'memory-expand-' })
  const tool = tools.get('memory_expand')
  ok(tool, 'memory_expand tool is registered')
  return { calls, ctx, root, tool }
}

async function expand(tool: ToolDefinition, ctx: ExtensionContext, chunkHash: string): Promise<string> {
  const result = await tool.execute('call-1', { chunk_hash: chunkHash }, undefined, undefined, ctx)
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
