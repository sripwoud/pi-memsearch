import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent'

export interface Exchange {
  lastEntryId: string
  messages: AgentMessage[]
}

export function extractExchange(branch: SessionEntry[], afterEntryId?: string): Exchange | undefined {
  const entries = exchangeWindow(branch, afterEntryId).filter(isMessageEntry)
  const last = entries.at(-1)
  if (!last) return undefined
  return { lastEntryId: last.id, messages: entries.map((entry) => entry.message) }
}

export function passesHardGates(messages: AgentMessage[]): boolean {
  return (
    messages.some((message) => message.role === 'user')
    && hasAssistantText(messages)
    && lastAssistant(messages)?.stopReason !== 'aborted'
  )
}

function exchangeWindow(branch: SessionEntry[], afterEntryId: string | undefined): SessionEntry[] {
  if (afterEntryId) {
    const index = branch.findIndex((entry) => entry.id === afterEntryId)
    if (index !== -1) return branch.slice(index + 1)
  }
  const lastUser = branch.findLastIndex(
    (entry) => isMessageEntry(entry) && entry.message.role === 'user',
  )
  return lastUser === -1 ? [] : branch.slice(lastUser)
}

// The type check doubles as the barrier keeping injected custom_message entries (auto-context) out of capture.
function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message'
}

function hasAssistantText(messages: AgentMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant'
      && message.content.some((block) => block.type === 'text' && block.text.trim() !== ''),
  )
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  return messages.findLast((message) => message.role === 'assistant') as AssistantMessage | undefined
}
