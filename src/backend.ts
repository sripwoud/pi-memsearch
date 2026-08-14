import { isLockContention, isMissingCollection, MEMSEARCH_SPEC, parseChunkCount, parseVersion } from './contract.ts'
import type { ExecFn, ExecResult } from './exec.ts'

const VERSION_TIMEOUT_MS = 60_000
const STATS_TIMEOUT_MS = 10_000
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

export interface CommandOptions {
  signal?: AbortSignal
}

export interface Backend {
  probe(options?: CommandOptions): Promise<Availability>
  stats(collection: string, options?: CommandOptions): Promise<number | 'missing'>
}

export interface BackendDeps {
  env: NodeJS.ProcessEnv
  exec: ExecFn
  now(): Date
  sleep(ms: number): Promise<void>
}

export function createBackend(deps: BackendDeps): Backend {
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
          continue
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
      throw error
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

  async function stats(collection: string, options: CommandOptions = {}): Promise<number | 'missing'> {
    await ensureAvailable(options)
    const result = await invoke(['stats', '-c', collection], STATS_TIMEOUT_MS, options)
    if (result.exitCode !== 0) {
      if (isMissingCollection(result.stderr)) return 'missing'
      throw commandError('stats', result, STATS_TIMEOUT_MS)
    }
    return parseChunkCount(result.stdout)
  }

  return { probe, stats }
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
