import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall, UserMessage } from '@earendil-works/pi-ai'
import { type FileEntry, parseSessionEntries, type SessionEntry } from '@earendil-works/pi-coding-agent'

export const DEFAULT_CONTEXT = 3
export const DEFAULT_LIMIT = 20
export const TURN_CHAR_CAP = 2000
const TOOL_CALL_ARGS_SHOWN = 3
const TOOL_CALL_ARG_CAP = 60
const TRUNCATION_MARKER = '[... turn truncated ...]'

export interface TranscriptOptions {
  context: number
  limit: number
  path: string
  turn?: string
}

interface Turn {
  body: string
  branchIndex: number
  label: 'Assistant' | 'User'
  time: string
}

export function renderTranscript(content: string, options: TranscriptOptions): string {
  const entries = parseSessionEntries(content).filter(isSessionEntry)
  const target = options.turn === undefined ? undefined : resolveTarget(entries, options.turn, options.path)
  const branch = resolveBranch(entries, target)
  const turns = renderableTurns(branch)
  if (turns.length === 0) return `no renderable turns in ${options.path}`
  if (target === undefined) return turns.slice(-options.limit).map((turn) => formatTurn(turn, false)).join('\n\n')
  const targetBranchIndex = branch.findIndex((entry) => entry.id === target.id)
  const focus = nearestRenderableTurn(turns, targetBranchIndex)
  const window = turns.slice(Math.max(0, focus - options.context), focus + options.context + 1)
  return window.map((turn) => formatTurn(turn, turn === turns[focus])).join('\n\n')
}

function resolveTarget(entries: SessionEntry[], turn: string, path: string): SessionEntry {
  if (turn === '') throw new Error('turn must be a non-empty entry id or prefix')
  const matches = entries.filter((entry) => entry.id.startsWith(turn))
  if (matches.length === 0) throw new Error(`no entry matching turn "${turn}" in ${path}`)
  if (matches.length > 1)
    throw new Error(`${matches.length} entries match turn "${turn}" in ${path}: ambiguous, give more of the entry id`)
  return matches[0] as SessionEntry
}

function resolveBranch(entries: SessionEntry[], target: SessionEntry | undefined): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const tip = target === undefined ? entries.at(-1) : lastDescendant(entries, target) ?? target
  if (tip === undefined) return []
  const chain: SessionEntry[] = []
  const seen = new Set<string>()
  let current: SessionEntry | undefined = tip
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    chain.push(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return chain.reverse()
}

function lastDescendant(entries: SessionEntry[], target: SessionEntry): SessionEntry | undefined {
  const subtree = new Set([target.id])
  let last: SessionEntry | undefined
  for (const entry of entries) {
    if (entry.id === target.id || entry.parentId === null || !subtree.has(entry.parentId)) continue
    subtree.add(entry.id)
    last = entry
  }
  return last
}

function renderableTurns(branch: SessionEntry[]): Turn[] {
  const turns: Turn[] = []
  branch.forEach((entry, branchIndex) => {
    if (entry.type !== 'message') return
    const role = entry.message.role
    if (role !== 'user' && role !== 'assistant') return
    const body = renderBody(entry.message)
    if (body === '') return
    turns.push({ body, branchIndex, label: role === 'user' ? 'User' : 'Assistant', time: formatTime(entry.timestamp) })
  })
  return turns
}

function nearestRenderableTurn(turns: Turn[], targetBranchIndex: number): number {
  const before = turns.findLastIndex((turn) => turn.branchIndex <= targetBranchIndex)
  return before === -1 ? 0 : before
}

function renderBody(message: AgentMessage): string {
  if (message.role === 'user') return capTurn(userText(message as UserMessage))
  const parts: string[] = []
  for (const block of (message as AssistantMessage).content) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text.trim())
    else if (block.type === 'toolCall') parts.push(formatToolCall(block))
  }
  return capTurn(parts.join('\n'))
}

function userText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content.trim()
  return message
    .content
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter((text) => text !== '')
    .join('\n')
}

function formatToolCall(call: ToolCall): string {
  const names = Object.keys(call.arguments ?? {})
  const args = names
    .slice(0, TOOL_CALL_ARGS_SHOWN)
    .map((name) => `${name}=${clip(argValue(call.arguments[name]))}`)
  if (names.length > TOOL_CALL_ARGS_SHOWN) args.push('…')
  return `${call.name}(${args.join(', ')})`
}

function argValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.replace(/\s+/g, ' ')
}

function clip(text: string): string {
  return text.length <= TOOL_CALL_ARG_CAP ? text : `${text.slice(0, TOOL_CALL_ARG_CAP - 1)}…`
}

function capTurn(body: string): string {
  return body.length <= TURN_CHAR_CAP ? body : `${body.slice(0, TURN_CHAR_CAP)}\n${TRUNCATION_MARKER}`
}

function formatTurn(turn: Turn, isTarget: boolean): string {
  return `[${turn.label}] ${turn.time}${isTarget ? ' (target)' : ''}\n${turn.body}`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== 'session' && typeof (entry as { id?: unknown }).id === 'string'
}
