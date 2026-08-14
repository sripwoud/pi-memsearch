import { ok } from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, test } from 'node:test'
import { holdDataDirLock, setupLive, SKIP_UNLESS_GATED, waitForLockedOutAttempt } from './live.ts'

const MEMORY = '- the agent pinned the retry backoff to 200ms, 500ms, 1s and 2s for lock contention'

describe('lock contention against real memsearch', { skip: SKIP_UNLESS_GATED }, () => {
  const live = setupLive()

  test('a memory is written and indexed', async () => {
    await live.fire('session_start')
    await live.settle()
    await live.toolText('memory_write', { content: MEMORY })
    await live.fire('session_shutdown')

    ok(
      existsSync(live.dataDirLockPath),
      `Milvus Lite kept no lock file at ${live.dataDirLockPath}: its internals moved, so this test can no longer hold the lock`,
    )
  })

  test('a search locked out by another process still returns memories', async () => {
    const holder = await holdDataDirLock(live.dataDirLockPath)
    const search = live.toolText('memory_search', { query: 'what is the retry backoff for lock contention?' })

    // Releasing only once an invocation has actually been locked out puts the retry on the critical
    // path deterministically; waitForLockedOutAttempt throws if contention never happens.
    await waitForLockedOutAttempt(live)
    await holder.release()
    const text = await search

    ok(text.includes('retry backoff'), `search did not recall the memory:\n${text}`)
  })
})
