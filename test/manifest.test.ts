import { deepEqual, match, ok } from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// The pi release line this package is tested against. Moving it is a deliberate maintenance act:
// bump the peer ranges, install that line, then re-run the integration suite.
const PI_LINE = '0.84'

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

test('pi peer dependencies pin the tested version line', () => {
  const peers: [string, string][] = Object.entries(pkg.peerDependencies)
  const piPeers = peers.filter(([name]) => name.startsWith('@earendil-works/'))
  ok(piPeers.length > 0, 'the package declares the pi packages it imports as peers')
  for (const [name, range] of piPeers) {
    match(range, new RegExp(`^\\^${PI_LINE.replace('.', '\\.')}\\.\\d+$`), `${name} pins pi ${PI_LINE}.x`)
    match(installedVersion(name), new RegExp(`^${PI_LINE.replace('.', '\\.')}\\.`), `${name} is tested on that line`)
  }
})

test('no peer dependency floats without a floor', () => {
  for (const [name, range] of Object.entries(pkg.peerDependencies))
    ok(range !== '*', `${name} must declare a tested floor, not "*"`)
})

test('every peer dependency is actually imported', () => {
  const srcDir = new URL('../src/', import.meta.url)
  const sources = readdirSync(srcDir)
    .map((file) => readFileSync(new URL(file, srcDir), 'utf8'))
    .join('\n')
  for (const name of Object.keys(pkg.peerDependencies))
    ok(sources.includes(`from '${name}`), `${name} is a peer dependency but nothing in src imports it`)
})

function installedVersion(name: string): string {
  const manifest = readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')
  return JSON.parse(manifest).version
}
