import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { deepEqual, equal, ok, rejects } from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SearchHit } from '../src/contract.ts'
import type { ExecResult } from '../src/exec.ts'
import { deriveCollection } from '../src/scope.ts'
import { COMPACT_STDOUT, errResult, MISSING_COLLECTION_STDERR, okResult, VERSION_STDOUT } from './fixtures.ts'
import { createFakeContext, type FakeExecStep, setupExtension, TEST_SESSION } from './harness.ts'

function setup(steps: FakeExecStep[], options: { env?: NodeJS.ProcessEnv } = {}) {
  const { calls, ctx, root, tools } = setupExtension(steps, { ...options, prefix: 'cross-repo-' })
  const tool = tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  return { calls, ctx, root, tool, tools }
}

async function search(
  tool: ToolDefinition,
  ctx: ExtensionContext,
  params: { query: string; scope?: string; top_k?: number },
): Promise<string> {
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

function seedScanRoot(projects: string[]): string {
  const scanRoot = mkdtempSync(join(tmpdir(), 'cross-repo-scan-'))
  for (const name of projects) mkdirSync(join(scanRoot, name, '.memsearch', 'memory'), { recursive: true })
  mkdirSync(join(scanRoot, 'not-a-project'))
  return scanRoot
}

function projectHit(project: string, score: number, hash: string): SearchHit {
  return {
    chunk_hash: hash,
    content: `note ${hash}`,
    end_line: 6,
    heading: 'note',
    heading_level: 2,
    score,
    source: join(project, '.memsearch', 'memory', '2026-08-10.md'),
    start_line: 3,
  }
}

test('scope all without configured scan roots fails fast naming the setting', async () => {
  const { calls, ctx, tool } = setup([])

  await rejects(() => search(tool, ctx, { query: 'redis', scope: 'all' }), /PI_MEMSEARCH_SCAN_ROOTS/)

  equal(calls.length, 0)
})

test('scope all fans out one search per project, current project first, merged by score with origin labels', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const alpha = join(scanRoot, 'alpha')
  const beta = join(scanRoot, 'beta')
  const { calls, ctx, root, tool } = setup(
    [
      okResult(VERSION_STDOUT),
      (call) => {
        equal(call.args.includes(deriveCollection(root)), true, 'current project searched first')
        return Promise.resolve(okResult(JSON.stringify([projectHit(root, 0.9, 'aaaa000000000001')])))
      },
      okResult(
        JSON.stringify([projectHit(alpha, 1.0, 'bbbb000000000002'), projectHit(alpha, 0.4, 'cccc000000000003')]),
      ),
      okResult(JSON.stringify([projectHit(beta, 0.7, 'dddd000000000004')])),
    ],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )

  const text = await search(tool, ctx, { query: 'redis cache', scope: 'all' })

  equal(calls.length, 4)
  for (
    const [index, collection] of [deriveCollection(root), deriveCollection(alpha), deriveCollection(beta)].entries()
  ) {
    deepEqual(calls[index + 1]?.args.slice(2), [
      'memsearch',
      'search',
      '-j',
      '-k',
      '5',
      '-c',
      collection,
      '--',
      'redis cache',
    ])
  }
  const order = ['bbbb000000000002', 'aaaa000000000001', 'dddd000000000004', 'cccc000000000003']
  const positions = order.map((hash) => text.indexOf(`chunk ${hash}`))
  ok(positions.every((position) => position >= 0), 'every hit is rendered')
  deepEqual([...positions].sort((a, b) => a - b), positions, 'hits are ordered by score across projects')
  ok(text.includes(`| ${alpha} |`), 'hits carry their origin project label')
  ok(text.includes(`| ${root} |`))
  ok(text.includes(`| ${beta} |`))
  ok(text.includes('3 projects searched, 0 skipped'), 'the fan-out is accounted for')
})

test('an empty broad result reports how many projects were searched and skipped', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const { ctx, tool } = setup(
    [okResult(VERSION_STDOUT), okResult('[]'), okResult('[]'), okResult('[]')],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )

  const text = await search(tool, ctx, { query: 'nothing ever written', scope: 'all' })

  ok(text.includes('No memories found for "nothing ever written" across 3 projects searched, 0 skipped.'))
})

test('scope project behaves exactly like the default single-project search', async () => {
  const scanRoot = seedScanRoot(['alpha'])
  const { calls, ctx, root, tool } = setup(
    [okResult(VERSION_STDOUT), okResult('[]')],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )

  const text = await search(tool, ctx, { query: 'redis', scope: 'project' })

  equal(calls.length, 2)
  deepEqual(calls[1]?.args.slice(2), [
    'memsearch',
    'search',
    '-j',
    '-k',
    '5',
    '-c',
    deriveCollection(root),
    '--',
    'redis',
  ])
  ok(text.includes('No memories found for "redis".'), 'the project-scoped empty message is untouched')
})

test('every fan-out invocation honors the search timeout override', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const { calls, ctx, tool } = setup(
    [okResult(VERSION_STDOUT), okResult('[]'), okResult('[]'), okResult('[]')],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot, PI_MEMSEARCH_SEARCH_TIMEOUT_MS: '45000' } },
  )

  await search(tool, ctx, { query: 'redis', scope: 'all' })

  for (const call of calls.slice(1)) equal(call.options.timeoutMs, 45_000)
})

