import type { Api, Model } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { equal, match, ok } from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Complete, DISTILLATION_SYSTEM_PROMPT, type DistillationRequest } from '../src/capture.ts'
import { createMemsearchExtension } from '../src/extension.ts'
import { assistantEntry, createFakeContext, createFakePi, fakeModel, type FakeSession, userEntry } from './harness.ts'

const TRANSCRIPT = '/home/user/.pi/agent/sessions/--project--/2026-08-13_abc.jsonl'

const SESSION: FakeSession = {
  entryId: 'ab12cd34',
  sessionId: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f',
  transcriptPath: TRANSCRIPT,
}

const BULLETS = '- the user asked for a bug fix\n- the agent fixed it'

function setup(options: {
  branch: SessionEntry[]
  complete?: Complete
  env?: NodeJS.ProcessEnv
  model?: Model<Api> | undefined
  models?: Model<Api>[]
  session?: FakeSession
  timeoutMs?: number
}) {
  const root = mkdtempSync(join(tmpdir(), 'capture-'))
  mkdirSync(join(root, '.git'))

  const requests: DistillationRequest[] = []
  const tasks: Promise<void>[] = []
  const inner = options.complete ?? (async () => BULLETS)
  const complete: Complete = (request) => {
    requests.push(request)
    return inner(request)
  }

  const { fire, pi } = createFakePi()
  createMemsearchExtension({
    complete,
    distillationTimeoutMs: options.timeoutMs ?? 1000,
    env: options.env ?? {},
    now: () => new Date(2026, 7, 13, 22, 41),
    schedule: (task) => {
      tasks.push(task())
    },
  })(pi)

  const ctx = createFakeContext({
    branch: options.branch,
    cwd: root,
    model: 'model' in options ? options.model : fakeModel({ id: 'session-model' }),
    models: options.models ?? [],
    session: options.session ?? SESSION,
  })
  const settle = async () => {
    await fire('agent_settled', {}, ctx)
    await Promise.all(tasks)
  }
  return { file: join(root, '.memsearch', 'memory', '2026-08-13.md'), requests, settle, tasks }
}

test('settled exchange with assistant text appends a distilled anchored entry', async () => {
  const { file, requests, settle } = setup({
    branch: [userEntry('u1', 'fix the login bug'), assistantEntry('a1', 'fixed it by escaping the query')],
  })

  await settle()

  equal(
    readFileSync(file, 'utf8'),
    `\n## Session 22:41\n\n### 22:41\n<!-- session:${SESSION.sessionId} turn:a1 transcript:${TRANSCRIPT} -->\n${BULLETS}\n\n`,
  )
  equal(requests.length, 1)
  const request = requests[0]
  ok(request)
  equal(request.systemPrompt, DISTILLATION_SYSTEM_PROMPT)
  equal(request.model.id, 'session-model')
  match(request.transcript, /\[User\]: fix the login bug/)
  match(request.transcript, /\[Assistant\]: fixed it by escaping the query/)
})

test('no assistant text means no entry and no distillation call', async () => {
  const { file, requests, settle, tasks } = setup({
    branch: [userEntry('u1', 'just a prompt'), assistantEntry('a1', undefined)],
  })

  await settle()

  equal(tasks.length, 0)
  equal(requests.length, 0)
  ok(!existsSync(file))
})

test('aborted run means no entry and no distillation call', async () => {
  const { file, requests, settle, tasks } = setup({
    branch: [userEntry('u1', 'do something'), assistantEntry('a1', 'partial answer', 'aborted')],
  })

  await settle()

  equal(tasks.length, 0)
  equal(requests.length, 0)
  ok(!existsSync(file))
})

test('PI_MEMSEARCH_CAPTURE=off disables capture entirely', async () => {
  const { file, requests, settle, tasks } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    env: { PI_MEMSEARCH_CAPTURE: 'off' },
  })

  await settle()

  equal(tasks.length, 0)
  equal(requests.length, 0)
  ok(!existsSync(file))
})

