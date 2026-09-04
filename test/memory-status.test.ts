import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deriveCollection } from '../src/scope.ts'
import {
  abortError,
  eaccesError,
  enoentError,
  errResult,
  MISSING_COLLECTION_STDERR,
  okResult,
  SKILLS_STATUS_NONE_STDOUT,
  SKILLS_STATUS_PENDING_STDOUT,
  STATS_STDOUT,
  UVX_PREFIX,
  VERSION_STDOUT,
} from './fixtures.ts'
import { answeringStore, type FakeExecStep, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[], options: { clock?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  const { calls, ctx, root, tools } = setupExtension(steps, { ...options, prefix: 'memory-status-' })
  const tool = tools.get('memory_status')
  ok(tool, 'memory_status tool is registered')
  return { calls, ctx, root, tool }
}

async function status(tool: ToolDefinition, ctx: ExtensionContext): Promise<string> {
  const result = await tool.execute('call-1', {}, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('reports version, scope, collection and chunk count', async () => {
  const { calls, ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])

  const text = await status(tool, ctx)

  const collection = deriveCollection(root)
  equal(calls[0]?.command, 'uvx')
  deepEqual(calls[0]?.args, [...UVX_PREFIX, '--version'])
  deepEqual(calls[1]?.args, [...UVX_PREFIX, 'stats', '-c', collection])
  equal(calls[0]?.options.timeoutMs, 60_000)
  equal(calls[1]?.options.timeoutMs, 10_000)
  ok(text.includes('memsearch: 0.4.17'))
  ok(text.includes(`scope: ${root}`))
  ok(text.includes(`store: ${join(root, '.memsearch', 'memory')}`))
  ok(text.includes(`collection: ${collection}`))
  ok(text.includes('indexed chunks: 42'))
})

test('a delegated store surfaces its dir and collection, so the active seam is visible', async () => {
  const central = mkdtempSync(join(tmpdir(), 'memory-status-central-'))
  const command = answeringStore(join(central, 'memory'), 'ms_central_deadbeef')
  const { calls, ctx, tool } = setup(
    [okResult(VERSION_STDOUT), okResult(STATS_STDOUT), okResult(SKILLS_STATUS_NONE_STDOUT)],
    { env: { PI_MEMSEARCH_STORE_CMD: command } },
  )

  const text = await status(tool, ctx)

  deepEqual(calls[1]?.args, [...UVX_PREFIX, 'stats', '-c', 'ms_central_deadbeef'])
  ok(text.includes(`scope: ${central}`))
  ok(text.includes(`store: ${join(central, 'memory')}`))
  ok(text.includes('collection: ms_central_deadbeef'))
})

test('probes the version once and reuses it on later calls', async () => {
  const { calls, ctx, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])

  await status(tool, ctx)
  await status(tool, ctx)

  equal(calls.length, 5)
  equal(calls.filter((call) => call.args.includes('--version')).length, 1)
})

test('missing uv degrades to install instructions instead of an error', async () => {
  const { calls, ctx, tool } = setup([enoentError()])

  const text = await status(tool, ctx)

  match(text, /unavailable/)
  match(text, /astral\.sh\/uv\/install\.sh/)
  equal(calls.length, 1)
})

test('a spawn failure other than enoent still degrades to instructions', async () => {
  const { ctx, tool } = setup([eaccesError()])

  const text = await status(tool, ctx)

  match(text, /unavailable/)
  match(text, /EACCES/)
})

test('a failed probe is cached with a short negative ttl, then retried', async () => {
  let time = new Date(2026, 7, 13, 22, 41).getTime()
  const { calls, ctx, tool } = setup([
    enoentError(),
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ], {
    clock: () => new Date(time),
  })

  match(await status(tool, ctx), /unavailable/)
  time += 5_000
  match(await status(tool, ctx), /unavailable/)
  equal(calls.length, 1)

  time += 31_000
  const text = await status(tool, ctx)
  ok(text.includes('memsearch: 0.4.17'))
  equal(calls.length, 4)
})

function writeIndexState(root: string, state: object): void {
  mkdirSync(join(root, '.memsearch'), { recursive: true })
  writeFileSync(join(root, '.memsearch', '.index-state.json'), JSON.stringify(state))
}

test('without an index-state file the index health reads as unrecorded', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT), okResult(SKILLS_STATUS_NONE_STDOUT)])

  const text = await status(tool, ctx)

  ok(text.includes('index: no state recorded yet'))
})

test('the reported index-state path is the one beside the store', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])

  const text = await status(tool, ctx)

  ok(text.includes(`index state: ${join(root, '.memsearch', '.index-state.json')}`))
})

