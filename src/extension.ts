import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { resolve } from 'node:path'
import { Type } from 'typebox'
import { type Backend, BackendUnavailableError, createBackend } from './backend.ts'
import { type BootstrapState, createBootstrap, ONNX_DOWNLOAD_NOTICE } from './bootstrap.ts'
import { type Complete, DEFAULT_DISTILLATION_TIMEOUT_MS, registerCapture } from './capture.ts'
import { type ExpandedSection, MEMSEARCH_SPEC, type SearchHit } from './contract.ts'
import { type CrossRepoResult, discoverProjects, resolveScanRoots, searchAcrossProjects } from './cross-repo.ts'
import { type ExecFn, execProcess } from './exec.ts'
import { type IndexState, readIndexState } from './index-state.ts'
import { createIndexTriggers, SHUTDOWN_CAP_MS } from './indexer.ts'
import { appendMemoryEntry, localDateKey } from './memory-file.ts'
import { deriveCollection, type ProjectScope, resolveProjectScope } from './scope.ts'
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
  const queue = createBackgroundQueue()
  const schedule = deps.schedule ?? queue.schedule
  const exec = deps.exec ?? execProcess
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return (pi) => {
    const backend = createBackend({ env, exec, now, sleep })
    const indexer = createIndexTriggers({ backend, env, sleep })
    let captureAbort = new AbortController()
    let shutdownEpoch = 0
    registerCapture(pi, {
      complete: deps.complete,
      distillationTimeoutMs: deps.distillationTimeoutMs ?? DEFAULT_DISTILLATION_TIMEOUT_MS,
      env,
      now,
      onWrite: (cwd) => indexer.noteWrite(cwd),
      schedule,
      shutdownSignal: () => captureAbort.signal,
    })

    pi.on('session_start', (_event, ctx) => {
      shutdownEpoch++
      captureAbort = new AbortController()
      indexer.catchUp(ctx.cwd)
    })
    pi.on('session_shutdown', async () => {
      indexer.beginShutdown()
      const epoch = ++shutdownEpoch
      const flushed = (async () => {
        await queue.flush()
        await indexer.settle()
      })()
      const capped = sleep(SHUTDOWN_CAP_MS).then(() => {
        if (epoch !== shutdownEpoch) return
        captureAbort.abort()
        indexer.abortInFlight()
      })
      await Promise.race([flushed, capped])
    })
    const bootstrap = createBootstrap({ backend, env, now })

    pi.on('session_start', (_event, ctx) => {
      const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
      schedule(async () => {
        await bootstrap.ensure(scope.dir)
      })
    })

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
        indexer.noteWrite(ctx.cwd)
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
      execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
        const { collection, options, scope } = resolveTarget(ctx, env, signal)
        const scanRoots = params.scope === 'all' ? resolveScanRoots(env) : undefined
        return orInstallInstructions(async () => {
          await bootstrap.ensure(scope.dir)
          if (await bootstrap.claimOnnxDownloadNotice()) ctx.ui.notify(ONNX_DOWNLOAD_NOTICE, 'info')
          if (scanRoots) {
            const result = await searchAcrossProjects({
              backend,
              currentProject: scope.dir,
              onProgress: (done, total) =>
                onUpdate?.({
                  content: [{ text: `cross-repo search: ${done}/${total} projects`, type: 'text' as const }],
                  details: { hits: [] },
                }),
              projects: discoverProjects(scanRoots),
              query: params.query,
              ...(signal ? { signal } : {}),
              ...(params.top_k === undefined ? {} : { topK: params.top_k }),
            })
            const text = formatCrossRepoResult(params.query, result)
            return { content: [{ text, type: 'text' as const }], details: { ...result } }
          }
          const hits = await backend.search(
            params.query,
            collection,
            params.top_k === undefined ? options : { ...options, topK: params.top_k },
          )
          const text = hits.length === 0 ? `No memories found for "${params.query}".` : formatHits(hits)
          return { content: [{ text, type: 'text' as const }], details: { hits } }
        })
      },
      label: 'Memory search',
      name: 'memory_search',
      parameters: Type.Object({
        query: Type.String({ description: 'Semantic search query over the project memory' }),
        scope: Type.Optional(
          Type.Union([Type.Literal('project'), Type.Literal('all')], {
            description:
              "Search scope: 'project' (default) stays in this project; 'all' fans out across every project under PI_MEMSEARCH_SCAN_ROOTS",
          }),
        ),
        top_k: Type.Optional(Type.Integer({ description: 'Number of chunks to return (default 5)', minimum: 1 })),
      }),
    })

    pi.registerTool({
      description:
        'Expand a memory chunk (by chunk_hash from memory_search) into its full section, with the session anchor pointing at the original transcript.',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const { collection, options } = resolveTarget(ctx, env, signal)
        const target = params.project ? deriveCollection(resolve(ctx.cwd, params.project)) : collection
        return orInstallInstructions(async () => {
          const section = await backend.expand(params.chunk_hash, target, options)
          return { content: [{ text: formatSection(section), type: 'text' as const }], details: { section } }
        })
      },
      label: 'Memory expand',
      name: 'memory_expand',
      parameters: Type.Object({
        chunk_hash: Type.String({ description: 'Chunk hash returned by memory_search' }),
        project: Type.Optional(
          Type.String({
            description:
              "Origin project path from a cross-repo memory_search hit; routes expansion to that project's collection",
          }),
        ),
      }),
    })

    pi.registerTool({
      description:
        'Diagnose the shared project memory backend: uv/memsearch availability and version, project scope, collection, and indexed chunk count.',
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        const { collection, options, scope } = resolveTarget(ctx, env, signal)
        const availability = await backend.probe(options)
        const bootstrapState = await bootstrap.ensure(scope.dir)

        const lines: string[] = []
        if (availability.available)
          lines.push('backend: available', `memsearch: ${availability.version} (pinned ${MEMSEARCH_SPEC})`)
        else
          lines.push(`backend: unavailable (${availability.reason})`, availability.instructions)
        lines.push(`scope: ${scope.dir}`, `collection: ${collection}`, describeBootstrap(bootstrapState))
        lines.push(...describeIndexHealth(scope.memoryDir))
        const failure = indexer.lastFailure()
        if (failure !== undefined) lines.push(`last index run: failed (${failure})`)
        if (availability.available)
          lines.push(await describeChunkCount(backend, collection, options))

        const text = lines.join('\n')
        return {
          content: [{ text, type: 'text' as const }],
          details: { availability, bootstrap: bootstrapState, collection, scope: scope.dir },
        }
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

interface BackgroundQueue {
  flush(): Promise<void>
  schedule(task: () => Promise<void>): void
}

function createBackgroundQueue(): BackgroundQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    flush: () => tail,
    schedule(task) {
      tail = tail.then(task).catch(() => {})
    },
  }
}

