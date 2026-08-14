import type { Api, AssistantMessage, Model, StopReason, UserMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelCatalog } from '../src/distillation-model.ts'
import type { ExecFn, ExecOptions, ExecResult } from '../src/exec.ts'
import { createMemsearchExtension } from '../src/extension.ts'

export interface FakeSession {
  sessionId: string
  entryId: string | null
  transcriptPath: string | undefined
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown

export interface FakePi {
  pi: ExtensionAPI
  tools: Map<string, ToolDefinition>
  fire(event: string, payload: object, ctx: ExtensionContext): Promise<unknown[]>
}

export function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition>()
  const handlers = new Map<string, EventHandler[]>()
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool)
    },
  } as unknown as ExtensionAPI

  async function fire(event: string, payload: object, ctx: ExtensionContext): Promise<unknown[]> {
    const results: unknown[] = []
    for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx))
    return results
  }

  return { fire, pi, tools }
}

export function fakeModel(spec: { id: string; provider?: string; input?: number; output?: number }): Model<Api> {
  return {
    api: 'anthropic-messages',
    baseUrl: 'https://example.invalid',
    contextWindow: 200000,
    cost: { cacheRead: 0, cacheWrite: 0, input: spec.input ?? 1, output: spec.output ?? 1 },
    id: spec.id,
    input: ['text'],
    maxTokens: 8192,
    name: spec.id,
    provider: spec.provider ?? 'anthropic',
    reasoning: false,
  } as Model<Api>
}

export function fakeCatalog(models: Model<Api>[]): ModelCatalog {
  return {
    find: (provider, modelId) => models.find((model) => model.provider === provider && model.id === modelId),
    getAvailable: () => models,
  }
}

export function userEntry(id: string, text: string): SessionEntry {
  const message: UserMessage = { content: text, role: 'user', timestamp: 0 }
  return { id, message, parentId: null, timestamp: '2026-08-13T22:40:00.000Z', type: 'message' }
}

export function assistantEntry(id: string, text: string | undefined, stopReason: StopReason = 'stop'): SessionEntry {
  const message = {
    content: text === undefined ? [] : [{ text, type: 'text' as const }],
    role: 'assistant',
    stopReason,
  } as AssistantMessage
  return { id, message, parentId: null, timestamp: '2026-08-13T22:40:30.000Z', type: 'message' }
}

export interface RecordedCall {
  args: string[]
  command: string
  options: ExecOptions
}

export type FakeExecStep = ExecResult | Error | ((call: RecordedCall) => Promise<ExecResult>)

export function createFakeExec(steps: FakeExecStep[]): { calls: RecordedCall[]; exec: ExecFn } {
  const calls: RecordedCall[] = []
  const remaining = [...steps]
  const exec: ExecFn = async (command, args, options) => {
    const call = { args, command, options }
    calls.push(call)
    const step = remaining.shift()
    if (!step) throw new Error(`unexpected exec call: ${command} ${args.join(' ')}`)
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(call)
    return step
  }
  return { calls, exec }
}

export function createFakeContext(options: {
  cwd: string
  session: FakeSession
  branch?: SessionEntry[]
  model?: Model<Api> | undefined
  models?: Model<Api>[]
}): ExtensionContext {
  const sessionManager = {
    getBranch: () => options.branch ?? [],
    getLeafId: () => options.session.entryId,
    getSessionFile: () => options.session.transcriptPath,
    getSessionId: () => options.session.sessionId,
  }
  const modelRegistry = fakeCatalog(options.models ?? [])
  return { cwd: options.cwd, model: options.model, modelRegistry, sessionManager } as unknown as ExtensionContext
}

export const TEST_SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl',
}

export interface SetupOptions {
  clock?: () => Date
  env?: NodeJS.ProcessEnv
  prefix?: string
  sleep?: (ms: number) => Promise<void>
}

export function setupExtension(steps: FakeExecStep[], options: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), options.prefix ?? 'pi-memsearch-'))
  mkdirSync(join(root, '.git'))
  const { pi, tools } = createFakePi()
  const { calls, exec } = createFakeExec(steps)
  const sleeps: number[] = []
  createMemsearchExtension({
    env: options.env ?? {},
    exec,
    now: options.clock ?? (() => new Date(2026, 7, 13, 22, 41)),
    sleep: options.sleep
      ?? (async (ms) => {
        sleeps.push(ms)
      }),
  })(pi)
  const ctx = createFakeContext({ cwd: root, session: TEST_SESSION })
  return { calls, ctx, root, sleeps, tools }
}
