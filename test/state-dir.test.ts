import { deepEqual, equal, ok } from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { okResult, SEARCH_JSON, VERSION_STDOUT } from './fixtures.ts'
import { answeringStore, type FakeSidecarPlan, setupExtension } from './harness.ts'

const STATE_DIR = '/state/ms_pi_deadbeef'

const silentPlan: FakeSidecarPlan = () => {}

function delegating(stateDir?: string): NodeJS.ProcessEnv {
  const central = mkdtempSync(join(tmpdir(), 'state-dir-central-'))
  return { PI_MEMSEARCH_STORE_CMD: answeringStore(join(central, 'pi'), 'ms_pi_deadbeef', stateDir) }
}

async function search(harness: ReturnType<typeof setupExtension>): Promise<void> {
  const tool = harness.tools.get('memory_search')
  ok(tool, 'memory_search tool is registered')
  await tool.execute('call-1', { query: 'redis' }, undefined, undefined, harness.ctx)
}

test('the state-dir answer reaches every memsearch child as MEMSEARCH_DIR', async () => {
  const harness = setupExtension([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], {
    env: delegating(STATE_DIR),
    prefix: 'state-dir-',
  })

  await harness.fire('session_start', {}, harness.ctx)
  await search(harness)

  equal(harness.calls.length, 2)
  for (const call of harness.calls) deepEqual(call.options.env, { MEMSEARCH_DIR: STATE_DIR })
})

test('a store command without state-dir leaves the child environment untouched', async () => {
  const harness = setupExtension([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], {
    env: delegating(),
    prefix: 'state-dir-',
  })

  await harness.fire('session_start', {}, harness.ctx)
  await search(harness)

  for (const call of harness.calls) equal(call.options.env, undefined)
})

test('no store command leaves the child environment untouched', async () => {
  const harness = setupExtension([okResult(VERSION_STDOUT), okResult(SEARCH_JSON)], { prefix: 'state-dir-' })

  await harness.fire('session_start', {}, harness.ctx)
  await search(harness)

  for (const call of harness.calls) equal(call.options.env, undefined)
})

test('the sidecar inherits the state dir too', async () => {
  const harness = setupExtension([], {
    env: { ...delegating(STATE_DIR), PI_MEMSEARCH_AUTO_CONTEXT: 'on' },
    prefix: 'state-dir-',
    sidecarPlans: [silentPlan],
  })

  await harness.fire('session_start', {}, harness.ctx)

  deepEqual(harness.spawns[0]?.options.env, { MEMSEARCH_DIR: STATE_DIR })
})
