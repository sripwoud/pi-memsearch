const ENTRY_HEADING = /^###\s+(\d{2}:\d{2})\s*$/
const SECTION_BOUNDARY = /^#{1,3}\s/
const SESSION_HEADING = /^#{1,2}\s/

export interface EntrySection {
  end: number
  start: number
  text: string
  time: string
}

export function listEntries(content: string): EntrySection[] {
  const lines = content.split('\n')
  const entries: EntrySection[] = []
  for (let index = 0; index < lines.length; index++) {
    const time = ENTRY_HEADING.exec(lines[index] as string)?.[1]
    if (time === undefined) continue
    let end = index + 1
    while (end < lines.length && !SECTION_BOUNDARY.test(lines[end] as string)) end++
    const body = lines.slice(index, end)
    while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop()
    entries.push({ end, start: index + 1, text: body.join('\n'), time })
  }
  return entries
}

export function removeEntry(content: string, entry: EntrySection): string {
  const lines = content.split('\n')
  lines.splice(entry.start - 1, entry.end - entry.start + 1)
  const kept = withoutEmptySessionHeadings(lines)
  return kept.some((line) => line.trim() !== '') ? kept.join('\n') : ''
}

function withoutEmptySessionHeadings(lines: string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    if (!SESSION_HEADING.test(line)) {
      kept.push(line)
      continue
    }
    let next = index + 1
    while (next < lines.length && (lines[next] as string).trim() === '') next++
    if (next < lines.length && !SESSION_HEADING.test(lines[next] as string)) {
      kept.push(line)
      continue
    }
    index = next - 1
  }
  return kept
}
