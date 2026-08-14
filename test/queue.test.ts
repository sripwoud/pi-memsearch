import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecResult } from '../src/exec.ts'
import {
  CONFIG_ERROR_STDERR,
  errResult,
  LOCK_STDERR_0416,
  LOCK_STDERR_0417,
  okResult,
  SEARCH_JSON,
  USAGE_ERROR_STDERR,
  VERSION_STDOUT,
} from './fixtures.ts'
import { type FakeExecStep, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[], sleepImpl?: (ms: number) => Promise<void>) {
  const { calls, ctx, sleeps, tools } = setupExtension(
    steps,
    sleepImpl ? { prefix: 'memory-queue-', sleep: sleepImpl } : { prefix: 'memory-queue-' },
  )
  const tool = tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  return { calls, ctx, sleeps, tool }
}

async function search(tool: ToolDefinition, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
  const result = await tool.execute('call-1', { query: 'redis' }, signal, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('lock contention (0.4.16 phrasing) retries with backoff, invisibly to the caller', async () => {
  const { calls, ctx, sleeps, tool } = setup([
    okResult(VERSION_STDOUT),
    errResult(1, LOCK_STDERR_0416),
    okResult(SEARCH_JSON),
  ])

  const text = await search(tool, ctx)

  ok(text.includes('memory chunk'))
  equal(calls.length, 3)
  deepEqual(sleeps, [200])
})

test('lock contention (0.4.17 phrasing) retries with backoff, invisibly to the caller', async () => {
  const { calls, ctx, sleeps, tool } = setup([
    okResult(VERSION_STDOUT),
    errResult(1, LOCK_STDERR_0417),
    errResult(1, LOCK_STDERR_0417),
    okResult(SEARCH_JSON),
  ])

  const text = await search(tool, ctx)

  ok(text.includes('memory chunk'))
  equal(calls.length, 4)
  deepEqual(sleeps, [200, 500])
})

test('exhausted retries surface the lock error', async () => {
  const lock = () => errResult(1, LOCK_STDERR_0417)
  const { calls, ctx, sleeps, tool } = setup([okResult(VERSION_STDOUT), lock(), lock(), lock(), lock(), lock()])

  await rejects(() => search(tool, ctx), /another process already has the database open/)

  equal(calls.length, 6)
  deepEqual(sleeps, [200, 500, 1000, 2000])
})

test('a non-lock failure is not retried', async () => {
  const { calls, ctx, sleeps, tool } = setup([okResult(VERSION_STDOUT), errResult(1, CONFIG_ERROR_STDERR)])

  await rejects(() => search(tool, ctx), /Configuration error/)

  equal(calls.length, 2)
  deepEqual(sleeps, [])
})

test('a click usage error (exit 2) fails loudly without retry', async () => {
  const { calls, ctx, sleeps, tool } = setup([okResult(VERSION_STDOUT), errResult(2, USAGE_ERROR_STDERR)])

  await rejects(() => search(tool, ctx), /No such option/)

  equal(calls.length, 2)
  deepEqual(sleeps, [])
})

test('an abort during backoff stops further retry attempts', async () => {
  const controller = new AbortController()
  const { calls, ctx, tool } = setup(
    [okResult(VERSION_STDOUT), errResult(1, LOCK_STDERR_0417), okResult(SEARCH_JSON)],
    async () => {
      controller.abort()
    },
  )

  await rejects(() => search(tool, ctx, controller.signal))

  equal(calls.length, 2)
})

test('concurrent tool calls are serialized through the single-flight queue', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const guarded = (result: ExecResult) => async (): Promise<ExecResult> => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight--
    return result
  }
  const { calls, ctx, tool } = setup([
    guarded(okResult(VERSION_STDOUT)),
    guarded(okResult(SEARCH_JSON)),
    guarded(okResult(SEARCH_JSON)),
  ])

  await Promise.all([search(tool, ctx), search(tool, ctx)])

  equal(maxInFlight, 1)
  equal(calls.filter((call) => call.args.includes('--version')).length, 1)
})

test('the abort signal is passed through to the backend process', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])
  const controller = new AbortController()

  await search(tool, ctx, controller.signal)

  equal(calls[1]?.options.signal, controller.signal)
})
