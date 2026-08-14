import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { createMemsearchExtension } from '../src/extension.ts'
import { deriveCollection } from '../src/scope.ts'
import { enoentError, okResult, SEARCH_HITS, SEARCH_JSON, VERSION_STDOUT } from './fixtures.ts'
import { createFakePi, type FakeExecStep, setupExtension } from './harness.ts'

function setup(steps: FakeExecStep[], options: { env?: NodeJS.ProcessEnv } = {}) {
  const { calls, ctx, root, tools } = setupExtension(steps, { ...options, prefix: 'memory-search-' })
  const tool = tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  return { calls, ctx, root, tool }
}

async function search(
  tool: ToolDefinition,
  ctx: ExtensionContext,
  params: { query: string; top_k?: number },
): Promise<string> {
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

test('returns scored chunks for the default top-k of 5', async () => {
  const { calls, ctx, root, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])

  const text = await search(tool, ctx, { query: 'redis cache' })

  deepEqual(calls[1]?.args.slice(2), [
    'memsearch',
    'search',
    '-j',
    '-k',
    '5',
    '-c',
    deriveCollection(root),
    '--',
    'redis cache',
  ])
  equal(calls[1]?.options.timeoutMs, 30_000)
  const [first, second] = SEARCH_HITS
  ok(first && second)
  ok(text.includes(first.chunk_hash))
  ok(text.includes(first.content))
  ok(text.includes('1.000'))
  ok(text.includes(second.chunk_hash))
  ok(text.includes('0.508'))
})

test('passes an explicit top_k through to the backend', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])

  await search(tool, ctx, { query: 'redis cache', top_k: 2 })

  ok(calls[1]?.args.join(' ').includes('-k 2'))
})

test('an empty result says so plainly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('[]')])

  const text = await search(tool, ctx, { query: 'nothing ever written' })

  match(text, /No memories found/)
})

test('json shape drift fails loudly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('[{"chunk_hash":123}]')])

  await rejects(() => search(tool, ctx, { query: 'redis' }), /chunk_hash/)
})

test('non-json output fails loudly', async () => {
  const { ctx, tool } = setup([okResult(VERSION_STDOUT), okResult('No results found.')])

  await rejects(() => search(tool, ctx, { query: 'redis' }), /drift/)
})

test('a query starting with a dash is never parsed as an option', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)])

  await search(tool, ctx, { query: '-k weird query' })

  const args = calls[1]?.args ?? []
  deepEqual(args.slice(args.indexOf('--')), ['--', '-k weird query'])
})

test('missing uv returns install instructions instead of an error', async () => {
  const { ctx, tool } = setup([enoentError()])

  const text = await search(tool, ctx, { query: 'redis' })

  match(text, /astral\.sh\/uv\/install\.sh/)
})

test('PI_MEMSEARCH_SEARCH_TIMEOUT_MS overrides the search timeout', async () => {
  const { calls, ctx, tool } = setup([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], {
    env: { PI_MEMSEARCH_SEARCH_TIMEOUT_MS: '45000' },
  })

  await search(tool, ctx, { query: 'redis' })

  equal(calls[1]?.options.timeoutMs, 45_000)
})

test('a malformed PI_MEMSEARCH_SEARCH_TIMEOUT_MS fails fast at load', () => {
  const { pi } = createFakePi()

  throws(
    () => createMemsearchExtension({ env: { PI_MEMSEARCH_SEARCH_TIMEOUT_MS: 'soon' } })(pi),
    /PI_MEMSEARCH_SEARCH_TIMEOUT_MS/,
  )
})
