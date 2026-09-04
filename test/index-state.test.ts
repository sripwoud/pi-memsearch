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

test('MEMSEARCH_DIR gives a delegated store a state path even outside a .memsearch tree', () => {
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

test('the state path is the .memsearch tree root, not the store parent, at any depth', () => {
  const store = mkdtempSync(join(tmpdir(), 'index-state-'))
  const tree = join(store, '.memsearch')
  const env = { PI_MEMSEARCH_STORE_CMD: '/bin/true' }
  const expected = join(tree, '.index-state.json')

  equal(indexStatePath(join(tree, 'memory'), { baseDir: store, env }), expected)
  equal(indexStatePath(join(tree, 'stores', 'pi'), { baseDir: store, env }), expected)
  equal(indexStatePath(join(tree, 'a', 'b', 'c'), { baseDir: store, env }), expected)
  equal(indexStatePath(tree, { baseDir: store, env }), expected)
})
