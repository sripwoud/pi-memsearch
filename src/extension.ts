import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { appendMemoryEntry, localDateKey } from './memory-file.ts'
import { resolveProjectScope } from './scope.ts'
import { buildSnapshot } from './snapshot.ts'

export interface MemsearchDeps {
  env: NodeJS.ProcessEnv
  now(): Date
}

export function createMemsearchExtension(deps: Partial<MemsearchDeps> = {}): (pi: ExtensionAPI) => void {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())

  return (pi) => {
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
