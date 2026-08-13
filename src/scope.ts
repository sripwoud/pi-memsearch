import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface ProjectScope {
  dir: string
  memoryDir: string
}

export interface ScopeOptions {
  baseDir: string
  env?: NodeJS.ProcessEnv
}

export function resolveProjectScope({ baseDir, env = process.env }: ScopeOptions): ProjectScope {
  const override = env['MEMSEARCH_DIR']
  if (override) {
    const dir = resolve(baseDir, override)
    return { dir, memoryDir: join(dir, 'memory') }
  }
  const dir = findGitRoot(resolve(baseDir)) ?? resolve(baseDir)
  return { dir, memoryDir: join(dir, '.memsearch', 'memory') }
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

function canonicalize(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}
