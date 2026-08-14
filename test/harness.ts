import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'

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

export function createFakeContext(options: { cwd: string; session: FakeSession }): ExtensionContext {
  const sessionManager = {
    getLeafId: () => options.session.entryId,
    getSessionFile: () => options.session.transcriptPath,
    getSessionId: () => options.session.sessionId,
  }
  return { cwd: options.cwd, sessionManager } as unknown as ExtensionContext
}
