import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MEMSEARCH_SPEC } from '../../src/contract.ts'
import { execProcess } from '../../src/exec.ts'
import { readIndexState } from '../../src/index-state.ts'
import { spawnSidecarProcess } from '../../src/sidecar.ts'
import { assistantEntry, findInjectedMessage, type InjectedMessage, userEntry } from '../harness.ts'
import { setupLive, SKIP_UNLESS_GATED } from './live.ts'

const SIDECAR_SCRIPT = fileURLToPath(new URL('../../src/sidecar.py', import.meta.url))

// Auto-context is what this suite exercises; the snapshot is disabled so today's capture
// is not dropped as a snapshot duplicate before it can prove the injection path.
process.env['PI_MEMSEARCH_AUTO_CONTEXT'] = 'on'
process.env['PI_MEMSEARCH_SNAPSHOT'] = 'off'

const BULLETS = [
  '- the user and the agent sized the tachyon buffer pool at 512 slots after load testing',
  '- the agent made the tachyon buffer eviction policy FIFO to keep replay order stable',
]
  .join('\n')

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('sidecar contract against the pinned memsearch', { skip: SKIP_UNLESS_GATED }, () => {
  test('the memsearch internals the sidecar imports resolve inside the pinned environment', async () => {
    const result = await execProcess(
      'uv',
      ['run', '--no-project', '--with', MEMSEARCH_SPEC, 'python', SIDECAR_SCRIPT, '--probe'],
      { timeoutMs: 180_000 },
    )
    equal(result.exitCode, 0, `probe failed:\n${result.stderr}`)
    match(result.stdout, /probe-ok/)
  })
})

describe('auto-context against real memsearch', { skip: SKIP_UNLESS_GATED }, () => {
  const live = setupLive({ complete: async () => BULLETS })
  let injected: InjectedMessage | undefined

  test('a captured exchange is indexed at shutdown', async () => {
    await live.fire('session_start')
    await live.settle()
    live.branch.push(
      userEntry('u1', 'how big should the tachyon buffer pool be?'),
      assistantEntry('a1', '512 slots, FIFO eviction, per the load tests.'),
    )
    await live.fire('agent_settled')
    await live.settle()
    await live.fire('session_shutdown')

    const state = readIndexState(live.memoryDir)
    equal(state?.status, 'ok')
  })

  test('the next session warms the sidecar and injects on a prompt', async () => {
    await live.fire('session_start')

    const warmDeadline = Date.now() + 240_000
    while (Date.now() < warmDeadline) {
      const status = await live.toolText('memory_status', {})
      if (/auto-context: on \(warm[,)]/.test(status)) break
      ok(!status.includes('gave-up'), `the sidecar gave up while warming:\n${status}`)
      await wait(500)
    }

    const promptDeadline = Date.now() + 60_000
    while (injected === undefined && Date.now() < promptDeadline) {
      const results = await live.fire('before_agent_start', {
        prompt: 'what did we decide about the tachyon buffer pool?',
        systemPrompt: 'sys',
      })
      injected = findInjectedMessage(results)
      if (injected === undefined) {
        const status = await live.toolText('memory_status', {})
        ok(!status.includes('gave-up'), `the sidecar gave up while prompting:\n${status}`)
        await wait(500)
      }
    }

    ok(injected, 'a prompt was answered with an injected custom message')
    equal(injected.customType, 'memsearch-auto-context')
    equal(injected.display, false)
    ok(injected.content.includes('tachyon'), `injected content misses the capture:\n${injected.content}`)
  })

  test('the injected chunk hash chains into memory_expand', async () => {
    ok(injected, 'the injection step produced a message')
    const chunkHash = /\| chunk (\S+) \|/.exec(injected.content)?.[1]
    ok(chunkHash, `no chunk hash in the injected block:\n${injected.content}`)

    const text = await live.toolText('memory_expand', { chunk_hash: chunkHash })

    ok(text.includes('tachyon buffer'), `expand returned an unexpected section:\n${text}`)
  })

  test('memory_status reports the warm sidecar and the injection counters', async () => {
    const text = await live.toolText('memory_status', {})

    match(text, /auto-context: on \(warm, provider onnx, model \S+\)/)
    match(text, /auto-context prompts: \d+ seen, [1-9]\d* injected/)
    match(text, /auto-context last injection: \d+ms/)
  })

  test('shutdown ends the sidecar with the session', async () => {
    await live.fire('session_shutdown')
  })

  test('a never-indexed collection yields empty hits, not an error', async () => {
    const proc = spawnSidecarProcess(
      'uv',
      ['run', '--no-project', '--with', MEMSEARCH_SPEC, 'python', SIDECAR_SCRIPT],
      { cwd: live.home },
    )
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no reply from the raw sidecar within 240s')), 240_000)
        proc.onExit(() => {
          clearTimeout(timer)
          reject(new Error('the raw sidecar exited before replying'))
        })
        proc.onLine((line) => {
          let data: unknown
          try {
            data = JSON.parse(line)
          } catch {
            return
          }
          const record = data as Record<string, unknown>
          if (record['event'] === 'ready') {
            proc.send(JSON.stringify({ collection: 'ms_never_indexed_00000000', id: 1, query: 'anything', top_k: 3 }))
            return
          }
          if (record['id'] === 1) {
            clearTimeout(timer)
            resolve(record)
          }
        })
      })
      deepEqual(reply, { hits: [], id: 1 })
    } finally {
      proc.end()
    }
  })
})
