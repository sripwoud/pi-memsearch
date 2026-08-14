import { deepEqual, match, ok } from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// The pi release line this package is tested against. Moving it is a deliberate maintenance act:
// bump the peer floors, install that line, then re-run the integration suite.
const PI_LINE = '0.84'
const ESCAPED_PI_LINE = PI_LINE.replace('.', '\\.')
const PI_FLOOR = new RegExp(`^>=${ESCAPED_PI_LINE}\\.\\d+$`)
const PI_INSTALLED = new RegExp(`^${ESCAPED_PI_LINE}\\.`)

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

test('pi peer dependencies declare the tested floor', () => {
  const piPeers = piPeerEntries()
  ok(piPeers.length > 0, 'the package declares the pi packages it imports as peers')
  for (const [name, range] of piPeers) match(range, PI_FLOOR, `${name} declares the pi ${PI_LINE}.x floor`)
})

test('no peer dependency declares a ceiling', () => {
  // pi bundles its core packages and documents a "*" range (docs/packages.md): a ceiling would make
  // the `npm install` pi runs on a package resolve a stale copy of pi's own core.
  for (const [name, range] of Object.entries<string>(pkg.peerDependencies))
    ok(!range.includes('<') && !range.startsWith('^') && !range.startsWith('~'), `${name} caps pi: ${range}`)
})

test('the installed pi packages are on the tested line', () => {
  for (const [name] of piPeerEntries())
    match(installedVersion(name), PI_INSTALLED, `${name} resolved off the tested line — bump PI_LINE deliberately`)
})

test('every peer dependency is actually imported', () => {
  const srcDir = new URL('../src/', import.meta.url)
  const sources = readdirSync(srcDir)
    .map((file) => readFileSync(new URL(file, srcDir), 'utf8'))
    .join('\n')
  for (const name of Object.keys(pkg.peerDependencies))
    ok(sources.includes(`from '${name}`), `${name} is a peer dependency but nothing in src imports it`)
})

function piPeerEntries(): [string, string][] {
  return Object.entries<string>(pkg.peerDependencies).filter(([name]) => name.startsWith('@earendil-works/'))
}

function installedVersion(name: string): string {
  const manifest = readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')
  return JSON.parse(manifest).version
}
