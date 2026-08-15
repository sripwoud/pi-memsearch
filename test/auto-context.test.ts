import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { MEMSEARCH_SPEC, type SearchHit } from '../src/contract.ts'
import { deriveCollection } from '../src/scope.ts'
import { okResult, SEARCH_HITS, STATS_STDOUT, VERSION_STDOUT } from './fixtures.ts'
import { type FakeExecStep, type FakeSidecarPlan, setupExtension, type SetupOptions } from './harness.ts'

const AUTO_ON = { PI_MEMSEARCH_AUTO_CONTEXT: 'on' }

const injectingPlan: FakeSidecarPlan = (sidecar) => {
  sidecar.ready({ model: 'bge-m3', provider: 'onnx' })
  sidecar.onRequest((request) => sidecar.reply({ hits: SEARCH_HITS, id: request['id'] }))
}

const silentPlan: FakeSidecarPlan = () => {}

const warmButSilentPlan: FakeSidecarPlan = (sidecar) => {
  sidecar.ready()
}

function setup(options: SetupOptions = {}, steps: FakeExecStep[] = []) {
  return setupExtension(steps, { prefix: 'auto-context-', ...options })
}

type Harness = ReturnType<typeof setup>

interface InjectedMessage {
  content: string
  customType: string
  display: boolean
}

function findMessage(results: unknown[]): InjectedMessage | undefined {
  for (const result of results) {
    const message = (result as { message?: InjectedMessage } | undefined)?.message
    if (message) return message
  }
  return undefined
}

async function prompt(harness: Harness, text: string): Promise<InjectedMessage | undefined> {
  return findMessage(await harness.fire('before_agent_start', { prompt: text, systemPrompt: 'sys' }, harness.ctx))
}

test('stays inert without PI_MEMSEARCH_AUTO_CONTEXT=on', async () => {
  const harness = setup()

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything at all')

  equal(harness.spawns.length, 0)
  equal(message, undefined)
})

test('spawns the sidecar eagerly at session start via uv with the pinned spec', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [() => {}] })

  await harness.fire('session_start', {}, harness.ctx)

  equal(harness.spawns.length, 1)
  const spawn = harness.spawns[0]
  equal(spawn?.command, 'uv')
  deepEqual(spawn?.args.slice(0, 5), ['run', '--no-project', '--with', MEMSEARCH_SPEC, 'python'])
  const script = spawn?.args[5] ?? ''
  ok(script.endsWith('sidecar.py'), `expected the sidecar script, got ${script}`)
  ok(existsSync(script), 'the spawned script ships with the package')
  equal(spawn?.options.cwd, harness.root)
})

test('injects an invisible custom message with the top chunks', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] })

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'what cache did we pick?')

  ok(message, 'the prompt got a custom message')
  equal(message.customType, 'memsearch-auto-context')
  equal(message.display, false)
  ok(message.content.includes('6c64e3b992dade38'))
  ok(message.content.includes('Decided to use Redis'))
  ok(message.content.includes('a1b2c3d4e5f60718'))
  match(message.content, /stale/)
  match(message.content, /memory_expand/)
})

test('sends one search request per prompt against the project collection', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] })

  await harness.fire('session_start', {}, harness.ctx)
  await prompt(harness, 'what cache did we pick?')

  deepEqual(harness.sidecars[0]?.requests, [
    { collection: deriveCollection(harness.root), id: 1, query: 'what cache did we pick?', top_k: 3 },
  ])
})

test('session shutdown closes the sidecar stdin so it exits on its own', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] })

  await harness.fire('session_start', {}, harness.ctx)
  await harness.fire('session_shutdown', {}, harness.ctx)

  equal(harness.sidecars[0]?.ended, true)
})

async function statusText(harness: Harness): Promise<string> {
  const tool = harness.tools.get('memory_status')
  ok(tool, 'memory_status tool is registered')
  const result = await tool.execute('status-1', {}, undefined, undefined, harness.ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

const STATUS_STEPS: FakeExecStep[] = [okResult(VERSION_STDOUT), okResult(STATS_STDOUT)]

function scoredHit(chunkHash: string, score: number, content: string): SearchHit {
  return {
    chunk_hash: chunkHash,
    content,
    end_line: 6,
    heading: 'Redis',
    heading_level: 2,
    score,
    source: '/home/user/project/.memsearch/memory/2026-08-13.md',
    start_line: 3,
  }
}

test('a reply missing the 300ms budget skips injection for that prompt', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [warmButSilentPlan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  equal(message, undefined)
  match(await statusText(harness), /1 seen, 0 injected, 1 skipped-budget/)
})

test('empty results inject nothing', async () => {
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) => sidecar.reply({ hits: [], id: request['id'] }))
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  equal(message, undefined)
  match(await statusText(harness), /1 seen, 0 injected, 0 skipped-budget, 1 skipped-empty/)
})

test('chunks below the score floor are dropped', async () => {
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) =>
      sidecar.reply({
        hits: [scoredHit('aboveflo00000001', 0.62, 'kept chunk'), scoredHit('belowflo00000002', 0.49, 'dropped chunk')],
        id: request['id'],
      })
    )
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] })

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  ok(message)
  ok(message.content.includes('aboveflo00000001'))
  ok(!message.content.includes('belowflo00000002'))
})

