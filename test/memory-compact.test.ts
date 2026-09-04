import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExecResult } from '../src/exec.ts'
import { createMemsearchExtension } from '../src/extension.ts'
import { deriveCollection } from '../src/scope.ts'
import {
  COMPACT_NOOP_STDOUT,
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
import {
  answeringStore,
  createFakePi,
  type FakeExecStep,
  prompt,
  type RecordedCall,
  setupExtension,
} from './harness.ts'

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

test('takes no parameters and runs memory compaction over the whole project collection', async () => {
  const { calls, ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(COMPACT_STDOUT)])

  const result = await tool.execute('call-1', {}, undefined, undefined, ctx)

  deepEqual(calls[1]?.args, [
    ...UVX_PREFIX,
    'compact',
    '-o',
    join(root, '.memsearch'),
    '-c',
    deriveCollection(root),
  ])
  equal(calls[1]?.options.timeoutMs, 300_000)
  const first = result.content[0]
  ok(first?.type === 'text')
  equal(first.text, COMPACT_SUMMARY)
  deepEqual(result.details, { collection: deriveCollection(root) })
})

test('a store that is not a leaf memory directory refuses to compact and spends nothing', async () => {
  const store = join(mkdtempSync(join(tmpdir(), 'memory-compact-central-')), 'pi-memsearch')
  const { calls, ctx, tool } = setup([], {
    env: { PI_MEMSEARCH_STORE_CMD: answeringStore(store, 'ms_pi_memsearch_deadbeef') },
  })

  await rejects(
    () => compact(tool, ctx),
    new RegExp(`memory_compact needs a store directory named "memory".*${store}`, 's'),
  )

  deepEqual(calls, [])
})

test('an empty collection reports nothing to compact instead of failing', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(COMPACT_NOOP_STDOUT)])

  const text = await compact(tool, ctx)

  match(text, /Nothing to compact/)
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

test('a failed memory compaction surfaces the stderr detail', async () => {
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

test('a whitespace-only summary fails loudly instead of returning empty text', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('Compact complete. Summary:\n\n   \n')])

  await rejects(() => compact(tool, ctx), /memsearch compact output drifted/)
})

test('PI_MEMSEARCH_COMPACT_TIMEOUT_MS overrides the memory compaction timeout', async () => {
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

test('aborting the tool signal aborts the backend exec signal', async () => {
  const controller = new AbortController()
  const observed: Array<boolean | undefined> = []
  const step = async (call: RecordedCall): Promise<ExecResult> => {
    observed.push(call.options.signal?.aborted)
    controller.abort()
    observed.push(call.options.signal?.aborted)
    return okResult(COMPACT_STDOUT)
  }
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), step])

  await tool.execute('call-1', {}, controller.signal, undefined, ctx)

  deepEqual(observed, [false, true])
})

test('memory compaction runs through the same serialized queue as search', async () => {
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

test('a mid-session memory compaction does not refresh the stable snapshot', async () => {
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
