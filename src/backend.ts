import {
  type ExpandedSection,
  isLockContention,
  isMissingCollection,
  MEMSEARCH_SPEC,
  parseChunkCount,
  parseCompactSummary,
  parseExpandedSection,
  parseIndexedChunks,
  parseSearchHits,
  parseVersion,
  type SearchHit,
} from './contract.ts'
import type { ExecFn, ExecResult } from './exec.ts'

const VERSION_TIMEOUT_MS = 60_000
const CONFIG_TIMEOUT_MS = 10_000
const STATS_TIMEOUT_MS = 10_000
const EXPAND_TIMEOUT_MS = 10_000
const INDEX_TIMEOUT_MS = 120_000
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
const DEFAULT_COMPACT_TIMEOUT_MS = 300_000
export const DEFAULT_TOP_K = 5
const NEGATIVE_PROBE_TTL_MS = 30_000
const BACKOFF_DELAYS_MS = [200, 500, 1000, 2000]

const UV_INSTRUCTIONS =
  'The memory backend is unavailable: uv is not installed. Install it with `curl -LsSf https://astral.sh/uv/install.sh | sh` (or your package manager), then retry.'

function memsearchInstructions(detail: string): string {
  return `The memory backend is unavailable: memsearch could not be run via uvx (${detail}). Check network access or pre-install it with \`uv tool install "memsearch[onnx]"\`, then retry.`
}

export type Unavailable = {
  available: false
  instructions: string
  reason: 'memsearch-unavailable' | 'uv-missing'
}

export type Availability = Unavailable | { available: true; version: string }

export class BackendUnavailableError extends Error {
  readonly availability: Unavailable

  constructor(availability: Unavailable) {
    super(availability.instructions)
    this.name = 'BackendUnavailableError'
    this.availability = availability
  }
}

export class MissingCollectionError extends Error {
  constructor(command: string, collection: string) {
    super(`memsearch ${command} failed: collection ${collection} was never indexed on this machine`)
    this.name = 'MissingCollectionError'
  }
}

export interface CommandOptions {
  signal?: AbortSignal
}

export interface Backend {
  compact(source: string, outputDir: string, collection: string, options?: CommandOptions): Promise<string>
  configGet(key: string, options?: CommandOptions): Promise<string>
  configSet(key: string, value: string, options?: CommandOptions): Promise<void>
  expand(chunkHash: string, collection: string, options?: CommandOptions): Promise<ExpandedSection>
  index(path: string, collection: string, options?: CommandOptions): Promise<number>
  probe(options?: CommandOptions): Promise<Availability>
  search(query: string, collection: string, options?: CommandOptions & { topK?: number }): Promise<SearchHit[]>
  stats(collection: string, options?: CommandOptions): Promise<number | 'missing'>
}

export interface BackendDeps {
  env: NodeJS.ProcessEnv
  exec: ExecFn
  now(): Date
  sleep(ms: number): Promise<void>
}

