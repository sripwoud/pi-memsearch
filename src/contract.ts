export const MEMSEARCH_SPEC = 'memsearch[onnx]>=0.4.17,<0.5'

// The pinned memsearch releases print non-ASCII output unescaped, and Python picks its pipe
// encoding from the locale, so an explicitly non-UTF-8 locale fails any accented recall or
// compaction. Force UTF-8 on child streams; drop once the MEMSEARCH_SPEC floor reaches a
// release with the upstream fix.
export function pythonChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: 'utf-8' }
}

const LOCK_PATTERNS = [
  /another process already has the database open/,
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

export function parseIndexedChunks(stdout: string): number {
  const count = /Indexed (\d+) chunks\./.exec(stdout)?.[1]
  if (count === undefined)
    throw new Error(`memsearch index output drifted: expected "Indexed N chunks.", got "${stdout.trim()}"`)
  return Number(count)
}

export function parseCompactSummary(stdout: string): string | undefined {
  if (/^No chunks to compact\.$/m.test(stdout)) return undefined
  const marker = /Compact complete\. Summary:\n?/.exec(stdout)
  const summary = marker === null ? '' : stdout.slice(marker.index + marker[0].length).trim()
  if (summary === '') {
    throw new Error(
      `memsearch compact output drifted: expected "Compact complete. Summary:" and a summary, got "${
        truncate(stdout)
      }"`,
    )
  }
  return summary
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
  return parseSearchHitList(parseJson(stdout, 'search'))
}

export function parseSearchHitList(data: unknown): SearchHit[] {
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

export function formatHitBlock(hit: SearchHit, index: number, origin?: string): string {
  const label = origin === undefined ? '' : ` | ${origin}`
  return `${index + 1}. score ${
    hit.score.toFixed(3)
  } | chunk ${hit.chunk_hash}${label} | ${hit.source}:${hit.start_line}-${hit.end_line}\n${hit.content}`
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
