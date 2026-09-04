import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MemoryEntry {
  content: string
  entryId: string
  sessionId: string
  timestamp: Date
  transcriptPath: string
}

const headedSessions = new Set<string>()

export function appendMemoryEntry(memoryDir: string, entry: MemoryEntry): string {
  const file = dailyFilePath(memoryDir, entry.timestamp)
  const time = formatTime(entry.timestamp)
  const key = `${file}\0${entry.sessionId}`

  let block = ''
  if (!headedSessions.has(key) && !dailyFileHasSession(file, entry.sessionId))
    block += `\n## Session ${time}\n\n`
  block += `### ${time}\n`
  block += `${formatSessionAnchor(entry)}\n`
  block += `${entry.content}\n\n`

  mkdirSync(memoryDir, { recursive: true })
  appendFileSync(file, block)
  headedSessions.add(key)
  return file
}

function dailyFileHasSession(file: string, sessionId: string): boolean {
  if (!existsSync(file)) return false
  return readFileSync(file, 'utf8').includes(`session:${sessionId}`)
}

export function dailyFilePath(memoryDir: string, date: Date): string {
  return dailyFilePathForKey(memoryDir, localDateKey(date))
}

export function dailyFilePathForKey(memoryDir: string, dateKey: string): string {
  return join(memoryDir, `${dateKey}.md`)
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatSessionAnchor(entry: MemoryEntry): string {
  return `<!-- session:${entry.sessionId} turn:${entry.entryId} transcript:${entry.transcriptPath} -->`
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