export function createBackend(deps: BackendDeps): Backend {
  const searchTimeoutMs = resolveTimeoutMs(deps.env, 'PI_MEMSEARCH_SEARCH_TIMEOUT_MS', DEFAULT_SEARCH_TIMEOUT_MS)
  const compactTimeoutMs = resolveTimeoutMs(deps.env, 'PI_MEMSEARCH_COMPACT_TIMEOUT_MS', DEFAULT_COMPACT_TIMEOUT_MS)
  let tail: Promise<unknown> = Promise.resolve()
  let probeCache: { expiresAtMs?: number; result: Promise<Availability> } | undefined

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  function invoke(args: string[], timeoutMs: number, options: CommandOptions): Promise<ExecResult> {
    return enqueue(async () => {
      for (let attempt = 0;; attempt++) {
        const result = await deps.exec(
          'uvx',
          ['--from', MEMSEARCH_SPEC, 'memsearch', ...args],
          options.signal ? { signal: options.signal, timeoutMs } : { timeoutMs },
        )
        if (result.exitCode !== 0 && isLockContention(result.stderr) && attempt < BACKOFF_DELAYS_MS.length) {
          await deps.sleep(BACKOFF_DELAYS_MS[attempt] as number)
          if (!options.signal?.aborted) continue
        }
        return result
      }
    })
  }

  async function runProbe(options: CommandOptions): Promise<Availability> {
    let result: ExecResult
    try {
      result = await invoke(['--version'], VERSION_TIMEOUT_MS, options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { available: false, instructions: UV_INSTRUCTIONS, reason: 'uv-missing' }
      if (error instanceof Error && error.name === 'AbortError') throw error
      return {
        available: false,
        instructions: memsearchInstructions(`spawn failed: ${error instanceof Error ? error.message : String(error)}`),
        reason: 'memsearch-unavailable',
      }
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        instructions: memsearchInstructions(describeFailure(result, VERSION_TIMEOUT_MS)),
        reason: 'memsearch-unavailable',
      }
    }
    const version = parseVersion(result.stdout)
    if (version === undefined) {
      return {
        available: false,
        instructions: memsearchInstructions(`unexpected --version output: "${result.stdout.trim()}"`),
        reason: 'memsearch-unavailable',
      }
    }
    return { available: true, version }
  }

  function probe(options: CommandOptions = {}): Promise<Availability> {
    const cached = probeCache
    if (cached && (cached.expiresAtMs === undefined || deps.now().getTime() < cached.expiresAtMs))
      return cached.result
    let entry: { expiresAtMs?: number; result: Promise<Availability> } | undefined
    const result = runProbe(options).then(
      (availability) => {
        if (!availability.available && entry) entry.expiresAtMs = deps.now().getTime() + NEGATIVE_PROBE_TTL_MS
        return availability
      },
      (error: unknown) => {
        probeCache = undefined
        throw error
      },
    )
    entry = { result }
    probeCache = entry
    return result
  }

  async function ensureAvailable(options: CommandOptions): Promise<void> {
    const availability = await probe(options)
    if (!availability.available) throw new BackendUnavailableError(availability)
  }

  async function runCommand(
    name: string,
    args: string[],
    timeoutMs: number,
    options: CommandOptions,
    collection?: string,
  ): Promise<ExecResult> {
    await ensureAvailable(options)
    const result = await invoke(args, timeoutMs, options)
    if (result.exitCode !== 0) {
      if (collection !== undefined && isMissingCollection(result.stderr))
        throw new MissingCollectionError(name, collection)
      throw commandError(name, result, timeoutMs)
    }
    return result
  }

  async function search(
    query: string,
    collection: string,
    options: CommandOptions & { topK?: number } = {},
  ): Promise<SearchHit[]> {
    const topK = options.topK ?? DEFAULT_TOP_K
    const args = ['search', '-j', '-k', String(topK), '-c', collection, '--', query]
    const result = await runCommand('search', args, searchTimeoutMs, options, collection)
    return parseSearchHits(result.stdout)
  }

  async function expand(chunkHash: string, collection: string, options: CommandOptions = {}): Promise<ExpandedSection> {
    const args = ['expand', '-j', '-c', collection, '--', chunkHash]
    const result = await runCommand('expand', args, EXPAND_TIMEOUT_MS, options, collection)
    return parseExpandedSection(result.stdout)
  }

  async function configGet(key: string, options: CommandOptions = {}): Promise<string> {
    const result = await runCommand('config get', ['config', 'get', key], CONFIG_TIMEOUT_MS, options)
    return result.stdout.trim()
  }

  async function configSet(key: string, value: string, options: CommandOptions = {}): Promise<void> {
    await runCommand('config set', ['config', 'set', key, value], CONFIG_TIMEOUT_MS, options)
  }

  async function compact(
    source: string,
    outputDir: string,
    collection: string,
    options: CommandOptions = {},
  ): Promise<string> {
    const args = ['compact', '-s', source, '-o', outputDir, '-c', collection]
    const result = await runCommand('compact', args, compactTimeoutMs, options)
    return parseCompactSummary(result.stdout)
  }

  async function index(path: string, collection: string, options: CommandOptions = {}): Promise<number> {
    const result = await runCommand('index', ['index', path, '-c', collection], INDEX_TIMEOUT_MS, options)
    return parseIndexedChunks(result.stdout)
  }

  async function stats(collection: string, options: CommandOptions = {}): Promise<number | 'missing'> {
    await ensureAvailable(options)
    const result = await invoke(['stats', '-c', collection], STATS_TIMEOUT_MS, options)
    if (result.exitCode !== 0) {
      if (isMissingCollection(result.stderr)) return 'missing'
      throw commandError('stats', result, STATS_TIMEOUT_MS)
    }
    return parseChunkCount(result.stdout)
  }

  return { compact, configGet, configSet, expand, index, probe, search, stats }
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${key} must be a positive integer of milliseconds, got "${raw}"`)
  return value
}

function commandError(name: string, result: ExecResult, timeoutMs: number): Error {
  return new Error(`memsearch ${name} failed: ${describeFailure(result, timeoutMs)}`)
}

function describeFailure(result: ExecResult, timeoutMs: number): string {
  if (result.exitCode === null) return `timed out after ${timeoutMs}ms (terminated with ${result.signal})`
  const detail = lastLine(result.stderr)
  return detail === '' ? `exit ${result.exitCode}` : `exit ${result.exitCode}: ${detail}`
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines[lines.length - 1] ?? ''
}
