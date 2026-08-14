import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { type Backend, BackendUnavailableError, createBackend } from './backend.ts'
import { type Complete, DEFAULT_DISTILLATION_TIMEOUT_MS, registerCapture } from './capture.ts'
import { MEMSEARCH_SPEC, type SearchHit } from './contract.ts'
import { type ExecFn, execProcess } from './exec.ts'
import { appendMemoryEntry, localDateKey } from './memory-file.ts'
import { deriveCollection, resolveProjectScope } from './scope.ts'
import { buildSnapshot } from './snapshot.ts'

export interface MemsearchDeps {
  complete: Complete
  distillationTimeoutMs: number
  env: NodeJS.ProcessEnv
  exec: ExecFn
  now(): Date
  schedule(task: () => Promise<void>): void
  sleep(ms: number): Promise<void>
}

export function createMemsearchExtension(deps: Partial<MemsearchDeps> = {}): (pi: ExtensionAPI) => void {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const schedule = deps.schedule ?? createBackgroundQueue()
  const exec = deps.exec ?? execProcess
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return (pi) => {
    registerCapture(pi, {
      complete: deps.complete,
      distillationTimeoutMs: deps.distillationTimeoutMs ?? DEFAULT_DISTILLATION_TIMEOUT_MS,
      env,
      now,
      schedule,
    })
    const backend = createBackend({ env, exec, now, sleep })

    pi.registerTool({
      description:
        'Persist a memory to the shared project memory store, immediately. Use when the user asks to remember something, or when a decision, fix, or fact should survive this session.',
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const entryId = ctx.sessionManager.getLeafId()
        const transcriptPath = ctx.sessionManager.getSessionFile()
        if (!entryId || !transcriptPath) {
          throw new Error(
            'memory_write requires a persisted session: the session anchor needs an entry id and a transcript path',
          )
        }

        const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
        const file = appendMemoryEntry(scope.memoryDir, {
          content: params.content,
          entryId,
          sessionId: ctx.sessionManager.getSessionId(),
          timestamp: now(),
          transcriptPath,
        })
        return { content: [{ text: `Memory saved to ${file}`, type: 'text' as const }], details: { file } }
      },
      label: 'Memory write',
      name: 'memory_write',
      parameters: Type.Object({
        content: Type.String({
          description: 'Memory entry: third-person markdown bullets, in the primary language of the conversation',
        }),
      }),
    })

    pi.registerTool({
      description:
        'Search the shared project memory for past decisions, fixes and context. Returns top-k scored chunks; pass a chunk_hash to memory_expand for the full section.',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
        const collection = deriveCollection(scope.dir)
        const options = signal ? { signal } : {}
        try {
          const hits = await backend.search(
            params.query,
            collection,
            params.top_k === undefined ? options : { ...options, topK: params.top_k },
          )
          const text = hits.length === 0 ? `No memories found for "${params.query}".` : formatHits(hits)
          return { content: [{ text, type: 'text' as const }], details: { hits } }
        } catch (error) {
          if (error instanceof BackendUnavailableError) return unavailableResult(error)
          throw error
        }
      },
      label: 'Memory search',
      name: 'memory_search',
      parameters: Type.Object({
        query: Type.String({ description: 'Semantic search query over the project memory' }),
        top_k: Type.Optional(Type.Integer({ description: 'Number of chunks to return (default 5)', minimum: 1 })),
      }),
    })

    pi.registerTool({
      description:
        'Diagnose the shared project memory backend: uv/memsearch availability and version, project scope, collection, and indexed chunk count.',
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
        const collection = deriveCollection(scope.dir)
        const options = signal ? { signal } : {}
        const availability = await backend.probe(options)

        const lines: string[] = []
        if (availability.available)
          lines.push('backend: available', `memsearch: ${availability.version} (pinned ${MEMSEARCH_SPEC})`)
        else
          lines.push(`backend: unavailable (${availability.reason})`, availability.instructions)
        lines.push(`scope: ${scope.dir}`, `collection: ${collection}`)
        if (availability.available)
          lines.push(await describeChunkCount(backend, collection, options))

        const text = lines.join('\n')
        return { content: [{ text, type: 'text' as const }], details: { availability, collection, scope: scope.dir } }
      },
      label: 'Memory status',
      name: 'memory_status',
      parameters: Type.Object({}),
    })

    if (env['PI_MEMSEARCH_SNAPSHOT'] === 'off') return

    let snapshot: string | undefined
    let snapshotDate: string | undefined

    const refreshSnapshot = (cwd: string): string => {
      const timestamp = now()
      const scope = resolveProjectScope({ baseDir: cwd, env })
      snapshot = buildSnapshot(scope.memoryDir, timestamp)
      snapshotDate = localDateKey(timestamp)
      return snapshot
    }

    pi.on('session_start', (_event, ctx) => {
      refreshSnapshot(ctx.cwd)
    })
    pi.on('session_compact', (_event, ctx) => {
      refreshSnapshot(ctx.cwd)
    })
    pi.on('before_agent_start', (event, ctx) => {
      const block = snapshot !== undefined && snapshotDate === localDateKey(now()) ? snapshot : refreshSnapshot(ctx.cwd)
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` }
    })
  }
}

function createBackgroundQueue(): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    tail = tail.then(task).catch(() => {})
  }
}

function unavailableResult(error: BackendUnavailableError) {
  return {
    content: [{ text: error.availability.instructions, type: 'text' as const }],
    details: { unavailable: error.availability.reason },
  }
}

function formatHits(hits: SearchHit[]): string {
  const blocks = hits.map(
    (hit, index) =>
      `${index + 1}. score ${
        hit.score.toFixed(3)
      } | chunk ${hit.chunk_hash} | ${hit.source}:${hit.start_line}-${hit.end_line}\n${hit.content}`,
  )
  return [`${hits.length} memory chunk(s), best first:`, ...blocks].join('\n\n')
}

async function describeChunkCount(
  backend: Backend,
  collection: string,
  options: { signal?: AbortSignal },
): Promise<string> {
  try {
    const chunks = await backend.stats(collection, options)
    return chunks === 'missing' ? 'indexed chunks: 0 (collection not created yet)' : `indexed chunks: ${chunks}`
  } catch (error) {
    return `indexed chunks: unavailable (${error instanceof Error ? error.message : String(error)})`
  }
}
