import { deepEqual, equal, ok } from 'node:assert/strict'
import { test } from 'node:test'
import memsearch from '../extensions/memsearch.ts'
import { setupExtension } from './harness.ts'

test('extension entry point default-exports a factory', () => {
  equal(typeof memsearch, 'function')
})

test('registers the six memory tools', () => {
  const { tools } = setupExtension([])

  deepEqual(
    [...tools.keys()].sort(),
    ['memory_compact', 'memory_expand', 'memory_forget', 'memory_search', 'memory_status', 'memory_write'],
  )
})

test('every registered tool declares a non-empty one-line promptSnippet', () => {
  const { tools } = setupExtension([])

  for (const [name, tool] of tools) {
    const snippet = tool.promptSnippet
    ok(typeof snippet === 'string', `${name} declares a promptSnippet`)
    ok(snippet.trim().length > 0, `${name} promptSnippet is non-empty`)
    ok(!snippet.includes('\n'), `${name} promptSnippet is one line`)
  }
})
