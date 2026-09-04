import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const STORE_CMD_ENV = 'PI_MEMSEARCH_STORE_CMD'

export interface ProjectScope {
  dir: string
  memoryDir: string
}

export interface ScopeOptions {
  baseDir: string
  env?: NodeJS.ProcessEnv
}

type StoreMode = 'collection' | 'memory-dir' | 'state-dir'

const storeAnswers = new Map<string, string>()

export function resolveProjectScope({ baseDir, env = process.env }: ScopeOptions): ProjectScope {
  const command = env[STORE_CMD_ENV]
  if (command) {
    const memoryDir = askStoreCommand(command, 'memory-dir', resolve(baseDir))
    return { dir: dirname(memoryDir), memoryDir }
  }
  const override = env['MEMSEARCH_DIR']
  if (override) {
    const dir = resolve(resolveRepositoryDir(baseDir), override)
    return { dir, memoryDir: join(dir, 'memory') }
  }
  const dir = resolveRepositoryDir(baseDir)
  return { dir, memoryDir: join(dir, '.memsearch', 'memory') }
}

export function resolveCollection({ baseDir, env = process.env }: ScopeOptions): string {
  return storeCommandCollection({ baseDir, env }) ?? deriveCollection(resolveProjectScope({ baseDir, env }).dir)
}

export function storeCommandCollection({ baseDir, env = process.env }: ScopeOptions): string | undefined {
  const command = env[STORE_CMD_ENV]
  return command ? askStoreCommand(command, 'collection', resolve(baseDir)) : undefined
}

export function resolveStateDir({ baseDir, env = process.env }: ScopeOptions): string | undefined {
  const command = env[STORE_CMD_ENV]
  if (!command) return undefined
  const answer = askStoreCommand(command, 'state-dir', resolve(baseDir))
  return answer === '' ? undefined : answer
}

function askStoreCommand(command: string, mode: StoreMode, dir: string): string {
  const key = `${command} ${mode} ${dir}`
  const cached = storeAnswers.get(key)
  if (cached !== undefined) return cached
  const run = spawnSync(command, [mode], { cwd: dir, encoding: 'utf8' })
  if (run.error) throw new Error(`${STORE_CMD_ENV} (${command} ${mode}) failed to run: ${run.error.message}`)
  if (run.status !== 0)
    throw new Error(`${STORE_CMD_ENV} (${command} ${mode}) exited ${run.status}: ${run.stderr.trim()}`)
  const answer = run.stdout.trim()
  if (answer === '' && mode !== 'state-dir') throw new Error(`${STORE_CMD_ENV} (${command} ${mode}) printed nothing`)
  if (answer !== '' && (mode === 'memory-dir' || mode === 'state-dir') && !isAbsolute(answer))
    throw new Error(`${STORE_CMD_ENV} (${command} ${mode}) must print an absolute path, got "${answer}"`)
  storeAnswers.set(key, answer)
  return answer
}

export function resolveRepositoryDir(baseDir: string): string {
  const dir = resolve(baseDir)
  return findGitRoot(dir) ?? dir
}

function findGitRoot(start: string): string | undefined {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function deriveCollection(projectDir: string): string {
  const absolute = canonicalize(projectDir)
  const sanitized = basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 8)
  return `ms_${sanitized}_${hash}`
}

export function canonicalize(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}
