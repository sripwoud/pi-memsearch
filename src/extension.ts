import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { Type } from 'typebox'
import { AUTO_CONTEXT_ENV, type AutoContextStatus, createAutoContext } from './auto-context.ts'
import { type Backend, BackendUnavailableError, createBackend } from './backend.ts'
import { type BootstrapState, createBootstrap, ONNX_DOWNLOAD_NOTICE } from './bootstrap.ts'
import { type Complete, DEFAULT_DISTILLATION_TIMEOUT_MS, registerCapture } from './capture.ts'
import { type ExpandedSection, formatHitBlock, MEMSEARCH_SPEC, type SearchHit } from './contract.ts'
import { type CrossRepoResult, discoverProjects, resolveScanRoots, searchAcrossProjects } from './cross-repo.ts'
import { type ExecFn, execProcess } from './exec.ts'
import { type IndexState, readIndexState } from './index-state.ts'
import { createIndexTriggers, SHUTDOWN_CAP_MS } from './indexer.ts'
import { appendMemoryEntry, dailyFilePathForKey, localDateKey } from './memory-file.ts'
import { entriesAtTime, entriesForSection, type EntrySection, removeEntry } from './redaction.ts'
import { deriveCollection, type ProjectScope, resolveProjectScope } from './scope.ts'
import { type SpawnSidecarFn, spawnSidecarProcess } from './sidecar.ts'
import { buildSnapshot } from './snapshot.ts'

export interface MemsearchDeps {
  complete: Complete
  distillationTimeoutMs: number
  env: NodeJS.ProcessEnv
  exec: ExecFn
  now(): Date
  schedule(task: () => Promise<void>): void
  sleep(ms: number): Promise<void>
  spawnSidecar: SpawnSidecarFn
}

