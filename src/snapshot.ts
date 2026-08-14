import { existsSync, readFileSync } from 'node:fs'
import { dailyFilePath, localDateKey } from './memory-file.ts'

const TODAY_BUDGET = 3000
const YESTERDAY_BUDGET = 2000
const TRUNCATION_MARKER = '[earlier entries truncated]'

const INSTRUCTIONS = `## Project memory

The project memory store (\`.memsearch/memory/\`) holds one daily memory file per calendar day, shared by every coding agent working in this repository. Recent entries are included below; each is timestamped and anchored to the session that produced it.

- Call the \`memory_write\` tool when the user asks you to remember something, or when a decision, fix, or fact should survive this session. Write third-person markdown bullets in the primary language of the conversation.
- Check the entries below before re-deriving how something was already solved or decided.
- This block is refreshed only at checkpoints (session start, day rollover, compaction); entries written mid-session appear in tool results, not here.`

export function buildSnapshot(memoryDir: string, now: Date): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const sections = [
    INSTRUCTIONS,
    daySection(memoryDir, 'Today', now, TODAY_BUDGET),
    daySection(memoryDir, 'Yesterday', yesterday, YESTERDAY_BUDGET),
  ]
  return sections.filter((section): section is string => section !== undefined).join('\n\n')
}

function daySection(memoryDir: string, label: string, date: Date, budget: number): string | undefined {
  const file = dailyFilePath(memoryDir, date)
  if (!existsSync(file)) return undefined
  const content = readFileSync(file, 'utf8').trim()
  if (content === '') return undefined

  const tail = tailWithinBudget(content, budget)
  const heading = `### ${label} (${localDateKey(date)})`
  if (tail.length < content.length) return `${heading}\n\n${TRUNCATION_MARKER}\n${tail}`
  return `${heading}\n\n${tail}`
}

function tailWithinBudget(content: string, budget: number): string {
  if (content.length <= budget) return content
  const hardCut = content.slice(content.length - budget)
  const newline = hardCut.indexOf('\n')
  const lineAligned = newline === -1 ? hardCut : hardCut.slice(newline + 1)
  return lineAligned === '' ? hardCut : lineAligned
}