test('nothing is injected when no chunk clears the score floor', async () => {
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) =>
      sidecar.reply({ hits: [scoredHit('belowflo00000002', 0.3, 'dropped chunk')], id: request['id'] })
    )
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  equal(message, undefined)
  match(await statusText(harness), /1 skipped-empty/)
})

test('chunks already verbatim in the stable snapshot are dropped', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] })
  const memoryDir = join(harness.root, '.memsearch', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const duplicated = SEARCH_HITS[0]?.content ?? ''
  writeFileSync(join(memoryDir, '2026-08-13.md'), `## Session 22:00\n\n${duplicated}\n`)

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'what cache did we pick?')

  ok(message)
  ok(!message.content.includes('6c64e3b992dade38'), 'the snapshot-duplicated chunk was dropped')
  ok(message.content.includes('a1b2c3d4e5f60718'), 'the fresh chunk stayed')
})

test('the injected block stays within the character budget', async () => {
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) =>
      sidecar.reply({
        hits: [
          scoredHit('bigchunk00000001', 0.9, 'a'.repeat(1400)),
          scoredHit('bigchunk00000002', 0.8, 'b'.repeat(1400)),
        ],
        id: request['id'],
      })
    )
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] })

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  ok(message)
  ok(message.content.includes('bigchunk00000001'))
  ok(!message.content.includes('bigchunk00000002'), 'the second block would blow the budget')
})

test('the query is the raw prompt truncated to 500 characters', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] })

  await harness.fire('session_start', {}, harness.ctx)
  const long = 'x'.repeat(600)
  await prompt(harness, long)

  equal(harness.sidecars[0]?.requests[0]?.['query'], 'x'.repeat(500))
})

test('a sidecar error reply degrades to no injection', async () => {
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) =>
      sidecar.reply({
        error: "RuntimeError: another process holds the lock on '/home/user/.memsearch/milvus.db'",
        id: request['id'],
      })
    )
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  const message = await prompt(harness, 'anything')

  equal(message, undefined)
  match(await statusText(harness), /1 seen, 0 injected, 0 skipped-budget, 0 skipped-empty, 1 skipped-error/)
})

test('a crashed sidecar respawns lazily on the next prompt, capped at two respawns', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan, silentPlan, silentPlan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  ok(await prompt(harness, 'first'), 'the warm sidecar injects')

  harness.sidecars[0]?.exit()
  equal(await prompt(harness, 'second'), undefined)
  equal(harness.spawns.length, 2, 'the first crash respawned lazily')

  harness.sidecars[1]?.exit()
  equal(await prompt(harness, 'third'), undefined)
  equal(harness.spawns.length, 3, 'the second crash respawned lazily')

  harness.sidecars[2]?.exit()
  equal(await prompt(harness, 'fourth'), undefined)
  equal(harness.spawns.length, 3, 'past the cap no further sidecar spawns')
  match(await statusText(harness), /gave-up/)
})

test('three consecutive timeouts count as a crash', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [warmButSilentPlan, silentPlan] })

  await harness.fire('session_start', {}, harness.ctx)
  await prompt(harness, 'one')
  await prompt(harness, 'two')
  equal(harness.sidecars[0]?.killed, false)
  await prompt(harness, 'three')

  equal(harness.sidecars[0]?.killed, true, 'the unresponsive sidecar was killed')
  await prompt(harness, 'four')
  equal(harness.spawns.length, 2, 'the next prompt respawned lazily')
})

test('a served reply resets the consecutive timeout count', async () => {
  let seen = 0
  const plan: FakeSidecarPlan = (sidecar) => {
    sidecar.ready()
    sidecar.onRequest((request) => {
      seen++
      if (seen === 3) sidecar.reply({ hits: [], id: request['id'] })
    })
  }
  const harness = setup({ env: AUTO_ON, sidecarPlans: [plan] })

  await harness.fire('session_start', {}, harness.ctx)
  for (const text of ['one', 'two', 'three', 'four', 'five']) await prompt(harness, text)

  equal(harness.sidecars[0]?.killed, false, 'two timeouts, a reply, two timeouts never reach the crash threshold')
  equal(harness.spawns.length, 1)
})

test('prompts during warmup skip without counting toward the crash threshold', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [silentPlan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  for (const text of ['one', 'two', 'three', 'four']) equal(await prompt(harness, text), undefined)

  equal(harness.sidecars[0]?.killed, false)
  equal(harness.spawns.length, 1)
  match(await statusText(harness), /auto-context: on \(warming\)/)
  match(await statusText(harness), /4 seen, 0 injected, 4 skipped-budget/)
})

test('memory_status reports auto-context off when the env flag is absent', async () => {
  const harness = setup({}, STATUS_STEPS)

  match(await statusText(harness), /auto-context: off \(set PI_MEMSEARCH_AUTO_CONTEXT=on to enable\)/)
})

test('memory_status reports sidecar state, resolved provider and injection latency', async () => {
  const harness = setup({ env: AUTO_ON, sidecarPlans: [injectingPlan] }, STATUS_STEPS)

  await harness.fire('session_start', {}, harness.ctx)
  ok(await prompt(harness, 'what cache did we pick?'))
  const text = await statusText(harness)

  match(text, /auto-context: on \(warm, provider onnx, model bge-m3\)/)
  match(text, /auto-context prompts: 1 seen, 1 injected, 0 skipped-budget, 0 skipped-empty, 0 skipped-error/)
  match(text, /auto-context last injection: \d+ms/)
})
