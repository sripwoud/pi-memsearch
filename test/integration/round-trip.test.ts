import { equal, match, ok } from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readIndexState } from '../../src/index-state.ts'
import { localDateKey } from '../../src/memory-file.ts'
import { assistantEntry, TEST_SESSION, userEntry } from '../harness.ts'
import { setupLive, SKIP_UNLESS_GATED } from './live.ts'

const BULLETS = [
  '- the user and the agent chose Milvus Lite over a Milvus server for the flux-capacitor cache',
  '- the agent set the flux-capacitor eviction policy to LRU with a five minute TTL',
]
  .join('\n')

describe('capture to recall against real memsearch', { skip: SKIP_UNLESS_GATED }, () => {
  const live = setupLive({ complete: async () => BULLETS })
  let chunkHash: string | undefined

  test('session start bootstraps the zero-key onnx provider', async () => {
    await live.fire('session_start')
    await live.settle()

    const config = join(live.home, '.memsearch', 'config.toml')
    ok(existsSync(config), 'bootstrap wrote the global memsearch config')
    match(readFileSync(config, 'utf8'), /provider = "onnx"/)
  })

  test('searching an empty memory store says so plainly', async () => {
    const text = await live.toolText('memory_search', { query: 'anything at all' })

    match(text, /No memories found/)
  })

  test('a settled exchange is distilled into the daily memory file', async () => {
    live.branch.push(
      userEntry('u1', 'why did we pick milvus lite for the flux-capacitor cache?'),
      assistantEntry('a1', 'Because the mesh runs single-node and Lite needs no server.'),
    )

    await live.fire('agent_settled')
    await live.settle()

    const file = join(live.memoryDir, `${localDateKey(new Date())}.md`)
    const content = readFileSync(file, 'utf8')
    ok(content.includes(BULLETS), 'the distilled bullets landed in the daily memory file')
    ok(content.includes(`<!-- session:${TEST_SESSION.sessionId} turn:a1 transcript:${TEST_SESSION.transcriptPath} -->`))
  })

  test('shutdown indexes the memory store without partial failures', async () => {
    await live.fire('session_shutdown')

    const state = readIndexState(live.memoryDir)
    ok(state, 'memsearch wrote an index-state file')
    equal(state.status, 'ok')
    equal(state.failedFiles.length, 0)
  })

  test('search recalls the captured memory from a paraphrased query', async () => {
    const text = await live.toolText('memory_search', {
      query: 'which vector database did we settle on for the flux-capacitor cache?',
    })

    ok(text.includes('flux-capacitor'), `search returned no matching chunk:\n${text}`)
    ok(text.includes(join(live.memoryDir, `${localDateKey(new Date())}.md`)))
    chunkHash = /\| chunk (\S+) \|/.exec(text)?.[1]
    ok(chunkHash, 'search rendered a chunk hash to expand')
  })

  test('expand returns the full section with the session anchor', async () => {
    ok(chunkHash, 'the search step produced a chunk hash')
    const text = await live.toolText('memory_expand', { chunk_hash: chunkHash })

    ok(text.includes(BULLETS), `expand returned an unexpected section:\n${text}`)
    ok(text.includes(`origin: session ${TEST_SESSION.sessionId} entry a1`))
    ok(text.includes(`transcript: ${TEST_SESSION.transcriptPath}`))
  })

  test('status reports the backend, the collection and the indexed chunks', async () => {
    const text = await live.toolText('memory_status', {})

    match(text, /backend: available/)
    match(text, /memsearch: 0\.4\.\d+ \(pinned memsearch\[onnx\]/)
    ok(text.includes(`collection: ${live.collection}`))
    match(text, /index: ok/)
    match(text, /indexed chunks: [1-9]\d*/)
  })
})
