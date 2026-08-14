import { deepEqual, ok } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('pi manifest declares only the entry extension', () => {
  deepEqual(pkg.pi.extensions, ['./extensions/memsearch.ts'])
})

test('pi manifest declares the recall surface directories', () => {
  deepEqual(pkg.pi.skills, ['./skills'])
  deepEqual(pkg.pi.prompts, ['./prompts'])
  ok(pkg.files.includes('skills'))
  ok(pkg.files.includes('prompts'))
})

test('internal modules ship with the package', () => {
  ok(pkg.files.includes('src'))
})
