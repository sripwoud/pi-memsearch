import { equal, ok } from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { deriveCollection } from '../src/scope.ts'
import { okResult, SEARCH_JSON, VERSION_STDOUT } from './fixtures.ts'
import { createFakeContext, setupExtension, TEST_SESSION } from './harness.ts'

type Harness = ReturnType<typeof setupExtension>

async function search(harness: Harness, ctx = harness.ctx): Promise<void> {
  const tool = harness.tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  await tool.execute('call-1', { query: 'redis' }, undefined, undefined, ctx)
}

test('CLI children run at the git root when the session starts in a subdirectory', async () => {
  const harness = setupExtension([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], { prefix: 'repository-dir-' })
  const nested = join(harness.root, 'packages', 'core')
  mkdirSync(nested, { recursive: true })
  const ctx = createFakeContext({ cwd: nested, session: TEST_SESSION })

  await harness.fire('session_start', {}, ctx)
  await search(harness, ctx)

  equal(harness.calls.length, 2)
  for (const call of harness.calls) equal(call.options.cwd, harness.root)
})

test('MEMSEARCH_DIR moves the collection but children still run at the repository', async () => {
  const harness = setupExtension([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], {
    env: { MEMSEARCH_DIR: '/shared/memsearch' },
    prefix: 'repository-dir-',
  })

  await harness.fire('session_start', {}, harness.ctx)
  await search(harness)

  const searchCall = harness.calls.find((call) => call.args.includes('search'))
  ok(searchCall, 'a search command ran')
  ok(searchCall.args.includes(deriveCollection('/shared/memsearch')), 'collection derives from the override')
  equal(harness.calls.length, 2)
  for (const call of harness.calls) equal(call.options.cwd, harness.root)
})