interface RecallTarget {
  collection: string
  options: { signal?: AbortSignal }
  scope: ProjectScope
}

function resolveTarget(ctx: ExtensionContext, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): RecallTarget {
  const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
  return { collection: deriveCollection(scope.dir), options: signal ? { signal } : {}, scope }
}

async function orInstallInstructions<T>(run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof BackendUnavailableError) return unavailableResult(error)
    throw error
  }
}

function unavailableResult(error: BackendUnavailableError) {
  return {
    content: [{ text: error.availability.instructions, type: 'text' as const }],
    details: { unavailable: error.availability.reason },
  }
}

function describeBootstrap(state: BootstrapState): string {
  switch (state.status) {
    case 'bootstrapped':
      return 'bootstrap: embedding.provider = onnx set globally (no prior config)'
    case 'existing-config':
      return `bootstrap: not needed (existing config: ${state.configPath})`
    case 'failed':
      return `bootstrap: failed (${state.reason})`
  }
}

function formatHitBlock(hit: SearchHit, index: number, origin?: string): string {
  const label = origin === undefined ? '' : ` | ${origin}`
  return `${index + 1}. score ${
    hit.score.toFixed(3)
  } | chunk ${hit.chunk_hash}${label} | ${hit.source}:${hit.start_line}-${hit.end_line}\n${hit.content}`
}

function formatHits(hits: SearchHit[]): string {
  const blocks = hits.map((hit, index) => formatHitBlock(hit, index))
  return [`${hits.length} memory chunk(s), best first:`, ...blocks].join('\n\n')
}

function formatCrossRepoResult(query: string, result: CrossRepoResult): string {
  const accounting = `${result.searched.length} projects searched, ${result.skipped.length} skipped`
  const skippedNote = result.skipped.length === 0
    ? []
    : [`skipped (never indexed on this machine): ${result.skipped.join(', ')}`]
  if (result.hits.length === 0)
    return [`No memories found for "${query}" across ${accounting}.`, ...skippedNote].join('\n')
  const blocks = result.hits.map((hit, index) => formatHitBlock(hit, index, hit.project))
  return [`${result.hits.length} memory chunk(s), ${accounting}, best first:`, ...blocks, ...skippedNote].join('\n\n')
}

function formatSection(section: ExpandedSection): string {
  const lines = [
    `${section.source}:${section.start_line}-${section.end_line} | ${section.heading}`,
    '',
    section.content,
  ]
  if (section.anchor) {
    lines.push(
      '',
      `origin: session ${section.anchor.session} entry ${section.anchor.turn}`,
      `transcript: ${section.anchor.transcript}`,
    )
  }
  return lines.join('\n')
}

function describeIndexHealth(memoryDir: string): string[] {
  let state: IndexState | undefined
  try {
    state = readIndexState(memoryDir)
  } catch (error) {
    return [`index: state unreadable (${error instanceof Error ? error.message : String(error)})`]
  }
  if (!state) return ['index: no state recorded yet']
  const lines = [describeIndexStatus(state)]
  for (const failure of state.failedFiles) lines.push(`  failed: ${failure.path} (${failure.error})`)
  return lines
}

function describeIndexStatus(state: IndexState): string {
  if (state.status === 'ok')
    return state.lastCompletedAt === undefined ? 'index: ok' : `index: ok (last indexed ${state.lastCompletedAt})`
  if (state.status === 'degraded') return `index: degraded (${state.failedFiles.length} failed file(s))`
  if (state.status === 'error')
    return state.lastError === undefined ? 'index: error' : `index: error (${state.lastError})`
  return `index: ${state.status}`
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
