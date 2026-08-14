import { equal, match, ok } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface Resource {
  body: string
  fields: Record<string, string>
}

function parseResource(relativePath: string): Resource {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const parts = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/.exec(text)
  if (!parts) throw new Error(`${relativePath} has no frontmatter block`)
  const fields: Record<string, string> = {}
  for (const line of (parts[1] as string).split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) throw new Error(`${relativePath} frontmatter line is not "key: value": "${line}"`)
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { body: parts[2] as string, fields }
}

test('recall skill frontmatter satisfies the agent-skills spec', () => {
  const { fields } = parseResource('../skills/recall/SKILL.md')
  equal(fields['name'], 'recall')
  match(fields['name'] as string, SKILL_NAME_PATTERN)
  ok((fields['name'] as string).length <= 64)
  const description = fields['description'] ?? ''
  ok(description.length > 0, 'description is required for the skill to load')
  ok(description.length <= 1024)
})

test('recall skill instructs the layered tool workflow', () => {
  const { body } = parseResource('../skills/recall/SKILL.md')
  match(body, /memory_search/)
  match(body, /memory_expand/)
  match(body, /transcript/)
})

test('/recall template frontmatter declares description and argument hint', () => {
  const { fields } = parseResource('../prompts/recall.md')
  ok((fields['description'] ?? '').length > 0)
  equal(fields['argument-hint'], '<query>')
})

test('/recall template hands the query to the recall skill', () => {
  const { body } = parseResource('../prompts/recall.md')
  match(body, /recall skill/)
  match(body, /\$@/)
})
