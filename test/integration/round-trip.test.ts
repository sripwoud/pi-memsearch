import { equal, match, ok } from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, test } from 'node:test'
import { MEMSEARCH_SPEC } from '../../src/contract.ts'
import { indexStatePath, readIndexState } from '../../src/index-state.ts'
import { assistantEntry, setEnvVar, TEST_SESSION, userEntry } from '../harness.ts'
import { setupLive, SKIP_UNLESS_GATED } from './live.ts'

const BULLETS = [
  '- the user and the agent chose Milvus Lite over a Milvus server for the flux-capacitor cache',
  '- the agent set the flux-capacitor eviction policy to LRU with a five minute TTL',
]
  .join('\n')

describe('capture to recall against real memsearch', { skip: SKIP_UNLESS_GATED }, () => {
  const live = setupLive({ complete: async () => BULLETS })
  let chunkHash: string | undefined
  let dailyFile: string | undefined

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

    const written = readdirSync(live.memoryDir)
    equal(written.length, 1, `capture wrote one daily file, found ${written.join(', ')}`)
    dailyFile = join(live.memoryDir, written[0] as string)
    const content = readFileSync(dailyFile, 'utf8')
    ok(content.includes(BULLETS), 'the distilled bullets landed in the daily memory file')
    ok(content.includes(`<!-- session:${TEST_SESSION.sessionId} turn:a1 transcript:${TEST_SESSION.transcriptPath} -->`))
  })

  test('shutdown indexes the memory store without partial failures', async () => {
    await live.fire('session_shutdown')

    const state = readIndexState(indexStatePath(live.memoryDir, { baseDir: live.root, env: process.env }))
    ok(state, 'memsearch wrote an index-state file')
    equal(state.status, 'ok')
    equal(state.failedFiles.length, 0)
  })

  test('search recalls the captured memory from a paraphrased query', async () => {
    await live.restartSession()
    const text = await live.toolText('memory_search', {
      query: 'which vector database did we settle on for the flux-capacitor cache?',
    })

    ok(text.includes('flux-capacitor'), `search returned no matching chunk:\n${text}`)
    ok(dailyFile && text.includes(dailyFile), 'the hit points at the daily file capture wrote')
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
    match(text, /memsearch: \d+\.\d+\.\d+ \(pinned /)
    ok(text.includes(`(pinned ${MEMSEARCH_SPEC})`))
    ok(text.includes(`collection: ${live.collection}`))
    match(text, /index: ok/)
    match(text, /indexed chunks: [1-9]\d*/)
  })

  test('memory_forget by chunk hash redacts the entry and search stops returning it', async () => {
    await live.toolText('memory_write', { content: '- the agent tuned the warp drive injectors to seven hertz' })
    await live.fire('session_shutdown')
    await live.restartSession()

    // A write reindexes the day file and re-chunks it, so hashes from before the write are stale;
    // forget must act on a hash from the current index state.
    const found = await live.toolText('memory_search', {
      query: 'which vector database did we settle on for the flux-capacitor cache?',
    })
    ok(found.includes('flux-capacitor'), `search lost the flux-capacitor entry:\n${found}`)
    const freshHash = /\| chunk (\S+) \|/.exec(found)?.[1]
    ok(freshHash, 'search rendered a chunk hash to forget')

    const text = await live.toolText('memory_forget', { chunk_hash: freshHash })

    ok(text.includes(BULLETS), `forget did not echo the removed entry:\n${text}`)
    ok(dailyFile && readFileSync(dailyFile, 'utf8').includes('warp drive'), 'the other entry survived in the day file')
    await live.fire('session_shutdown')
    await live.restartSession()

    const search = await live.toolText('memory_search', {
      query: 'which vector database did we settle on for the flux-capacitor cache?',
    })
    ok(!search.includes('flux-capacitor'), `the redacted entry still surfaces in search:\n${search}`)
  })

  test('memory_forget by date and time deletes an emptied daily file and drains the collection', async () => {
    ok(dailyFile, 'capture produced a daily file')
    const time = /### (\d{2}:\d{2})/.exec(readFileSync(dailyFile, 'utf8'))?.[1]
    ok(time, 'the remaining entry has a timestamp heading')

    const text = await live.toolText('memory_forget', { date: basename(dailyFile, '.md'), time })

    ok(text.includes('warp drive'), `forget did not echo the removed entry:\n${text}`)
    ok(!existsSync(dailyFile), 'the emptied day file was deleted')
    await live.fire('session_shutdown')
    await live.restartSession()

    const search = await live.toolText('memory_search', { query: 'warp drive injector tuning' })
    match(search, /No memories found/)
  })

  test('a non-ASCII memory entry survives recall when the child stdout encoding is not UTF-8', async () => {
    // PYTHONIOENCODING outranks locale coercion and UTF-8 mode in every Python, so an inherited
    // latin-1 stands in for an explicitly non-UTF-8 locale deterministically. It must not be
    // ascii: click treats an ascii stream as misconfigured and force-repairs it to UTF-8.
    const restore = setEnvVar('PYTHONIOENCODING', 'latin-1')
    try {
      const bullet = '- the agent renamed the café tier to “élite” — shipped with a 🚀 emoji'
      await live.toolText('memory_write', { content: bullet })
      await live.fire('session_shutdown')
      await live.restartSession()

      const text = await live.toolText('memory_search', { query: 'what was the café tier renamed to?' })
      ok(text.includes(bullet), `recall lost the non-ASCII entry:\n${text}`)
    } finally {
      restore()
    }
  })
})
