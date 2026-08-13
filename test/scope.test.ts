import { equal } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deriveCollection, resolveProjectScope } from '../src/scope.ts'

// Expected values generated with memsearch's plugins/claude-code/scripts/derive-collection.sh
const VECTORS: [path: string, collection: string][] = [
  ['/home/user/my-app', 'ms_my_app_62c1f414'],
  ['/tmp/My App.2024', 'ms_my_app_2024_97af4de9'],
  ['/srv/UPPER_case-Dir', 'ms_upper_case_dir_ac785078'],
  ['/tmp/---weird___name---', 'ms_weird_name_22c76f13'],
  [
    '/data/a-very-long-project-directory-name-that-exceeds-forty-characters-limit',
    'ms_a_very_long_project_directory_name_that__381b27d3',
  ],
  ['/home/sripwoud/code/pi-memsearch.3', 'ms_pi_memsearch_3_6f13ec91'],
  ['/tmp/über-app', 'ms_ber_app_c7d538d4'],
]

test('deriveCollection matches memsearch shell derivation byte-for-byte', () => {
  for (const [path, collection] of VECTORS) equal(deriveCollection(path), collection)
})

test('MEMSEARCH_DIR overrides scope and holds the memory dir directly', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-'))
  const scope = resolveProjectScope({ baseDir: base, env: { MEMSEARCH_DIR: '/shared/memsearch' } })
  equal(scope.dir, '/shared/memsearch')
  equal(scope.memoryDir, '/shared/memsearch/memory')
})

test('scope falls back to the git root from a nested directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  mkdirSync(join(root, '.git'))
  const nested = join(root, 'packages', 'core')
  mkdirSync(nested, { recursive: true })
  const scope = resolveProjectScope({ baseDir: nested, env: {} })
  equal(scope.dir, root)
  equal(scope.memoryDir, join(root, '.memsearch', 'memory'))
})

test('a .git file (worktree) marks the git root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n')
  const scope = resolveProjectScope({ baseDir: root, env: {} })
  equal(scope.dir, root)
})

test('scope falls back to the base dir outside any git repo', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-'))
  const scope = resolveProjectScope({ baseDir: base, env: {} })
  equal(scope.dir, base)
  equal(scope.memoryDir, join(base, '.memsearch', 'memory'))
})