test('MEMSEARCH_DIR holds the index state even when the store command answers elsewhere', async () => {
  const central = mkdtempSync(join(tmpdir(), 'memory-status-central-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'memory-status-state-'))
  const { ctx, tool } = setup(
    [okResult(VERSION_STDOUT), okResult(STATS_STDOUT), okResult(SKILLS_STATUS_NONE_STDOUT)],
    { env: { MEMSEARCH_DIR: stateDir, PI_MEMSEARCH_STORE_CMD: answeringStore(join(central, 'pi'), 'ms_pi_deadbeef') } },
  )
  writeFileSync(
    join(stateDir, '.index-state.json'),
    JSON.stringify({ failed_files: [], last_completed_at: '2026-08-14T07:00:05Z', schema_version: 1, status: 'ok' }),
  )

  const text = await status(tool, ctx)

  ok(text.includes(`index state: ${join(stateDir, '.index-state.json')}`))
  ok(text.includes('index: ok (last indexed 2026-08-14T07:00:05Z)'))
})

test('an ok index state reports the last completed run', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])
  writeIndexState(root, {
    failed_files: [],
    last_completed_at: '2026-08-14T07:00:05Z',
    schema_version: 1,
    status: 'ok',
  })

  const text = await status(tool, ctx)

  ok(text.includes('index: ok (last indexed 2026-08-14T07:00:05Z)'))
})

test('a degraded index state surfaces the failed files', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])
  const failed = join(root, '.memsearch', 'memory', '2026-08-13.md')
  writeIndexState(root, {
    failed_files: [{ error: 'UnicodeDecodeError: boom', path: failed }],
    last_error: '1 file(s) failed during indexing.',
    schema_version: 1,
    status: 'degraded',
  })

  const text = await status(tool, ctx)

  ok(text.includes('index: degraded (1 failed file(s))'))
  ok(text.includes(`failed: ${failed} (UnicodeDecodeError: boom)`))
})

test('an error index state surfaces the last error', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])
  writeIndexState(root, {
    failed_files: [],
    last_error: 'RuntimeError: could not open the database',
    schema_version: 1,
    status: 'error',
  })

  const text = await status(tool, ctx)

  ok(text.includes('index: error (RuntimeError: could not open the database)'))
})

test('an unsupported index-state schema version reads as unreadable', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])
  writeIndexState(root, { failed_files: [], schema_version: 2, status: 'ok' })

  const text = await status(tool, ctx)

  match(text, /index: state unreadable \(index-state file drifted: unsupported schema_version 2\)/)
})

test('an unreadable index-state file is reported instead of crashing the status tool', async () => {
  const { ctx, root, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])
  mkdirSync(join(root, '.memsearch'), { recursive: true })
  writeFileSync(join(root, '.memsearch', '.index-state.json'), '{not json')

  const text = await status(tool, ctx)

  match(text, /index: state unreadable/)
})

test('index health is reported even when the backend is unavailable', async () => {
  const { ctx, root, tool } = setup([enoentError()])
  writeIndexState(root, { failed_files: [], schema_version: 1, status: 'ok' })

  const text = await status(tool, ctx)

  match(text, /unavailable/)
  ok(text.includes('index: ok'))
})

test('pending skill candidates surface with counts and the skill-drafting pointer', async () => {
  const { calls, ctx, tool } = setup([
    okResult(VERSION_STDOUT),
    okResult(STATS_STDOUT),
    okResult(SKILLS_STATUS_PENDING_STDOUT),
  ])

  const text = await status(tool, ctx)

  deepEqual(calls[2]?.args, [...UVX_PREFIX, 'skills', 'status', '-j'])
  equal(calls[2]?.options.timeoutMs, 10_000)
  ok(text.includes('skill candidates: 2 pending install (1 new, 1 updated) - review with the skill-drafting skill'))
})

test('no skill-candidate line appears when nothing is pending', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT), okResult(SKILLS_STATUS_NONE_STDOUT)])

  const text = await status(tool, ctx)

  ok(!text.includes('skill candidates'))
})

test('a failing skills status call degrades quietly without a line', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT), errResult(1, 'boom')])

  const text = await status(tool, ctx)

  ok(text.includes('indexed chunks: 42'))
  ok(!text.includes('skill candidates'))
})

test('an aborted skills status call propagates instead of degrading', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT), abortError()])

  await rejects(() => tool.execute('call-1', {}, undefined, undefined, ctx), { name: 'AbortError' })
})

test('a missing collection reads as zero indexed chunks', async () => {
  const { ctx, tool } = setup([
    okResult(VERSION_STDOUT),
    errResult(1, MISSING_COLLECTION_STDERR),
    okResult(SKILLS_STATUS_NONE_STDOUT),
  ])

  const text = await status(tool, ctx)

  ok(text.includes('indexed chunks: 0 (collection not created yet)'))
})
