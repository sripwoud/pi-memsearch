import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { completeSimple } from '@earendil-works/pi-ai/compat'
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  serializeConversation,
} from '@earendil-works/pi-coding-agent'
import { resolveDistillationModel } from './distillation-model.ts'
import { extractExchange, passesHardGates } from './exchange.ts'
import { appendMemoryEntry } from './memory-file.ts'
import { resolveProjectScope } from './scope.ts'

export const DISTILLATION_SYSTEM_PROMPT = `You distill one coding-agent exchange into long-term memory notes.
Write 2-10 markdown bullets ("- "), third person, past tense, in the user's primary language from the exchange.
Each bullet is one standalone fact worth recalling later: decisions made, fixes applied, facts learned, preferences stated, open follow-ups.
Refer to the user as "the user" and to the assistant as "the agent".
Output only the bullets: no headings, no preamble, no code fences.`

export const DEFAULT_DISTILLATION_TIMEOUT_MS = 30_000

const TRANSCRIPT_HEAD_CHARS = 10_000
const TRANSCRIPT_TAIL_CHARS = 70_000

export interface DistillationRequest {
  model: Model<Api>
  signal: AbortSignal
  systemPrompt: string
  transcript: string
}

export type Complete = (request: DistillationRequest) => Promise<string>

export interface CaptureDeps {
  complete: Complete | undefined
  distillationTimeoutMs: number
  env: NodeJS.ProcessEnv
  now(): Date
  schedule(task: () => Promise<void>): void
}

export function registerCapture(pi: ExtensionAPI, deps: CaptureDeps): void {
  let lastCapturedEntryId: string | undefined

  pi.on('agent_settled', (_event, ctx) => {
    if (deps.env['PI_MEMSEARCH_CAPTURE'] === 'off') return
    const transcriptPath = ctx.sessionManager.getSessionFile()
    if (!transcriptPath) return

    const exchange = extractExchange(ctx.sessionManager.getBranch(), lastCapturedEntryId)
    if (!exchange) return
    lastCapturedEntryId = exchange.lastEntryId
    if (!passesHardGates(exchange.messages)) return

    const anchor = {
      entryId: exchange.lastEntryId,
      sessionId: ctx.sessionManager.getSessionId(),
      timestamp: deps.now(),
      transcriptPath,
    }
    const memoryDir = resolveProjectScope({ baseDir: ctx.cwd, env: deps.env }).memoryDir
    const transcript = serializeExchange(exchange.messages)
    const complete = deps.complete ?? defaultComplete(ctx)

    deps.schedule(async () => {
      try {
        const model = resolveDistillationModel({
          catalog: ctx.modelRegistry,
          env: deps.env,
          sessionModel: ctx.model,
        })
        const content = await distill(complete, { model, transcript }, deps.distillationTimeoutMs)
        appendMemoryEntry(memoryDir, { ...anchor, content })
      } catch (error) {
        appendMemoryEntry(memoryDir, { ...anchor, content: diagnosticMarker(error) })
      }
    })
  })
}

async function distill(
  complete: Complete,
  request: { model: Model<Api>; transcript: string },
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController()
  const timedOut = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`distillation timed out after ${timeoutMs}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })
  try {
    const text = await Promise.race([
      complete({ ...request, signal: controller.signal, systemPrompt: DISTILLATION_SYSTEM_PROMPT }),
      timedOut,
    ])
    const trimmed = text.trim()
    if (!trimmed) throw new Error('distillation returned no text')
    return trimmed
  } finally {
    controller.abort()
  }
}

function diagnosticMarker(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return `- [pi-memsearch] distillation failed: ${reason}`
}

function serializeExchange(messages: AgentMessage[]): string {
  const text = serializeConversation(convertToLlm(messages))
  if (text.length <= TRANSCRIPT_HEAD_CHARS + TRANSCRIPT_TAIL_CHARS) return text
  return `${text.slice(0, TRANSCRIPT_HEAD_CHARS)}\n\n[... exchange truncated ...]\n\n${
    text.slice(-TRANSCRIPT_TAIL_CHARS)
  }`
}

function defaultComplete(ctx: ExtensionContext): Complete {
  return async ({ model, signal, systemPrompt, transcript }) => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) throw new Error(auth.error)

    const options: SimpleStreamOptions = { cacheRetention: 'none', signal }
    if (auth.apiKey !== undefined) options.apiKey = auth.apiKey
    if (auth.headers !== undefined) options.headers = auth.headers
    if (auth.env !== undefined) options.env = auth.env
    if (model.reasoning) options.reasoning = 'low'

    const response = await completeSimple(
      model,
      { messages: [{ content: transcript, role: 'user', timestamp: Date.now() }], systemPrompt },
      options,
    )
    if (response.stopReason === 'error' || response.stopReason === 'aborted')
      throw new Error(response.errorMessage ?? `distillation stopped: ${response.stopReason}`)
    return response
      .content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
}
