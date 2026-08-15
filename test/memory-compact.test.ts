import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExecResult } from '../src/exec.ts'
import { createMemsearchExtension } from '../src/extension.ts'
import { deriveCollection } from '../src/scope.ts'
import {
  COMPACT_STDOUT,
  COMPACT_SUMMARY,
  CONFIG_ERROR_STDERR,
  enoentError,
  errResult,
  INDEXED_STDOUT,
  LOCK_STDERR_0417,
  okResult,
  SEARCH_JSON,
  UVX_PREFIX,
  VERSION_STDOUT,
} from './fixtures.ts'
import { createFakePi, type FakeExecStep, prompt, type RecordedCall, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[], options: { env?: NodeJS.ProcessEnv } = {}) {
  const { calls, ctx, fire, root, sleeps, tools } = setupExtension(steps, { ...options, prefix: 'memory-compact-' })
  const tool = tools.get('memory_compact')
  ok(tool, 'memory_compact tool is registered')
  return { calls, ctx, fire, root, sleeps, tool, tools }
}

async function compact(tool: ToolDefinition, ctx: ExtensionContext): Promise<string> {
  const result = await tool.execute('call-1', {}, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('takes no parameters and runs compact against the project memory store', async () => {
  const { calls, ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(COMPACT_STDOUT)])

  const text = await compact(tool, ctx)

  deepEqual(calls[1]?.args, [
    ...UVX_PREFIX,
    'compact',
    '-s',
    join(root, '.memsearch', 'memory'),
    '-o',
    join(root, '.memsearch'),
    '-c',
    deriveCollection(root),
  ])
  equal(calls[1]?.options.timeoutMs, 300_000)
  equal(text, COMPACT_SUMMARY)
})

test('the parameter schema is empty', () => {
  const { tool } = setup([])

  const schema = tool.parameters as { properties?: Record<string, unknown> }
  deepEqual(Object.keys(schema.properties ?? {}), [])
})

test('the description disambiguates memory from context compaction and restricts use', () => {
  const { tool } = setup([])

  match(tool.description, /memory compaction/i)
  match(tool.description, /context compaction/i)
  match(tool.description, /explicitly asks/)
})

test('missing uv returns install instructions instead of an error', async () => {
  const { ctx, tool } = setup([enoentError()])

  const text = await compact(tool, ctx)

  match(text, /astral\.sh\/uv\/install\.sh/)
})

test('a failed compact surfaces the stderr detail', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), errResult(1, CONFIG_ERROR_STDERR)])

  await rejects(
    () => compact(tool, ctx),
    /memsearch compact failed: exit 1: Configuration error: environment variable OPENAI_API_KEY is not set/,
  )
})

test('lock contention retries with backoff, invisibly to the caller', async () => {
  const { calls, ctx, sleeps, tool } = setup([
    okResult(VERSION_STDOUT),
    errResult(1, LOCK_STDERR_0417),
    okResult(COMPACT_STDOUT),
  ])

  const text = await compact(tool, ctx)

  equal(text, COMPACT_SUMMARY)
  equal(calls.length, 3)
  deepEqual(sleeps, [200])
})

test('output drift fails loudly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('Compacted OK\n')])

  await rejects(() => compact(tool, ctx), /memsearch compact output drifted/)
})

test('PI_MEMSEARCH_COMPACT_TIMEOUT_MS overrides the compact timeout', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(COMPACT_STDOUT)], {
    env: { PI_MEMSEARCH_COMPACT_TIMEOUT_MS: '600000' },
  })

  await compact(tool, ctx)

  equal(calls[1]?.options.timeoutMs, 600_000)
})

test('a malformed PI_MEMSEARCH_COMPACT_TIMEOUT_MS fails fast at load', () => {
  const { pi } = createFakePi()

  throws(
    () => createMemsearchExtension({ env: { PI_MEMSEARCH_COMPACT_TIMEOUT_MS: 'later' } })(pi),
    /PI_MEMSEARCH_COMPACT_TIMEOUT_MS/,
  )
})

test('the abort signal is passed through to the backend process', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(COMPACT_STDOUT)])
  const controller = new AbortController()

  await tool.execute('call-1', {}, controller.signal, undefined, ctx)

  equal(calls[1]?.options.signal, controller.signal)
})

test('compact runs through the same serialized queue as search', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const respond = async (call: RecordedCall): Promise<ExecResult> => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight--
    if (call.args.includes('--version')) return okResult(VERSION_STDOUT)
    return call.args.includes('compact') ? okResult(COMPACT_STDOUT) : okResult(SEARCH_JSON)
  }
  const { ctx, tool, tools } = setup([respond, respond, respond])
  const search = tools.get('memory_search')
  ok(search, 'memory_search tool is registered')

  await Promise.all([
    compact(tool, ctx),
    search.execute('call-2', { query: 'redis' }, undefined, undefined, ctx),
  ])

  equal(maxInFlight, 1)
})

test('a mid-session compact does not refresh the stable snapshot', async () => {
  const { ctx, fire, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(INDEXED_STDOUT),
    okResult(COMPACT_STDOUT),
  ])
  const memoryDir = join(root, '.memsearch', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const file = join(memoryDir, '2026-08-13.md')
  writeFileSync(file, '- first entry\n')
  await fire('session_start', { reason: 'startup' }, ctx)

  const first = await prompt(fire, ctx)
  appendFileSync(file, '- summary appended by compact\n')
  await compact(tool, ctx)
  const second = await prompt(fire, ctx)

  equal(second, first)
  ok(!second?.includes('summary appended by compact'))
})