test('a current project under a scan root is searched once', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const alpha = join(scanRoot, 'alpha')
  const beta = join(scanRoot, 'beta')
  const { calls, tools } = setupExtension(
    [okResult(VERSION_STDOUT), okResult('[]'), okResult('[]')],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot }, prefix: 'cross-repo-dedupe-' },
  )
  const tool = tools.get('memory_search')
  ok(tool)
  const ctx = createFakeContext({ cwd: alpha, session: TEST_SESSION })

  await search(tool, ctx, { query: 'redis', scope: 'all' })

  equal(calls.length, 3)
  equal(calls[1]?.args.includes(deriveCollection(alpha)), true)
  equal(calls[2]?.args.includes(deriveCollection(beta)), true)
})

test('a store scoped by MEMSEARCH_DIR is labeled by its searched dir, not a parsed source path', async () => {
  const scanRoot = seedScanRoot(['alpha'])
  let projectRoot = ''
  const { ctx, root, tool } = setup(
    [
      okResult(VERSION_STDOUT),
      () => Promise.resolve(okResult(JSON.stringify([projectHit(projectRoot, 0.9, 'aaaa000000000001')]))),
      okResult('[]'),
    ],
    { env: { MEMSEARCH_DIR: '.memsearch', PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )
  projectRoot = root
  const scopeDir = join(root, '.memsearch')

  const text = await search(tool, ctx, { query: 'redis', scope: 'all' })

  ok(text.includes(`| ${scopeDir} |`), 'the label is the dir whose collection was searched')
  ok(!text.includes(`| ${root} |`), 'the label is never re-derived from the source path')
})

test('an unreadable scan root fails fast instead of silently searching nothing', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'cross-repo-gone-')), 'nope')
  const { calls, ctx, tool } = setup([], { env: { PI_MEMSEARCH_SCAN_ROOTS: missing } })

  await rejects(
    () => search(tool, ctx, { query: 'redis', scope: 'all' }),
    (error: unknown) =>
      error instanceof Error && error.message.includes(missing) && error.message.includes('PI_MEMSEARCH_SCAN_ROOTS'),
  )

  equal(calls.length, 0)
})

test('top_k caps the merged cross-repo result, not just each project', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const alpha = join(scanRoot, 'alpha')
  const beta = join(scanRoot, 'beta')
  const { calls, ctx, tool } = setup(
    [
      okResult(VERSION_STDOUT),
      okResult(JSON.stringify([projectHit('/anywhere', 0.9, 'aaaa000000000001')])),
      okResult(
        JSON.stringify([projectHit(alpha, 1.0, 'bbbb000000000002'), projectHit(alpha, 0.4, 'cccc000000000003')]),
      ),
      okResult(JSON.stringify([projectHit(beta, 0.7, 'dddd000000000004')])),
    ],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )

  const text = await search(tool, ctx, { query: 'redis', scope: 'all', top_k: 2 })

  ok(calls[1]?.args.join(' ').includes('-k 2'))
  ok(text.includes('2 memory chunk(s)'))
  ok(text.includes('chunk bbbb000000000002'))
  ok(text.includes('chunk aaaa000000000001'))
  ok(!text.includes('chunk dddd000000000004'), 'hits beyond top_k are dropped after the merge')
})

test('a project whose collection was never indexed is skipped and counted, not fatal', async () => {
  const scanRoot = seedScanRoot(['alpha', 'beta'])
  const alpha = join(scanRoot, 'alpha')
  const beta = join(scanRoot, 'beta')
  const { ctx, tool } = setup(
    [
      okResult(VERSION_STDOUT),
      okResult('[]'),
      errResult(1, MISSING_COLLECTION_STDERR),
      okResult(JSON.stringify([projectHit(beta, 0.7, 'dddd000000000004')])),
    ],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )

  const text = await search(tool, ctx, { query: 'redis', scope: 'all' })

  ok(text.includes('2 projects searched, 1 skipped'))
  ok(text.includes(`skipped (never indexed on this machine): ${alpha}`))
  ok(text.includes('chunk dddd000000000004'), 'projects after the skipped one are still searched')
})

test('a cross-repo search queued behind memory compaction still gets one queued note', async () => {
  const scanRoot = seedScanRoot(['alpha'])
  let releaseCompact: () => void = () => {}
  let notifyStarted: () => void = () => {}
  const compactStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const gatedCompact: FakeExecStep = () => {
    notifyStarted()
    return new Promise<ExecResult>((resolve) => {
      releaseCompact = () => resolve(okResult(COMPACT_STDOUT))
    })
  }
  const { ctx, tool, tools } = setup(
    [okResult(VERSION_STDOUT), gatedCompact, okResult('[]'), okResult('[]')],
    { env: { PI_MEMSEARCH_SCAN_ROOTS: scanRoot } },
  )
  const compactTool = tools.get('memory_compact')
  ok(compactTool, 'memory_compact tool is registered')

  const compacting = compactTool.execute('call-1', {}, undefined, undefined, ctx)
  await compactStarted
  const notes: string[] = []
  const searching = tool.execute('call-2', { query: 'redis', scope: 'all' }, undefined, (update) => {
    const first = update.content[0]
    if (first?.type === 'text') notes.push(first.text)
  }, ctx)
  await new Promise((resolve) => setImmediate(resolve))
  releaseCompact()
  await compacting
  await searching

  deepEqual(
    notes.filter((note) => note === 'waiting on memory compaction'),
    ['waiting on memory compaction'],
    'exactly one queued note across the whole fan-out',
  )
})
