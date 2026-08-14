import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, throws } from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseIndexedChunks } from '../src/contract.ts'
import type { ExecResult } from '../src/exec.ts'
import { INDEX_DEBOUNCE_MS, SHUTDOWN_CAP_MS } from '../src/indexer.ts'
import { deriveCollection } from '../src/scope.ts'
import { INDEXED_STDOUT, okResult, timeoutResult, VERSION_STDOUT } from './fixtures.ts'
import {
  assistantEntry,
  type FakeExecStep,
  fakeModel,
  type RecordedCall,
  setupExtension,
  type SetupOptions,
  userEntry,
} from './harness.ts'

const UVX_PREFIX = ['--from', 'memsearch[onnx]>=0.4.17,<0.5', 'memsearch']

function neverCapSleep(ms: number): Promise<void> {
  return ms >= SHUTDOWN_CAP_MS ? new Promise(() => {}) : Promise.resolve()
}

function setup(steps: FakeExecStep[], options: SetupOptions & { store?: boolean } = {}) {
  const { store, ...rest } = options
  const harness = setupExtension(steps, { prefix: 'indexer-', sleep: neverCapSleep, ...rest })
  const memoryDir = join(harness.root, '.memsearch', 'memory')
  if (store !== false) mkdirSync(memoryDir, { recursive: true })
  return { ...harness, memoryDir }
}

function indexCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.args[3] === 'index')
}

function notified(step: ExecResult): { done: Promise<void>; step: FakeExecStep } {
  let notify: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    notify = resolve
  })
  return {
    done,
    step: async () => {
      notify()
      return step
    },
  }
}

async function write(tool: ToolDefinition, ctx: ExtensionContext, content: string): Promise<void> {
  await tool.execute('call-1', { content }, undefined, undefined, ctx)
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('parseIndexedChunks reads the count from index output', () => {
  equal(parseIndexedChunks('Indexed 12 chunks.\n'), 12)
  equal(parseIndexedChunks('Indexed 0 chunks.\n'), 0)
})

test('parseIndexedChunks fails loudly on drifted output', () => {
  throws(() => parseIndexedChunks('Done.\n'), /index output drifted/)
})

test('session start schedules a background catch-up index of the memory store', async () => {
  const { calls, ctx, fire, memoryDir, root } = setup([okResult(VERSION_STDOUT), okResult(INDEXED_STDOUT)])

  await fire('session_start', { reason: 'startup' }, ctx)
  await fire('session_shutdown', { reason: 'quit' }, ctx)

  equal(calls.length, 2)
  deepEqual(calls[1]?.args, [...UVX_PREFIX, 'index', memoryDir, '-c', deriveCollection(root)])
  equal(calls[1]?.options.timeoutMs, 120_000)
})

test('catch-up skips the backend entirely when no memory store exists yet', async () => {
  const { calls, ctx, fire } = setup([], { store: false })

  await fire('session_start', { reason: 'startup' }, ctx)
  await fire('session_shutdown', { reason: 'quit' }, ctx)

  equal(calls.length, 0)
})

test('memory_write schedules a debounced background index', async () => {
  const { done, step } = notified(okResult(INDEXED_STDOUT))
  const sleeps: number[] = []
  const sleep = (ms: number) => {
    sleeps.push(ms)
    return neverCapSleep(ms)
  }
  const { calls, ctx, tools } = setup([okResult(VERSION_STDOUT), step], { sleep })
  const tool = tools.get('memory_write')
  ok(tool)

  await write(tool, ctx, '- a decision worth recalling')
  await done

  equal(indexCalls(calls).length, 1)
  ok(sleeps.includes(INDEX_DEBOUNCE_MS))
})

test('rapid writes coalesce into a single index run', async () => {
  const debounces: Array<() => void> = []
  const sleep = (ms: number) => {
    if (ms === INDEX_DEBOUNCE_MS) return new Promise<void>((resolve) => debounces.push(resolve))
    return neverCapSleep(ms)
  }
  const { done, step } = notified(okResult(INDEXED_STDOUT))
  const { calls, ctx, tools } = setup([okResult(VERSION_STDOUT), step], { sleep })
  const tool = tools.get('memory_write')
  ok(tool)

  await write(tool, ctx, '- first entry')
  await write(tool, ctx, '- second entry')
  equal(debounces.length, 1, 'both writes share one pending debounce')

  debounces[0]?.()
  await tick()
  equal(debounces.length, 2, 'a write during the wait restarts the debounce')

  debounces[1]?.()
  await done

  equal(indexCalls(calls).length, 1)
})

test('capture schedules a debounced background index after its write lands', async () => {
  const { done, step } = notified(okResult(INDEXED_STDOUT))
  const model = fakeModel({ id: 'session-model' })
  const { calls, ctx, fire, memoryDir } = setup([okResult(VERSION_STDOUT), step], {
    branch: [userEntry('u1', 'fix the bug'), assistantEntry('a1', 'fixed it')],
    complete: async () => '- the agent fixed the bug',
    model,
    models: [model],
  })

  await fire('agent_settled', {}, ctx)
  await done

  match(readFileSync(join(memoryDir, '2026-08-13.md'), 'utf8'), /- the agent fixed the bug/)
  equal(indexCalls(calls).length, 1)
})

test('shutdown flushes the pending capture and awaits the final index', async () => {
  const model = fakeModel({ id: 'session-model' })
  const { calls, ctx, fire, memoryDir } = setup([okResult(VERSION_STDOUT), okResult(INDEXED_STDOUT)], {
    branch: [userEntry('u1', 'fix the bug'), assistantEntry('a1', 'fixed it')],
    complete: async () => '- the agent fixed the bug',
    model,
    models: [model],
  })

  await fire('agent_settled', {}, ctx)
  await fire('session_shutdown', { reason: 'quit' }, ctx)

  match(readFileSync(join(memoryDir, '2026-08-13.md'), 'utf8'), /- the agent fixed the bug/)
  equal(indexCalls(calls).length, 1)
})

test('a hung index is aborted at the shutdown cap and deferred to the next catch-up', async () => {
  let fireCap: () => void = () => {}
  const sleep = (ms: number) => {
    if (ms >= SHUTDOWN_CAP_MS) {
      return new Promise<void>((resolve) => {
        fireCap = resolve
      })
    }
    return new Promise<void>(() => {})
  }
  let hangStarted: () => void = () => {}
  const hangReached = new Promise<void>((resolve) => {
    hangStarted = resolve
  })
  const hangUntilAborted: FakeExecStep = (call) => {
    hangStarted()
    return new Promise<ExecResult>((resolve) => {
      call.options.signal?.addEventListener('abort', () => resolve(timeoutResult()), { once: true })
    })
  }
  const { done, step } = notified(okResult(INDEXED_STDOUT))
  const { calls, ctx, fire, tools } = setup([okResult(VERSION_STDOUT), hangUntilAborted, step], { sleep })
  const tool = tools.get('memory_write')
  ok(tool)

  await write(tool, ctx, '- written just before quitting')
  const shutdown = fire('session_shutdown', { reason: 'quit' }, ctx)
  await hangReached
  fireCap()
  await shutdown

  equal(indexCalls(calls).length, 1)
  ok(calls[1]?.options.signal?.aborted, 'the in-flight index run was aborted at the cap')

  await fire('session_start', { reason: 'startup' }, ctx)
  await done

  equal(indexCalls(calls).length, 2)
  equal(calls[2]?.options.signal?.aborted, false, 'the next catch-up runs with a fresh signal')
})
