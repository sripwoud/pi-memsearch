import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { canonicalize, resolveRepositoryDir, resolveStateDir, type ScopeOptions, STORE_CMD_ENV } from './scope.ts'

export interface IndexFailure {
  error: string
  path: string
}

export interface IndexState {
  failedFiles: IndexFailure[]
  lastCompletedAt?: string
  lastError?: string
  status: string
}

export function indexStatePath(memoryDir: string, { baseDir, env = process.env }: ScopeOptions): string | undefined {
  const delegated = resolveStateDir({ baseDir, env })
  if (delegated !== undefined) return join(delegated, '.index-state.json')
  const override = env['MEMSEARCH_DIR']
  if (override) return join(resolve(resolveRepositoryDir(baseDir), override), '.index-state.json')
  const tree = memsearchTree(memoryDir)
  if (tree) return join(tree, '.index-state.json')
  if (env[STORE_CMD_ENV]) return undefined
  return join(dirname(memoryDir), '.index-state.json')
}

function memsearchTree(memoryDir: string): string | undefined {
  return treePrefix(resolve(memoryDir)) ?? treePrefix(resolveSymlinks(memoryDir))
}

function treePrefix(path: string): string | undefined {
  const parts = path.split(sep)
  const depth = parts.indexOf('.memsearch')
  return depth === -1 ? undefined : parts.slice(0, depth + 1).join(sep)
}

function resolveSymlinks(path: string): string {
  const absolute = resolve(path)
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return absolute
    existing = parent
  }
  return join(canonicalize(existing), relative(existing, absolute))
}

export function readIndexState(path: string): IndexState | undefined {
  if (!existsSync(path)) return undefined
  const record = asRecord(parseJson(readFileSync(path, 'utf8')), 'state')
  if (record['schema_version'] !== 1) throw driftError(`unsupported schema_version ${String(record['schema_version'])}`)
  const status = record['status']
  if (typeof status !== 'string') throw driftError('field "status" expected a string')
  const state: IndexState = { failedFiles: parseFailedFiles(record['failed_files']), status }
  const lastCompletedAt = optionalString(record, 'last_completed_at')
  if (lastCompletedAt !== undefined) state.lastCompletedAt = lastCompletedAt
  const lastError = optionalString(record, 'last_error')
  if (lastError !== undefined) state.lastError = lastError
  return state
}

function parseFailedFiles(value: unknown): IndexFailure[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw driftError('field "failed_files" expected an array')
  return value.map((item, index) => {
    const record = asRecord(item, `failed_files[${index}]`)
    const path = record['path']
    const error = record['error']
    if (typeof path !== 'string' || typeof error !== 'string')
      throw driftError(`failed_files[${index}] expected string "path" and "error"`)
    return { error, path }
  })
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw driftError('not valid JSON')
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw driftError(`${context} is not an object`)
  return value as Record<string, unknown>
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function driftError(detail: string): Error {
  return new Error(`index-state file drifted: ${detail}`)
}
