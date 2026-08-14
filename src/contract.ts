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