test('a session without a transcript file is not captured', async () => {
  const { file, requests, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    session: { ...SESSION, transcriptPath: undefined },
  })

  await settle()

  equal(requests.length, 0)
  ok(!existsSync(file))
})

test('distillation failure writes a diagnostic marker with the anchor retained', async () => {
  const { file, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    complete: async () => {
      throw new Error('provider exploded')
    },
  })

  await settle()

  const content = readFileSync(file, 'utf8')
  match(content, new RegExp(`<!-- session:${SESSION.sessionId} turn:a1 transcript:${TRANSCRIPT} -->`))
  match(content, /- \[pi-memsearch\] distillation failed: provider exploded/)
})

test('distillation timeout writes a diagnostic marker', async () => {
  const { file, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    complete: () => new Promise(() => {}),
    timeoutMs: 10,
  })

  await settle()

  match(readFileSync(file, 'utf8'), /distillation failed: distillation timed out after 10ms/)
})

test('empty distillation output writes a diagnostic marker', async () => {
  const { file, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    complete: async () => '  \n ',
  })

  await settle()

  match(readFileSync(file, 'utf8'), /distillation failed: distillation returned no text/)
})

test('PI_MEMSEARCH_CAPTURE_MODEL override routes distillation to that model', async () => {
  const { requests, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    env: { PI_MEMSEARCH_CAPTURE_MODEL: 'openai/gpt-mini' },
    models: [fakeModel({ id: 'gpt-mini', provider: 'openai' })],
  })

  await settle()

  equal(requests[0]?.model.id, 'gpt-mini')
})

test('unresolvable capture model writes a diagnostic marker instead of silently falling back', async () => {
  const { file, requests, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    env: { PI_MEMSEARCH_CAPTURE_MODEL: 'ghost' },
  })

  await settle()

  equal(requests.length, 0)
  match(readFileSync(file, 'utf8'), /distillation failed: capture model 'ghost' not found/)
})

test('default model is the cheapest available one from the session provider', async () => {
  const expensive = fakeModel({ id: 'big', input: 15, output: 75 })
  const { requests, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
    model: expensive,
    models: [expensive, fakeModel({ id: 'small', input: 1, output: 5 })],
  })

  await settle()

  equal(requests[0]?.model.id, 'small')
})

test('the same settled exchange is never captured twice', async () => {
  const { file, requests, settle } = setup({
    branch: [userEntry('u1', 'fix it'), assistantEntry('a1', 'done')],
  })

  await settle()
  await settle()

  equal(requests.length, 1)
  equal(readFileSync(file, 'utf8').match(/^### /gm)?.length, 1)
})

test('a gated exchange never becomes distillation input for the next capture', async () => {
  const branch = [userEntry('u1', 'discarded aborted prompt'), assistantEntry('a1', 'partial', 'aborted')]
  const { file, requests, settle } = setup({ branch })

  await settle()
  branch.push(userEntry('u2', 'second prompt'), assistantEntry('a2', 'second answer'))
  await settle()

  equal(requests.length, 1)
  ok(!/discarded aborted prompt/.test(requests[0]?.transcript ?? ''))
  match(requests[0]?.transcript ?? '', /second prompt/)
  match(readFileSync(file, 'utf8'), /turn:a2/)
})

test('a later exchange captures only the messages since the last capture', async () => {
  const branch = [userEntry('u1', 'first prompt'), assistantEntry('a1', 'first answer')]
  const { file, requests, settle } = setup({ branch })

  await settle()
  branch.push(userEntry('u2', 'second prompt'), assistantEntry('a2', 'second answer'))
  await settle()

  equal(requests.length, 2)
  match(requests[1]?.transcript ?? '', /second prompt/)
  ok(!/first prompt/.test(requests[1]?.transcript ?? ''))
  equal(readFileSync(file, 'utf8').match(/^### /gm)?.length, 2)
  match(readFileSync(file, 'utf8'), /turn:a2/)
})
