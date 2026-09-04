import { fileURLToPath } from 'node:url'
import { formatHitBlock, MEMSEARCH_SPEC, parseSearchHitList, type SearchHit } from './contract.ts'
import type { SidecarProcess, SpawnSidecarFn } from './sidecar.ts'

export const AUTO_CONTEXT_ENV = 'PI_MEMSEARCH_AUTO_CONTEXT'
export const AUTO_CONTEXT_MESSAGE_TYPE = 'memsearch-auto-context'
export const AUTO_CONTEXT_CAP_MS = 300
export const AUTO_CONTEXT_TOP_K = 3
export const AUTO_CONTEXT_SCORE_FLOOR = 0.5
export const AUTO_CONTEXT_CHAR_BUDGET = 2000
export const AUTO_CONTEXT_QUERY_LIMIT = 500
export const MAX_SIDECAR_RESPAWNS = 2
export const TIMEOUT_CRASH_THRESHOLD = 3
export const SHUTDOWN_GRACE_MS = 2000

const SIDECAR_SCRIPT = fileURLToPath(new URL('./sidecar.py', import.meta.url))

const PREAMBLE = 'Project memory (auto-context): chunks semantically relevant to the current prompt, recalled '
  + 'from the shared memory store. Background that may be stale — the live conversation wins. '
  + 'Pass a chunk hash to memory_expand for the full section.'

export type SidecarState = 'crashed' | 'gave-up' | 'warm' | 'warming'

export interface AutoContextCounters {
  injected: number
  prompts: number
  skippedBudget: number
  skippedEmpty: number
  skippedError: number
}

export interface AutoContextStatus {
  counters: AutoContextCounters
  enabled: boolean
  lastInjectionMs?: number
  model?: string
  provider?: string
  state?: SidecarState
}

export interface AutoContextMessage {
  content: string
  customType: string
  display: false
}

export interface AutoContextTarget {
  collection: string
  repositoryDir: string
  stateDir: string | undefined
}

export interface AutoContext {
  enabled: boolean
  onPrompt(prompt: string): Promise<{ message: AutoContextMessage } | undefined>
  start(target: AutoContextTarget): void
  status(): AutoContextStatus
  stop(): void
}

export interface AutoContextDeps {
  env: NodeJS.ProcessEnv
  getSnapshot(): string | undefined
  now(): Date
  sleep(ms: number): Promise<void>
  spawnSidecar: SpawnSidecarFn
}

type RequestOutcome = { hits: SearchHit[]; kind: 'hits' } | { detail: string; kind: 'error' }

const TIMEOUT = Symbol('auto-context timeout')

interface Session {
  dead: boolean
  pending: Map<number, (outcome: RequestOutcome) => void>
  proc: SidecarProcess
  ready: Promise<void>
  stopped: boolean
}

function freshCounters(): AutoContextCounters {
  return { injected: 0, prompts: 0, skippedBudget: 0, skippedEmpty: 0, skippedError: 0 }
}

