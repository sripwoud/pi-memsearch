import { doesNotMatch, equal, match, ok } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { MEMSEARCH_SPEC } from '../src/contract.ts'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PINNED_INVOCATION = `uvx --from '${MEMSEARCH_SPEC}' memsearch`

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

test('skill-drafting skill frontmatter satisfies the agent-skills spec', () => {
  const { fields } = parseResource('../skills/skill-drafting/SKILL.md')
  equal(fields['name'], 'skill-drafting')
  match(fields['name'] as string, SKILL_NAME_PATTERN)
  ok((fields['name'] as string).length <= 64)
  const description = fields['description'] ?? ''
  ok(description.length > 0, 'description is required for the skill to load')
  ok(description.length <= 1024)
})

test('skill-drafting description names the trigger phrases', () => {
  const description = parseResource('../skills/skill-drafting/SKILL.md').fields['description'] ?? ''
  match(description, /turn this into a skill/)
  match(description, /review skill candidates/)
  match(description, /install/)
})

test('skill-drafting shows the candidate-store commands and no configure intent', () => {
  const { body } = parseResource('../skills/skill-drafting/SKILL.md')
  match(body, /skills add/)
  match(body, /skills status/)
  match(body, /skills list/)
  match(body, /skills install/)
  doesNotMatch(body, /config set/, 'the configure/background-pass intent is unreachable from pi')
})

test('every memsearch invocation in skill-drafting pins the extension spec', () => {
  const { body } = parseResource('../skills/skill-drafting/SKILL.md')
  const invocations = fencedLines(body).filter((line) => /\bmemsearch\s+(?:skills|transcript|config)\b/.test(line))
  ok(invocations.length >= 4, 'the skill shows concrete memsearch commands')
  for (const line of invocations)
    ok(line.includes(PINNED_INVOCATION), `memsearch invocation drifted off MEMSEARCH_SPEC: "${line.trim()}"`)
  for (const [, spec] of body.matchAll(/--from '([^']+)'/g))
    equal(spec, MEMSEARCH_SPEC, 'a prose mention of the spec drifted off MEMSEARCH_SPEC')
})

test('skill-drafting install flow offers the pi destinations and requires approval', () => {
  const { body } = parseResource('../skills/skill-drafting/SKILL.md')
  match(body, /`\.pi\/skills`/)
  match(body, /~\/\.pi\/agent\/skills/)
  match(body, /fresh pi session/)
  match(body, /[Nn]ever hand-edit/)
})

test('/recall template frontmatter declares description and argument hint', () => {
  const { fields } = parseResource('../prompts/recall.md')
  ok((fields['description'] ?? '').length > 0)
  equal(fields['argument-hint'], '[--all] <query>')
})

test('/recall template hands the query to the recall skill', () => {
  const { body } = parseResource('../prompts/recall.md')
  match(body, /recall skill/)
  match(body, /\$@/)
})

function fencedLines(body: string): string[] {
  const lines: string[] = []
  let inFence = false
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) lines.push(line)
  }
  return lines
}
