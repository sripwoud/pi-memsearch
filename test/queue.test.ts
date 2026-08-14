import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, ok, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExecResult } from '../src/exec.ts'
import { createMemsearchExtension } from '../src/extension.ts'
import {
  CONFIG_ERROR_STDERR,
  errResult,
  LOCK_STDERR_0416,
  LOCK_STDERR_0417,
  okResult,
  SEARCH_JSON,
  VERSION_STDOUT,
} from './fixtures.ts'
import { createFakeContext, createFakeExec, createFakePi, type FakeExecStep, type FakeSession } from './harness.ts'

const SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl',
}

function setup(steps: FakeExecStep[]) {
  const root = mkdtempSync(join(tmpdir(), 'memory-queue-'))
  mkdirSync(join(root, '.git'))
  const { pi, tools } = createFakePi()
  const { calls, exec } = createFakeExec(steps)
  const sleeps: number[] = []
  createMemsearchExtension({
    env: {},
    exec,
    now: () => new Date(2026, 7, 13, 22, 41),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })(pi)
  const tool = tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  const ctx = createFakeContext({ cwd: root, session: SESSION })
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
