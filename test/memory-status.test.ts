import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMemsearchExtension } from '../src/extension.ts'
import { deriveCollection } from '../src/scope.ts'
import {
  enoentError,
  errResult,
  MISSING_COLLECTION_STDERR,
  okResult,
  STATS_STDOUT,
  VERSION_STDOUT,
} from './fixtures.ts'
import { createFakeContext, createFakeExec, createFakePi, type FakeExecStep, type FakeSession } from './harness.ts'

const SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl',
}

const UVX_PREFIX = ['--from', 'memsearch[onnx]>=0.4.17,<0.5', 'memsearch']

function setup(steps: FakeExecStep[], options: { clock?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-status-'))
  mkdirSync(join(root, '.git'))
  const { pi, tools } = createFakePi()
  const { calls, exec } = createFakeExec(steps)
  createMemsearchExtension({
    env: {},
    exec,
    now: options.clock ?? (() => new Date(2026, 7, 13, 22, 41)),
    sleep: async () => {},
  })(pi)
  const tool = tools.get('memory_status')
  ok(tool, 'memory_status tool is registered')
  const ctx = createFakeContext({ cwd: root, session: SESSION })
  return { calls, ctx, root, tool }
}

async function status(tool: ToolDefinition, ctx: ExtensionContext): Promise<string> {
  const result = await tool.execute('call-1', {}, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('reports version, scope, collection and chunk count', async () => {
  const { calls, ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT)])

  const text = await status(tool, ctx)

  const collection = deriveCollection(root)
  equal(calls[0]?.command, 'uvx')
  deepEqual(calls[0]?.args, [...UVX_PREFIX, '--version'])
  deepEqual(calls[1]?.args, [...UVX_PREFIX, 'stats', '-c', collection])
  equal(calls[0]?.options.timeoutMs, 60_000)
  equal(calls[1]?.options.timeoutMs, 10_000)
  ok(text.includes('memsearch: 0.4.17'))
  ok(text.includes(`scope: ${root}`))
  ok(text.includes(`collection: ${collection}`))
  ok(text.includes('indexed chunks: 42'))
})

test('probes the version once and reuses it on later calls', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT), okResult(STATS_STDOUT)])

  await status(tool, ctx)
  await status(tool, ctx)

  equal(calls.length, 3)
  equal(calls.filter((call) => call.args.includes('--version')).length, 1)
})

test('missing uv degrades to install instructions instead of an error', async () => {
  const { calls, ctx, tool } = setup([enoentError()])

  const text = await status(tool, ctx)

  match(text, /unavailable/)
  match(text, /astral\.sh\/uv\/install\.sh/)
  equal(calls.length, 1)
})

test('a failed probe is cached with a short negative ttl, then retried', async () => {
  let time = new Date(2026, 7, 13, 22, 41).getTime()
  const { calls, ctx, tool } = setup([enoentError(), okResult(VERSION_STDOUT), okResult(STATS_STDOUT)], {
    clock: () => new Date(time),
  })

  match(await status(tool, ctx), /unavailable/)
  time += 5_000
  match(await status(tool, ctx), /unavailable/)
  equal(calls.length, 1)

  time += 31_000
  const text = await status(tool, ctx)
  ok(text.includes('memsearch: 0.4.17'))
  equal(calls.length, 3)
})

test('a missing collection reads as zero indexed chunks', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), errResult(1, MISSING_COLLECTION_STDERR)])

  const text = await status(tool, ctx)

  ok(text.includes('indexed chunks: 0 (collection not created yet)'))
})
