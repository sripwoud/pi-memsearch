import { equal, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { parseIndexedChunks } from '../src/contract.ts'

test('parseIndexedChunks reads the count from index output', () => {
  equal(parseIndexedChunks('Indexed 12 chunks.\n'), 12)
  equal(parseIndexedChunks('Indexed 0 chunks.\n'), 0)
})

test('parseIndexedChunks fails loudly on drifted output', () => {
  throws(() => parseIndexedChunks('Done.\n'), /index output drifted/)
})
