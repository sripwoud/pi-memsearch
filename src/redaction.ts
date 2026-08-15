const ENTRY_HEADING = /^###\s+(\d{2}:\d{2})\s*$/
const SECTION_BOUNDARY = /^#{1,3}\s/
const SESSION_HEADING = /^##\s/
const SESSION_BOUNDARY = /^#{1,2}\s/
const COMPACT_HEADING = /^##\s+Memory Compact\s*$/
const TITLE_HEADING = /^#\s/

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

export function entriesAtTime(content: string, time: string): EntrySection[] {
  return listEntries(content).filter((entry) => entry.time === time)
}

export interface SectionAddress {
  anchor?: { session: string; turn: string }
  end_line: number
  heading: string
  start_line: number
}

// Expanded sections pad the chunk with surrounding context, so their line range may start inside a
// neighboring entry; only the heading and anchor are guaranteed to belong to the chunk itself.
export function entriesForSection(content: string, section: SectionAddress): EntrySection[] {
  const inWindow = entriesAtTime(content, section.heading).filter(
    (entry) => section.start_line <= entry.start && entry.start <= section.end_line,
  )
  const anchor = section.anchor
  if (!anchor) return inWindow
  return inWindow.filter((entry) => entry.text.includes(`session:${anchor.session} turn:${anchor.turn} `))
}

export interface CompactBlock {
  end: number
  start: number
  text: string
}

/**
 * A same-session entry written after a compact run gets no fresh `## Session` heading, so a bare
 * timestamp entry heading also ends a block — otherwise removing the block would take the entry.
 */
export function listCompactBlocks(content: string): CompactBlock[] {
  const lines = content.split('\n')
  const blocks: CompactBlock[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!COMPACT_HEADING.test(lines[index] as string)) continue
    let end = index + 1
    while (
      end < lines.length && !SESSION_BOUNDARY.test(lines[end] as string) && !ENTRY_HEADING.test(lines[end] as string)
    ) { end++ }
    const body = lines.slice(index, end)
    while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop()
    blocks.push({ end, start: index + 1, text: body.join('\n') })
  }
  return blocks
}

/**
 * Chunks inside a compact block carry the summary's nearest heading, which may be a sub-heading
 * rather than "Memory Compact", so blocks are matched by line-range overlap — but the stamped
 * heading must appear as a heading line inside the block, so a stale window from an entry chunk
 * can never fall through to deleting a block it merely overlaps.
 */
export function compactBlocksForSection(content: string, section: SectionAddress): CompactBlock[] {
  return listCompactBlocks(content).filter(
    (block) =>
      section.start_line <= block.end && block.start <= section.end_line
      && blockHasHeading(block, section.heading),
  )
}

function blockHasHeading(block: CompactBlock, heading: string): boolean {
  return block.text.split('\n').some((line) => /^#{2,}\s+(.*?)\s*$/.exec(line)?.[1] === heading)
}

export function removeCompactBlock(content: string, block: CompactBlock): string {
  const lines = content.split('\n')
  lines.splice(block.start - 1, block.end - block.start + 1)
  const meaningful = lines.some((line) => line.trim() !== '' && !TITLE_HEADING.test(line))
  return meaningful ? lines.join('\n') : ''
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
    if (next < lines.length && !SESSION_BOUNDARY.test(lines[next] as string)) {
      kept.push(line)
      continue
    }
    index = next - 1
  }
  return kept
}