export function createMemsearchExtension(deps: Partial<MemsearchDeps> = {}): (pi: ExtensionAPI) => void {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const queue = createBackgroundQueue()
  const schedule = deps.schedule ?? queue.schedule
  const exec = deps.exec ?? execProcess
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const spawnSidecar = deps.spawnSidecar ?? spawnSidecarProcess

  return (pi) => {
    const backend = createBackend({ env, exec, now, sleep })
    const indexer = createIndexTriggers({ backend, env, sleep })
    let captureAbort = new AbortController()
    let shutdownEpoch = 0
    let onRedact: (cwd: string) => void = () => {}
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

    let snapshot: string | undefined
    let snapshotDate: string | undefined
    const autoContext = createAutoContext({ env, getSnapshot: () => snapshot, now, sleep, spawnSidecar })

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

    const redact = (file: string, content: string, entry: EntrySection, cwd: string) => {
      const remaining = removeEntry(content, entry)
      if (remaining === '') unlinkSync(file)
      else writeFileSync(file, remaining)
      indexer.noteWrite(cwd)
      onRedact(cwd)
      const note = remaining === '' ? ' (the file had no other entries and was deleted)' : ''
      return {
        content: [{ text: `Memory entry redacted from ${file}${note}:\n\n${entry.text}`, type: 'text' as const }],
        details: { file, removed: entry.text },
      }
    }

    pi.registerTool({
      description:
        'Redact one memory entry from the shared project memory store: the entry leaves its daily memory file and, after reindex, the collection. No copy is kept — the tool result is the only record. Address the entry by chunk_hash (from memory_search) or by date and time (its heading in the daily memory file).',
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        const address = parseForgetAddress(params)
        if (address.mode === 'day') {
          const scope = resolveProjectScope({ baseDir: ctx.cwd, env })
          const file = dailyFilePathForKey(scope.memoryDir, address.date)
          if (!existsSync(file)) throw new Error(`no daily memory file for ${address.date} at ${file}`)
          const content = readFileSync(file, 'utf8')
          const matches = entriesAtTime(content, address.time)
          if (matches.length === 0) throw new Error(`no memory entry at ${address.time} in ${file}`)
          if (matches.length > 1) {
            throw new Error(
              `${matches.length} entries at ${address.time} in ${file}: ambiguous, address one by chunk_hash instead`,
            )
          }
          return redact(file, content, matches[0] as EntrySection, ctx.cwd)
        }
        const { collection, options, scope } = resolveTarget(ctx, env, signal)
        return orInstallInstructions(async () => {
          const section = await backend.expand(address.chunkHash, collection, options)
          const file = resolve(scope.dir, section.source)
          const fromStore = relative(scope.memoryDir, file)
          if (fromStore.startsWith('..') || isAbsolute(fromStore))
            throw new Error(`chunk ${address.chunkHash} lives in ${section.source}, outside the memory store`)
          if (!existsSync(file))
            throw new Error(`chunk ${address.chunkHash} points at ${file}, which no longer exists (reindex pending)`)
          const content = readFileSync(file, 'utf8')
          const candidates = entriesForSection(content, section)
          if (candidates.length === 0)
            throw new Error(`chunk ${address.chunkHash} does not resolve to a memory entry in ${file}`)
          if (candidates.length > 1) {
            throw new Error(
              `chunk ${address.chunkHash} matches ${candidates.length} entries at ${section.heading} in ${file}: ambiguous, edit the file directly`,
            )
          }
          return redact(file, content, candidates[0] as EntrySection, ctx.cwd)
        })
      },
      label: 'Memory forget',
      name: 'memory_forget',
      parameters: Type.Object({
        chunk_hash: Type.Optional(
          Type.String({ description: 'Chunk hash from memory_search; redacts the entry containing that chunk' }),
        ),
        date: Type.Optional(Type.String({ description: 'Daily memory file date (YYYY-MM-DD); pair with time' })),
        time: Type.Optional(Type.String({ description: 'Entry heading time (HH:MM); pair with date' })),
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
        lines.push(...describeAutoContext(autoContext.status()))

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

    pi.registerTool({
      description:
        "Run memsearch memory compaction: an LLM condenses the shared project memory store and appends the summary to today's daily memory file, which is then re-indexed. This is not pi context compaction — the live conversation is untouched. It spends the user's configured LLM budget, so call it only when the user explicitly asks to compact memory.",
      execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
        const { collection, options, scope } = resolveTarget(ctx, env, signal)
        return orInstallInstructions(async () => {
          await bootstrap.ensure(scope.dir)
          const summary = await backend.compact(dirname(scope.memoryDir), collection, options)
          const text = summary ?? 'Nothing to compact: the collection has no indexed chunks.'
          return { content: [{ text, type: 'text' as const }], details: { collection } }
        })
      },
      label: 'Memory compact',
      name: 'memory_compact',
      parameters: Type.Object({}),
    })

    if (env['PI_MEMSEARCH_SNAPSHOT'] !== 'off') {
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
        const block = snapshot !== undefined && snapshotDate === localDateKey(now())
          ? snapshot
          : refreshSnapshot(ctx.cwd)
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` }
      })
      onRedact = refreshSnapshot
    }

    if (autoContext.enabled) {
      pi.on('session_start', (_event, ctx) => {
        autoContext.start(resolveProjectScope({ baseDir: ctx.cwd, env }).dir)
      })
      pi.on('session_shutdown', () => {
        autoContext.stop()
      })
      pi.on('before_agent_start', (event) => autoContext.onPrompt(event.prompt))
    }
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

interface ForgetParams {
  chunk_hash?: string
  date?: string
  time?: string
}

type ForgetAddress = { chunkHash: string; mode: 'chunk' } | { date: string; mode: 'day'; time: string }

function parseForgetAddress(params: ForgetParams): ForgetAddress {
  const byChunk = params.chunk_hash !== undefined
  const byDay = params.date !== undefined || params.time !== undefined
  if (byChunk === byDay)
    throw new Error('memory_forget takes exactly one address: a chunk_hash alone, or date and time together')
  if (byChunk) return { chunkHash: params.chunk_hash as string, mode: 'chunk' }
  if (params.date === undefined || params.time === undefined)
    throw new Error('memory_forget by day needs date and time together')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) throw new Error(`date must be YYYY-MM-DD, got "${params.date}"`)
  if (!/^\d{2}:\d{2}$/.test(params.time)) throw new Error(`time must be HH:MM, got "${params.time}"`)
  return { date: params.date, mode: 'day', time: params.time }
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

function describeAutoContext(status: AutoContextStatus): string[] {
  if (!status.enabled) return [`auto-context: off (set ${AUTO_CONTEXT_ENV}=on to enable)`]
  const identity = [
    status.state ?? 'warming',
    ...(status.provider === undefined ? [] : [`provider ${status.provider}`]),
    ...(status.model === undefined ? [] : [`model ${status.model}`]),
  ]
    .join(', ')
  const { injected, prompts, skippedBudget, skippedEmpty, skippedError } = status.counters
  const lines = [
    `auto-context: on (${identity})`,
    `auto-context prompts: ${prompts} seen, ${injected} injected, ${skippedBudget} skipped-budget, ${skippedEmpty} skipped-empty, ${skippedError} skipped-error`,
  ]
  if (status.lastInjectionMs !== undefined) lines.push(`auto-context last injection: ${status.lastInjectionMs}ms`)
  return lines
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
