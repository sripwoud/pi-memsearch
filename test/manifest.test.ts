import { deepEqual, ok } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('pi manifest declares only the entry extension', () => {
  deepEqual(pkg.pi.extensions, ['./extensions/memsearch.ts'])
})

test('internal modules ship with the package', () => {
  ok(pkg.files.includes('src'))
})
