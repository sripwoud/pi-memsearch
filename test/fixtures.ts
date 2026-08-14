import type { ExecResult } from '../src/exec.ts'

export const SEARCH_HITS = [
  {
    chunk_hash: '6c64e3b992dade38',
    content: '## Redis\n\nDecided to use Redis for the hot cache with 5 minute TTLs.',
    end_line: 6,
    heading: 'Redis',
    heading_level: 2,
    score: 0.9999999,
    source: '/home/user/project/.memsearch/memory/2026-08-13.md',
    start_line: 3,
  },
  {
    chunk_hash: 'a1b2c3d4e5f60718',
    content: '### 09:12\n- switched CI to bun for the install step',
    end_line: 14,
    heading: '09:12',
    heading_level: 3,
    score: 0.5081967,
    source: '/home/user/project/.memsearch/memory/2026-08-12.md',
    start_line: 10,
  },
]

export const SEARCH_JSON = JSON.stringify(SEARCH_HITS)

export const EXPAND_RESULT = {
  anchor: {
    session: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
    transcript: '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl',
    turn: 'ab12cd34',
  },
  chunk_hash: '6c64e3b992dade38',
  content: '## Redis\n\nDecided to use Redis for the hot cache with 5 minute TTLs.\nEviction stays LRU.',
  end_line: 8,
  heading: 'Redis',
  source: '/home/user/project/.memsearch/memory/2026-08-13.md',
  start_line: 3,
}

export const EXPAND_JSON = JSON.stringify(EXPAND_RESULT)

export const VERSION_STDOUT = 'memsearch, version 0.4.17\n'

export const STATS_STDOUT = 'Total indexed chunks: 42\n'

export const LOCK_STDERR_0417 =
  'Traceback (most recent call last):\n  File "cli.py", line 288, in cli\nRuntimeError: Could not open the local Milvus database at /home/user/.memsearch/milvus.db: it may be corrupted, from an incompatible Milvus Lite release, or another process already has the database open (Milvus Lite allows a single client at a time).\n'

export const LOCK_STDERR_0416 =
  'Traceback (most recent call last):\n  File "store.py", line 90, in _open\nMilvusException: Failed to open the local Milvus Lite database at /home/user/.memsearch/milvus.db. It may be corrupted or created by an older Milvus Lite release: another process holds the lock on \'/home/user/.memsearch/milvus.db\'\n'

export const CHUNK_NOT_FOUND_STDERR = 'Chunk not found: deadbeef00000000\n'

export const MISSING_COLLECTION_STDERR =
  'Milvus error (code 100): collection not found[collection=ms_project_a1b2c3d4]\n'

export const CONFIG_ERROR_STDERR = 'Configuration error: environment variable OPENAI_API_KEY is not set\n'

export const USAGE_ERROR_STDERR =
  "Usage: memsearch search [OPTIONS] QUERY\nTry 'memsearch search --help' for help.\n\nError: No such option: -x\n"

export function eaccesError(): Error {
  return Object.assign(new Error('spawn uvx EACCES'), { code: 'EACCES' })
}

export function okResult(stdout: string): ExecResult {
  return { exitCode: 0, signal: null, stderr: '', stdout }
}

export function errResult(exitCode: number, stderr: string): ExecResult {
  return { exitCode, signal: null, stderr, stdout: '' }
}

export function timeoutResult(): ExecResult {
  return { exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '' }
}

export function enoentError(): Error {
  return Object.assign(new Error('spawn uvx ENOENT'), { code: 'ENOENT' })
}