export function createAutoContext(deps: AutoContextDeps): AutoContext {
  const enabled = deps.env[AUTO_CONTEXT_ENV] === 'on'
  let counters = freshCounters()
  let state: SidecarState = 'warming'
  let repositoryDir: string | undefined
  let stateDir: string | undefined
  let collection = ''
  let session: Session | undefined
  let respawns = 0
  let consecutiveTimeouts = 0
  let provider: string | undefined
  let model: string | undefined
  let lastInjectionMs: number | undefined
  let nextRequestId = 1

  function noteCrash(): void {
    consecutiveTimeouts = 0
    state = respawns >= MAX_SIDECAR_RESPAWNS ? 'gave-up' : 'crashed'
  }

  function spawn(dir: string): void {
    let readyResolve: () => void = () => {}
    const proc = deps.spawnSidecar('uv', ['run', '--no-project', '--with', MEMSEARCH_SPEC, 'python', SIDECAR_SCRIPT], {
      cwd: dir,
      ...(stateDir === undefined ? {} : { env: { MEMSEARCH_DIR: stateDir } }),
    })
    const current: Session = {
      dead: false,
      pending: new Map(),
      proc,
      ready: new Promise((resolve) => {
        readyResolve = resolve
      }),
      stopped: false,
    }
    session = current
    state = 'warming'
    proc.onLine((line) => {
      if (current.dead) return
      let data: unknown
      try {
        data = JSON.parse(line)
      } catch {
        return
      }
      if (typeof data !== 'object' || data === null) return
      const record = data as Record<string, unknown>
      if (record['event'] === 'ready') {
        if (typeof record['provider'] === 'string') provider = record['provider']
        if (typeof record['model'] === 'string') model = record['model']
        if (session === current && state === 'warming') state = 'warm'
        readyResolve()
        return
      }
      const id = record['id']
      if (typeof id !== 'number') return
      const resolve = current.pending.get(id)
      if (!resolve) return
      current.pending.delete(id)
      resolve(toOutcome(record))
    })
    proc.onExit(() => {
      if (current.dead) return
      current.dead = true
      for (const resolve of current.pending.values()) resolve({ detail: 'sidecar exited', kind: 'error' })
      current.pending.clear()
      if (session === current && !current.stopped) noteCrash()
    })
  }

  function toOutcome(record: Record<string, unknown>): RequestOutcome {
    if (record['error'] !== undefined) return { detail: String(record['error']), kind: 'error' }
    try {
      return { hits: parseSearchHitList(record['hits']), kind: 'hits' }
    } catch (error) {
      return { detail: error instanceof Error ? error.message : String(error), kind: 'error' }
    }
  }

  function request(current: Session, id: number, query: string): Promise<RequestOutcome> {
    if (current.dead) return Promise.resolve({ detail: 'sidecar exited', kind: 'error' })
    return new Promise((resolve) => {
      current.pending.set(id, resolve)
      current.proc.send(JSON.stringify({ collection, id, query, top_k: AUTO_CONTEXT_TOP_K }))
    })
  }

  async function onPrompt(prompt: string): Promise<{ message: AutoContextMessage } | undefined> {
    if (!enabled) return undefined
    counters.prompts++
    if (state === 'gave-up' || repositoryDir === undefined) return undefined
    if (state === 'crashed') {
      respawns++
      spawn(repositoryDir)
    }
    const current = session
    if (!current) return undefined

    const startedAt = deps.now().getTime()
    const capped: Promise<typeof TIMEOUT> = deps.sleep(AUTO_CONTEXT_CAP_MS).then(() => TIMEOUT)
    const readiness = await Promise.race([current.ready, capped])
    if (readiness === TIMEOUT) {
      counters.skippedBudget++
      return undefined
    }

    const id = nextRequestId++
    const outcome = await Promise.race([request(current, id, prompt.slice(0, AUTO_CONTEXT_QUERY_LIMIT)), capped])
    if (outcome === TIMEOUT) {
      current.pending.delete(id)
      counters.skippedBudget++
      consecutiveTimeouts++
      if (consecutiveTimeouts >= TIMEOUT_CRASH_THRESHOLD && session === current && !current.dead) {
        current.dead = true
        current.pending.clear()
        current.proc.kill()
        noteCrash()
      }
      return undefined
    }

    consecutiveTimeouts = 0
    if (outcome.kind === 'error') {
      counters.skippedError++
      return undefined
    }
    const content = buildContent(outcome.hits, deps.getSnapshot())
    if (content === undefined) {
      counters.skippedEmpty++
      return undefined
    }
    counters.injected++
    lastInjectionMs = deps.now().getTime() - startedAt
    return { message: { content, customType: AUTO_CONTEXT_MESSAGE_TYPE, display: false } }
  }

  return {
    enabled,
    onPrompt,
    start(target) {
      if (!enabled) return
      repositoryDir = target.repositoryDir
      stateDir = target.stateDir
      collection = target.collection
      counters = freshCounters()
      respawns = 0
      consecutiveTimeouts = 0
      lastInjectionMs = undefined
      if (session && !session.dead) {
        session.stopped = true
        session.proc.end()
      }
      spawn(target.repositoryDir)
    },
    status() {
      return {
        counters: { ...counters },
        enabled,
        ...(enabled ? { state } : {}),
        ...(lastInjectionMs === undefined ? {} : { lastInjectionMs }),
        ...(model === undefined ? {} : { model }),
        ...(provider === undefined ? {} : { provider }),
      }
    },
    stop() {
      const current = session
      if (!current || current.dead) return
      current.stopped = true
      current.proc.end()
      void deps.sleep(SHUTDOWN_GRACE_MS).then(() => {
        if (!current.dead) current.proc.kill()
      })
    },
  }
}

function buildContent(hits: SearchHit[], snapshot: string | undefined): string | undefined {
  const relevant = hits.filter((hit) => hit.score >= AUTO_CONTEXT_SCORE_FLOOR && !snapshot?.includes(hit.content))
  const blocks: string[] = []
  let total = 0
  for (const hit of relevant.slice(0, AUTO_CONTEXT_TOP_K)) {
    const block = formatHitBlock(hit, blocks.length)
    if (blocks.length > 0 && total + block.length > AUTO_CONTEXT_CHAR_BUDGET) break
    const bounded = block.length > AUTO_CONTEXT_CHAR_BUDGET ? block.slice(0, AUTO_CONTEXT_CHAR_BUDGET) : block
    blocks.push(bounded)
    total += bounded.length
  }
  if (blocks.length === 0) return undefined
  return [PREAMBLE, ...blocks].join('\n\n')
}
