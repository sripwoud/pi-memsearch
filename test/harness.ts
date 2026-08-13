import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'

export interface FakeSession {
  sessionId: string
  entryId: string | null
  transcriptPath: string | undefined
}

export interface FakePi {
  pi: ExtensionAPI
  tools: Map<string, ToolDefinition>
}

export function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition>()
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool)
    },
  } as ExtensionAPI
  return { pi, tools }
}

export function createFakeContext(options: { cwd: string; session: FakeSession }): ExtensionContext {
  const sessionManager = {
    getLeafId: () => options.session.entryId,
    getSessionFile: () => options.session.transcriptPath,
    getSessionId: () => options.session.sessionId,
  }
  return { cwd: options.cwd, sessionManager } as unknown as ExtensionContext
}
