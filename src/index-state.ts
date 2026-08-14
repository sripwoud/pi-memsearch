import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export function indexStatePath(memoryDir: string): string {
  return join(dirname(memoryDir), '.index-state.json')
}

export function readIndexState(memoryDir: string): IndexState | undefined {
  const path = indexStatePath(memoryDir)
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
