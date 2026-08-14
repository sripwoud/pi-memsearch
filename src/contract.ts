export const MEMSEARCH_SPEC = 'memsearch[onnx]>=0.4.17,<0.5'

const LOCK_PATTERNS = [
  /another process already has the database open/,
  /Failed to open the local Milvus Lite database/,
  /another process holds the lock/,
]

export function isLockContention(stderr: string): boolean {
  return LOCK_PATTERNS.some((pattern) => pattern.test(stderr))
}

export function isMissingCollection(stderr: string): boolean {
  return /Milvus error \(code 100\)/.test(stderr)
}

export function parseVersion(stdout: string): string | undefined {
  return /memsearch, version (\S+)/.exec(stdout)?.[1]
}

export function parseChunkCount(stdout: string): number {
  const count = /Total indexed chunks: (\d+)/.exec(stdout)?.[1]
  if (count === undefined)
    throw new Error(`memsearch stats output drifted: expected "Total indexed chunks: N", got "${stdout.trim()}"`)
  return Number(count)
}

export interface SearchHit {
  chunk_hash: string
  content: string
  end_line: number
  heading: string
  heading_level: number
  score: number
  source: string
  start_line: number
}

export function parseSearchHits(stdout: string): SearchHit[] {
  const data = parseJson(stdout, 'search')
  if (!Array.isArray(data)) throw driftError('search', `expected an array, got ${typeof data}`)
  return data.map((item, index) => {
    const record = asRecord(item, 'search', `result ${index}`)
    const at = `result ${index}`
    return {
      chunk_hash: requireString(record, 'chunk_hash', 'search', at),
      content: requireString(record, 'content', 'search', at),
      end_line: requireNumber(record, 'end_line', 'search', at),
      heading: requireString(record, 'heading', 'search', at),
      heading_level: requireNumber(record, 'heading_level', 'search', at),
      score: requireNumber(record, 'score', 'search', at),
      source: requireString(record, 'source', 'search', at),
      start_line: requireNumber(record, 'start_line', 'search', at),
    }
  })
}

export interface ExpandedSection {
  anchor?: SectionAnchor
  chunk_hash: string
  content: string
  end_line: number
  heading: string
  source: string
  start_line: number
}

export interface SectionAnchor {
  session: string
  transcript: string
  turn: string
}

export function parseExpandedSection(stdout: string): ExpandedSection {
  const record = asRecord(parseJson(stdout, 'expand'), 'expand', 'result')
  const section: ExpandedSection = {
    chunk_hash: requireString(record, 'chunk_hash', 'expand', 'result'),
    content: requireString(record, 'content', 'expand', 'result'),
    end_line: requireNumber(record, 'end_line', 'expand', 'result'),
    heading: requireString(record, 'heading', 'expand', 'result'),
    source: requireString(record, 'source', 'expand', 'result'),
    start_line: requireNumber(record, 'start_line', 'expand', 'result'),
  }
  if (record['anchor'] !== undefined) {
    const anchor = asRecord(record['anchor'], 'expand', 'anchor')
    section.anchor = {
      session: requireString(anchor, 'session', 'expand', 'anchor'),
      transcript: requireString(anchor, 'transcript', 'expand', 'anchor'),
      turn: requireString(anchor, 'turn', 'expand', 'anchor'),
    }
  }
  return section
}

function parseJson(stdout: string, command: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw driftError(command, `not valid JSON: "${truncate(stdout)}"`)
  }
}

function driftError(command: string, detail: string): Error {
  return new Error(`memsearch ${command} JSON output drifted: ${detail}`)
}

function asRecord(value: unknown, command: string, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw driftError(command, `${context} is not an object`)
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string, command: string, context: string): string {
  const value = record[key]
  if (typeof value !== 'string')
    throw driftError(command, `${context} field "${key}" expected a string, got ${typeof value}`)
  return value
}

function requireNumber(record: Record<string, unknown>, key: string, command: string, context: string): number {
  const value = record[key]
  if (typeof value !== 'number')
    throw driftError(command, `${context} field "${key}" expected a number, got ${typeof value}`)
  return value
}

function truncate(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}
