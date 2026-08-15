import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecResult } from '../src/exec.ts'
import {
  COMPACT_STDOUT,
  CONFIG_ERROR_STDERR,
  errResult,
  INCOMPATIBLE_DB_STDERR,
  LOCK_STDERR_0416,
  LOCK_STDERR_0417,
  LOCK_STDERR_MILVUS_LITE_3X,
  okResult,
  SEARCH_JSON,
  USAGE_ERROR_STDERR,
  VERSION_STDOUT,
} from './fixtures.ts'
import { type FakeExecStep, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[], sleepImpl?: (ms: number) => Promise<void>) {
  const { calls, ctx, fire, sleeps, tools } = setupExtension(
    steps,
    sleepImpl ? { prefix: 'memory-queue-', sleep: sleepImpl } : { prefix: 'memory-queue-' },
  )
  const tool = tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  return { calls, ctx, fire, sleeps, tool, tools }
}

async function search(
  tool: ToolDefinition,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
): Promise<string> {
  const result = await tool.execute('call-1', { query: 'redis' }, signal, onUpdate, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

function gate(result: ExecResult): { release(): void; started: Promise<void>; step: FakeExecStep } {
  let release: () => void = () => {}
  let notifyStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const step: FakeExecStep = () => {
    notifyStarted()
    return new Promise<ExecResult>((resolve) => {
      release = () => resolve(result)
    })
  }
  return { release: () => release(), started, step }
}

function noteRecorder(): { notes: string[]; onUpdate: AgentToolUpdateCallback } {
  const notes: string[] = []
  const onUpdate: AgentToolUpdateCallback = (update) => {
    const first = update.content[0]
    if (first?.type === 'text') notes.push(first.text)
  }
  return { notes, onUpdate }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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

test('lock contention (milvus-lite 3.x phrasing) retries with backoff, invisibly to the caller', async () => {
  const { calls, ctx, sleeps, tool } = setup([
    okResult(VERSION_STDOUT),
    errResult(1, LOCK_STDERR_MILVUS_LITE_3X),
    okResult(SEARCH_JSON),
  ])

  const text = await search(tool, ctx)

  ok(text.includes('memory chunk'))
  equal(calls.length, 3)
  deepEqual(sleeps, [200])
})

test('an incompatible database is not mistaken for lock contention', async () => {
  const { calls, ctx, sleeps, tool } = setup([okResult(VERSION_STDOUT), errResult(1, INCOMPATIBLE_DB_STDERR)])

  await rejects(() => search(tool, ctx), /Move the existing \.db file aside/)

  equal(calls.length, 2)
  deepEqual(sleeps, [])
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

test('a search queued behind memory compaction gets one note naming the holder', async () => {
  const compact = gate(okResult(COMPACT_STDOUT))
  const { calls, ctx, tool, tools } = setup([okResult(VERSION_STDOUT), compact.step, okResult(SEARCH_JSON)])
  const compactTool = tools.get('memory_compact')
  ok(compactTool, 'memory_compact tool is registered')

  const compacting = compactTool.execute('call-1', {}, undefined, undefined, ctx)
  await compact.started
  const { notes, onUpdate } = noteRecorder()
  const searching = search(tool, ctx, undefined, onUpdate)
  await tick()

  deepEqual(notes, ['waiting on memory compaction'], 'the note lands at enqueue, before the holder finishes')

  compact.release()
  await compacting
  ok((await searching).includes('memory chunk'))
  deepEqual(notes, ['waiting on memory compaction'], 'the note fires exactly once, never periodically')
  const searchCall = calls.find((call) => call.args.includes('search'))
  equal(searchCall?.options.timeoutMs, 30_000, 'time spent queued does not count toward the exec timeout')
})

test('a search on an idle queue emits no queued note', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])
  const { notes, onUpdate } = noteRecorder()

  const text = await search(tool, ctx, undefined, onUpdate)

  ok(text.includes('memory chunk'))
  deepEqual(notes, [])
})

test('the queued note names whichever command holds the queue', async () => {
  const holder = gate(okResult(SEARCH_JSON))
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), holder.step, okResult(SEARCH_JSON)])

  const first = search(tool, ctx)
  await holder.started
  const { notes, onUpdate } = noteRecorder()
  const second = search(tool, ctx, undefined, onUpdate)
  await tick()

  deepEqual(notes, ['waiting on search'])

  holder.release()
  await Promise.all([first, second])
})
