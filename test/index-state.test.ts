import { equal } from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { indexStatePath } from '../src/index-state.ts'

test('a store outside a .memsearch tree still has a state path when no store command is in play', () => {
  const store = mkdtempSync(join(tmpdir(), 'index-state-'))
  const memoryDir = join(store, 'pi')

  equal(
    indexStatePath(memoryDir, { baseDir: store, env: {} }),
    join(store, '.index-state.json'),
  )
})

test('MEMSEARCH_DIR outranks the dead-path check, so a delegated store keeps its state path', () => {
  const store = mkdtempSync(join(tmpdir(), 'index-state-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'index-state-dir-'))

  equal(
    indexStatePath(join(store, 'pi'), {
      baseDir: store,
      env: { MEMSEARCH_DIR: stateDir, PI_MEMSEARCH_STORE_CMD: '/bin/true' },
    }),
    join(stateDir, '.index-state.json'),
  )
})

test('a store command that declines state-dir, outside a .memsearch tree, has no state path at all', () => {
  const store = mkdtempSync(join(tmpdir(), 'index-state-'))

  equal(
    indexStatePath(join(store, 'pi'), { baseDir: store, env: { PI_MEMSEARCH_STORE_CMD: '/bin/true' } }),
    undefined,
  )
})
