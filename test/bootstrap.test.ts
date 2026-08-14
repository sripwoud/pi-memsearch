import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { enoentError, errResult, okResult, SEARCH_JSON, STATS_STDOUT, VERSION_STDOUT } from './fixtures.ts'
import { type FakeExecStep, GLOBAL_CONFIG_TOML, setupExtension, type SetupOptions } from './harness.ts'

const UVX_PREFIX = ['--from', 'memsearch[onnx]>=0.4.17,<0.5', 'memsearch']
const CONFIG_SET_ARGS = [...UVX_PREFIX, 'config', 'set', 'embedding.provider', 'onnx']

function setup(steps: FakeExecStep[], options: SetupOptions = {}) {
  const result = setupExtension(steps, { prefix: 'bootstrap-', ...options })
  const search = result.tools.get('memory_search')
  const status = result.tools.get('memory_status')
  ok(search && status, 'memory_search and memory_status tools are registered')
  return { ...result, search, status }
}

async function text(tool: ToolDefinition, ctx: ExtensionContext, params: object = { query: 'redis' }) {
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

function configSets(calls: { args: string[] }[]) {
  return calls.filter((call) => deepEqualArgs(call.args, CONFIG_SET_ARGS))
}

function deepEqualArgs(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

test('a machine with no config gets the onnx provider set globally before the first search', async () => {
  const { calls, ctx, search } = setup([okResult(VERSION_STDOUT), okResult(''), okResult(SEARCH_JSON)], {
    globalConfig: false,
  })

  const result = await text(search, ctx)

  ok(result.includes('memory chunk'))
  deepEqual(calls[1]?.args, CONFIG_SET_ARGS)
  equal(calls[1]?.options.timeoutMs, 10_000)
  ok(calls[2]?.args.includes('search'))
})

test('the provider is bootstrapped exactly once across sequential calls', async () => {
  const { calls, ctx, search } = setup(
    [okResult(VERSION_STDOUT), okResult(''), okResult(SEARCH_JSON), okResult(SEARCH_JSON)],
    { globalConfig: false },
  )

  await text(search, ctx)
  await text(search, ctx)

  equal(configSets(calls).length, 1)
})

test('concurrent first searches share a single bootstrap', async () => {
  const { calls, ctx, search } = setup(
    [okResult(VERSION_STDOUT), okResult(''), okResult(SEARCH_JSON), okResult(SEARCH_JSON)],
    { globalConfig: false },
  )

  await Promise.all([text(search, ctx), text(search, ctx)])

  equal(configSets(calls).length, 1)
})

test('an existing global config is left untouched, byte for byte', async () => {
  const { calls, ctx, home, search } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])
  const configPath = join(home, '.memsearch', 'config.toml')

  await text(search, ctx)

  equal(readFileSync(configPath, 'utf8'), GLOBAL_CONFIG_TOML)
  equal(calls.filter((call) => call.args.includes('config')).length, 0)
})

test('a project .memsearch.toml alone counts as configured', async () => {
  const { calls, ctx, root, search } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], {
    globalConfig: false,
  })
  writeFileSync(join(root, '.memsearch.toml'), '[chunking]\nmax_chunk_size = 800\n')

  await text(search, ctx)

  equal(calls.filter((call) => call.args.includes('config')).length, 0)
})

test('session_start runs the bootstrap in the background', async () => {
  const tasks: Promise<void>[] = []
  const { calls, ctx, fire } = setup([okResult(VERSION_STDOUT), okResult('')], {
    globalConfig: false,
    schedule: (task) => {
      tasks.push(task())
    },
  })

  await fire('session_start', { reason: 'startup' }, ctx)
  await Promise.all(tasks)

  equal(configSets(calls).length, 1)
})

test('memory_status reports a fresh bootstrap', async () => {
  const { ctx, status } = setup([okResult(VERSION_STDOUT), okResult(''), okResult(STATS_STDOUT)], {
    globalConfig: false,
  })

  const result = await text(status, ctx, {})

  ok(result.includes('bootstrap: embedding.provider = onnx set globally (no prior config)'))
})

test('memory_status reports an existing config as not needing bootstrap', async () => {
  const { ctx, home, status } = setup([okResult(VERSION_STDOUT), okResult(STATS_STDOUT)])

  const result = await text(status, ctx, {})

  ok(result.includes(`bootstrap: not needed (existing config: ${join(home, '.memsearch', 'config.toml')})`))
})

test('a failed bootstrap is reported by memory_status, not swallowed', async () => {
  const { ctx, status } = setup(
    [okResult(VERSION_STDOUT), errResult(1, 'Error: read-only file system\n'), okResult(STATS_STDOUT)],
    { globalConfig: false },
  )

  const result = await text(status, ctx, {})

  ok(result.includes('bootstrap: failed (memsearch config set failed: exit 1: Error: read-only file system)'))
})

test('a backend installed mid-session is bootstrapped and searchable without restart', async () => {
  let time = new Date(2026, 7, 13, 22, 41).getTime()
  const { calls, ctx, search, status } = setup(
    [enoentError(), okResult(VERSION_STDOUT), okResult(''), okResult(SEARCH_JSON), okResult(STATS_STDOUT)],
    { clock: () => new Date(time), globalConfig: false },
  )

  match(await text(search, ctx), /astral\.sh\/uv\/install\.sh/)
  equal(calls.length, 1)

  time += 31_000
  const result = await text(search, ctx)

  ok(result.includes('memory chunk'))
  equal(configSets(calls).length, 1)
  equal(calls.length, 4)

  const doctor = await text(status, ctx, {})
  ok(doctor.includes('bootstrap: embedding.provider = onnx set globally'))
})
