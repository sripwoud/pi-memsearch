import { equal } from 'node:assert/strict'
import { test } from 'node:test'
import memsearch from '../extensions/memsearch.ts'

test('extension entry point default-exports a factory', () => {
  equal(typeof memsearch, 'function')
})
