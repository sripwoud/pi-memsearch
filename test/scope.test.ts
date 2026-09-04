import { equal, match, ok } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deriveCollection,
  resolveCollection,
  resolveProjectScope,
  resolveRepositoryDir,
  resolveStateDir,
  STORE_CMD_ENV,
} from '../src/scope.ts'
import { answeringStore, storeCommand } from './harness.ts'

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
  ['/home/user/code/pi-memsearch.3', 'ms_pi_memsearch_3_a1b79a60'],
  ['/tmp/über-app', 'ms_ber_app_c7d538d4'],
]

test('deriveCollection matches memsearch shell derivation byte-for-byte', () => {
  for (const [path, collection] of VECTORS) equal(deriveCollection(path), collection)
})

test('a symlinked project dir derives the target collection, like realpath -m', () => {
  const target = mkdtempSync(join(tmpdir(), 'scope-target-'))
  const link = join(mkdtempSync(join(tmpdir(), 'scope-link-')), 'aliased')
  symlinkSync(target, link)
  equal(deriveCollection(link), deriveCollection(target))
})

test('MEMSEARCH_DIR overrides scope and holds the memory dir directly', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-'))
  const scope = resolveProjectScope({ baseDir: base, env: { MEMSEARCH_DIR: '/shared/memsearch' } })
  equal(scope.dir, '/shared/memsearch')
  equal(scope.memoryDir, '/shared/memsearch/memory')
})

test('a relative MEMSEARCH_DIR resolves at the repository, where the memsearch child reads it', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  mkdirSync(join(root, '.git'))
  const nested = join(root, 'packages', 'core')
  mkdirSync(nested, { recursive: true })

  const scope = resolveProjectScope({ baseDir: nested, env: { MEMSEARCH_DIR: '.memsearch' } })

  equal(scope.dir, join(root, '.memsearch'))
  equal(scope.memoryDir, join(root, '.memsearch', 'memory'))
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

test('repository dir is the git root of a nested directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  mkdirSync(join(root, '.git'))
  const nested = join(root, 'packages', 'core')
  mkdirSync(nested, { recursive: true })
  equal(resolveRepositoryDir(nested), root)
})

test('repository dir falls back to the directory itself outside any git repo', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-'))
  equal(resolveRepositoryDir(base), base)
})

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  return 'no error was thrown'
}

function gitDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  mkdirSync(join(root, '.git'))
  return root
}

function worktreeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'scope-'))
  writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n')
  return root
}

test('the store command owns the memory dir and the collection, whatever the directory is', () => {
  const command = answeringStore('/central/my-app/memory', 'ms_my_app_62c1f414')

  for (const dir of [gitDir(), worktreeDir(), mkdtempSync(join(tmpdir(), 'scope-'))]) {
    const env = { [STORE_CMD_ENV]: command }
    const scope = resolveProjectScope({ baseDir: dir, env })
    equal(scope.memoryDir, '/central/my-app/memory')
    equal(scope.dir, '/central/my-app')
    equal(resolveCollection({ baseDir: dir, env }), 'ms_my_app_62c1f414')
  }
})

test('the store command wins over MEMSEARCH_DIR', () => {
  const command = answeringStore('/central/my-app/memory', 'ms_my_app_62c1f414')
  const env = { MEMSEARCH_DIR: '/shared/memsearch', [STORE_CMD_ENV]: command }

  const scope = resolveProjectScope({ baseDir: gitDir(), env })

  equal(scope.memoryDir, '/central/my-app/memory')
})

test('the store command runs with the working directory set to the directory being resolved', () => {
  const command = storeCommand('echo "$(pwd -P)/$1"')
  const dir = gitDir()

  const scope = resolveProjectScope({ baseDir: dir, env: { [STORE_CMD_ENV]: command } })

  equal(scope.memoryDir, join(realpathSync(dir), 'memory-dir'))
})

test('a non-zero exit from the store command names the command, the mode and the stderr', () => {
  const command = storeCommand('echo "no store for you" >&2\nexit 3')

  const message = messageOf(() => resolveProjectScope({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  ok(message.includes(STORE_CMD_ENV) && message.includes(command) && message.includes('memory-dir'))
  match(message, /exited 3: no store for you/)
})

test('empty output from the store command is an error, not an empty scope', () => {
  const command = storeCommand('exit 0')

  const message = messageOf(() => resolveCollection({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  ok(message.includes(command) && message.includes('collection'))
  match(message, /printed nothing/)
})

test('a relative memory dir from the store command is an error, not resolved against the cwd', () => {
  const command = answeringStore('central/my-app/memory', 'ms_my_app_62c1f414')

  const message = messageOf(() => resolveProjectScope({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  match(message, /must print an absolute path, got "central\/my-app\/memory"/)
})

test('a store command that cannot be run names itself in the failure', () => {
  const command = join(mkdtempSync(join(tmpdir(), 'store-cmd-')), 'missing-resolver')

  const message = messageOf(() => resolveProjectScope({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  ok(message.includes(command))
  match(message, /failed to run/)
})

test('the store command runs once per mode and directory for the life of the process', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'store-log-')), 'runs')
  const command = storeCommand(`echo "$1" >> '${log}'\necho ms_my_app_62c1f414`)
  const dir = gitDir()
  const env = { [STORE_CMD_ENV]: command }

  for (let attempt = 0; attempt < 3; attempt++) {
    resolveCollection({ baseDir: dir, env })
    resolveCollection({ baseDir: join(dir, '.'), env })
  }

  equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
})

test('the store command owns the index-state dir when it answers state-dir', () => {
  const command = answeringStore('/central/my-app', 'ms_my_app_62c1f414', '/state/ms_my_app_62c1f414')
  const env = { MEMSEARCH_DIR: '/shared/memsearch', [STORE_CMD_ENV]: command }

  equal(resolveStateDir({ baseDir: gitDir(), env }), '/state/ms_my_app_62c1f414')
})

test('a store command that does not implement state-dir yields no answer, not an error', () => {
  const command = answeringStore('/central/my-app', 'ms_my_app_62c1f414')

  equal(resolveStateDir({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }), undefined)
})

test('no store command means no delegated state dir', () => {
  equal(resolveStateDir({ baseDir: gitDir(), env: {} }), undefined)
})

test('a non-zero exit from state-dir fails fast, like memory-dir', () => {
  const command = storeCommand('echo "no state for you" >&2\nexit 4')

  const message = messageOf(() => resolveStateDir({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  ok(message.includes(STORE_CMD_ENV) && message.includes(command) && message.includes('state-dir'))
  match(message, /exited 4: no state for you/)
})

test('a relative state dir from the store command is an error, not resolved against the cwd', () => {
  const command = answeringStore('/central/my-app', 'ms_my_app_62c1f414', 'state/my-app')

  const message = messageOf(() => resolveStateDir({ baseDir: gitDir(), env: { [STORE_CMD_ENV]: command } }))

  match(message, /must print an absolute path, got "state\/my-app"/)
})

test('state-dir is asked once per directory for the life of the process', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'store-log-')), 'runs')
  const command = storeCommand(`echo "$1" >> '${log}'\ntest "$1" = state-dir && echo /state/my-app`)
  const dir = gitDir()
  const env = { [STORE_CMD_ENV]: command }

  for (let attempt = 0; attempt < 3; attempt++) {
    resolveStateDir({ baseDir: dir, env })
    resolveStateDir({ baseDir: join(dir, '.'), env })
  }

  equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
})
