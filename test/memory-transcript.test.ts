import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { doesNotMatch, equal, match, ok, rejects } from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setupExtension } from './harness.ts'

function setup() {
  const harness = setupExtension([], { prefix: 'memory-transcript-' })
  const tool = harness.tools.get('memory_transcript')
  ok(tool, 'memory_transcript tool is registered')
  return { ...harness, tool }
}

async function read(tool: ToolDefinition, ctx: ExtensionContext, params: object): Promise<string> {
  const result = await tool.execute('call-1', params, undefined, undefined, ctx)
  const first = result.content[0]
  ok(first?.type === 'text')
  return first.text
}

function stamp(minute: number): string {
  return new Date(2026, 7, 13, 9, minute).toISOString()
}

function header(): object {
  return { cwd: '/w', id: '3f2c9b1e-8d4a-4f6b-9c0d-1a2b3c4d5e6f', timestamp: stamp(0), type: 'session', version: 3 }
}

function user(id: string, parentId: string | null, text: string, minute: number): object {
  return {
    id,
    message: { content: [{ text, type: 'text' }], role: 'user', timestamp: 0 },
    parentId,
    timestamp: stamp(minute),
    type: 'message',
  }
}

function assistant(id: string, parentId: string | null, content: object[], minute: number): object {
  return {
    id,
    message: { content, role: 'assistant', stopReason: 'stop', timestamp: 0 },
    parentId,
    timestamp: stamp(minute),
    type: 'message',
  }
}

function toolResult(id: string, parentId: string, text: string, minute: number): object {
  return {
    id,
    message: {
      content: [{ text, type: 'text' }],
      isError: false,
      role: 'toolResult',
      timestamp: 0,
      toolCallId: 'call-9',
      toolName: 'bash',
    },
    parentId,
    timestamp: stamp(minute),
    type: 'message',
  }
}

function text(body: string): object {
  return { text: body, type: 'text' }
}

function seedTranscript(root: string, lines: object[], raw: string[] = []): string {
  const file = join(root, 'session.jsonl')
  writeFileSync(file, [...lines.map((line) => JSON.stringify(line)), ...raw].join('\n'))
  return file
}

function linearSession(): object[] {
  return [
    header(),
    user('a1a1a1a1', null, 'first question', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('first answer')], 2),
    user('a2a2a2a2', 'b1b1b1b1', 'second question', 3),
    assistant('b2b2b2b2', 'a2a2a2a2', [text('second answer')], 4),
    user('a3a3a3a3', 'b2b2b2b2', 'third question', 5),
    assistant('b3b3b3b3', 'a3a3a3a3', [text('third answer')], 6),
  ]
}

test('without a turn the live branch tail renders with labels and times', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /\[User\] 09:01\nfirst question/)
  match(output, /\[Assistant\] 09:06\nthird answer/)
  ok(output.indexOf('first question') < output.indexOf('third answer'))
  doesNotMatch(output, /\(target\)/)
})

test('limit caps the rendered tail turns', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  const output = await read(tool, ctx, { limit: 2, transcript_path: file })
  doesNotMatch(output, /second answer/)
  match(output, /third question/)
  match(output, /third answer/)
})

test('a turn id windows context around the target and marks it', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  const output = await read(tool, ctx, { context: 1, transcript_path: file, turn: 'a2a2a2a2' })
  match(output, /\[User\] 09:03 \(target\)\nsecond question/)
  match(output, /first answer/)
  match(output, /second answer/)
  doesNotMatch(output, /first question/)
  doesNotMatch(output, /third question/)
})

test('context zero renders only the target turn', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  const output = await read(tool, ctx, { context: 0, transcript_path: file, turn: 'a2a2a2a2' })
  equal(output, '[User] 09:03 (target)\nsecond question')
})

test('the live branch continues the target when its chain passes through it', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    user('a1a1a1a1', null, 'first question', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('first answer')], 2),
    user('c1c1c1c1', 'b1b1b1b1', 'abandoned follow-up', 3),
    assistant('d1d1d1d1', 'c1c1c1c1', [text('abandoned answer')], 4),
    user('c2c2c2c2', 'b1b1b1b1', 'live follow-up', 5),
    assistant('d2d2d2d2', 'c2c2c2c2', [text('live answer')], 6),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { context: 5, transcript_path: file, turn: 'a1a1a1a1' })
  match(output, /live follow-up/)
  match(output, /live answer/)
  doesNotMatch(output, /abandoned follow-up/)
})

test('a fork after the target does not amputate its continuation', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    user('a1a1a1a1', null, 'first question', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('first answer')], 2),
    user('c1c1c1c1', 'b1b1b1b1', 'anchored question', 3),
    assistant('d1d1d1d1', 'c1c1c1c1', [text('anchored answer')], 4),
    user('c2c2c2c2', 'b1b1b1b1', 'live sibling question', 5),
    assistant('d2d2d2d2', 'c2c2c2c2', [text('live sibling answer')], 6),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { context: 5, transcript_path: file, turn: 'c1c1c1c1' })
  match(output, /anchored answer/)
  doesNotMatch(output, /live sibling question/)
  doesNotMatch(output, /live sibling answer/)
})

test('the most recent leaf inside the target subtree continues the exchange', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    user('a1a1a1a1', null, 'first question', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('first answer')], 2),
    user('c1c1c1c1', 'b1b1b1b1', 'anchored question', 3),
    assistant('d1d1d1d1', 'c1c1c1c1', [text('anchored answer')], 4),
    user('e1e1e1e1', 'd1d1d1d1', 'older subtree follow-up', 5),
    user('e2e2e2e2', 'd1d1d1d1', 'newer subtree follow-up', 6),
    user('c2c2c2c2', 'b1b1b1b1', 'live sibling question', 7),
    assistant('d2d2d2d2', 'c2c2c2c2', [text('live sibling answer')], 8),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { context: 5, transcript_path: file, turn: 'c1c1c1c1' })
  match(output, /newer subtree follow-up/)
  doesNotMatch(output, /older subtree follow-up/)
  doesNotMatch(output, /live sibling/)
})

test('a unique turn prefix resolves', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  const output = await read(tool, ctx, { context: 0, transcript_path: file, turn: 'a2' })
  match(output, /second question/)
})

test('an unknown turn fails naming what was looked for', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  await rejects(() => read(tool, ctx, { transcript_path: file, turn: 'ffffffff' }), /no entry matching turn "ffffffff"/)
})

test('an ambiguous turn prefix fails with the match count', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  await rejects(() => read(tool, ctx, { transcript_path: file, turn: 'a' }), /3 entries match turn "a"/)
})

test('an empty turn fails instead of matching everything', async () => {
  const { ctx, root, tool } = setup()
  const file = seedTranscript(root, linearSession())
  await rejects(() => read(tool, ctx, { transcript_path: file, turn: '' }), /non-empty/)
})

test('a missing transcript fails naming the path', async () => {
  const { ctx, root, tool } = setup()
  const missing = join(root, 'gone.jsonl')
  await rejects(() => read(tool, ctx, { transcript_path: missing }), new RegExp(`no transcript file at ${missing}`))
})

test('an unreadable transcript fails naming the path', async () => {
  const { ctx, root, tool } = setup()
  const directory = join(root, 'dir.jsonl')
  mkdirSync(directory)
  await rejects(
    () => read(tool, ctx, { transcript_path: directory }),
    new RegExp(`could not read transcript at ${directory}`),
  )
})

test('a target downstream of a fork skips the abandoned sibling branch', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    user('a1a1a1a1', null, 'first question', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('first answer')], 2),
    user('c1c1c1c1', 'b1b1b1b1', 'abandoned follow-up', 3),
    assistant('d1d1d1d1', 'c1c1c1c1', [text('abandoned answer')], 4),
    user('c2c2c2c2', 'b1b1b1b1', 'live follow-up', 5),
    assistant('d2d2d2d2', 'c2c2c2c2', [text('live answer')], 6),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { context: 5, transcript_path: file, turn: 'c2c2c2c2' })
  match(output, /\[User\] 09:05 \(target\)\nlive follow-up/)
  match(output, /first question/)
  match(output, /live answer/)
  doesNotMatch(output, /abandoned/)
})

test('thinking and images are dropped and tool results folded away', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    user('a1a1a1a1', null, 'run the check', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [
      { thinking: 'secret reasoning', type: 'thinking' },
      text('running it now'),
      { arguments: { command: 'mise run check' }, id: 'call-9', name: 'bash', type: 'toolCall' },
    ], 2),
    toolResult('f1f1f1f1', 'b1b1b1b1', 'raw tool output here', 3),
    assistant('b2b2b2b2', 'f1f1f1f1', [text('all green')], 4),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /running it now\nbash\(command=mise run check\)/)
  match(output, /all green/)
  doesNotMatch(output, /secret reasoning/)
  doesNotMatch(output, /raw tool output here/)
})

test('tool call one-liners keep three args and cap values at sixty chars', async () => {
  const { ctx, root, tool } = setup()
  const long = 'y'.repeat(80)
  const lines = [
    header(),
    user('a1a1a1a1', null, 'go', 1),
    assistant('b1b1b1b1', 'a1a1a1a1', [
      {
        arguments: { alpha: long, bravo: 2, charlie: true, delta: 'dropped' },
        id: 'c',
        name: 'edit',
        type: 'toolCall',
      },
    ], 2),
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, new RegExp(`edit\\(alpha=${'y'.repeat(59)}…, bravo=2, charlie=true, …\\)`))
  doesNotMatch(output, /delta/)
})

test('a turn longer than the cap is truncated', async () => {
  const { ctx, root, tool } = setup()
  const lines = [header(), user('a1a1a1a1', null, 'z'.repeat(3000), 1)]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /\[\.\.\. turn truncated \.\.\.\]/)
  match(output, new RegExp('z'.repeat(2000)))
  doesNotMatch(output, new RegExp('z'.repeat(2001)))
})

test('user content as a bare string renders', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    {
      id: 'a1a1a1a1',
      message: { content: 'plain string prompt', role: 'user', timestamp: 0 },
      parentId: null,
      timestamp: stamp(1),
      type: 'message',
    },
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /\[User\] 09:01\nplain string prompt/)
})

test('unparseable lines and non-message entries are skipped', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    {
      id: '9e9e9e9e',
      modelId: 'claude',
      parentId: null,
      provider: 'anthropic',
      timestamp: stamp(1),
      type: 'model_change',
    },
    user('a1a1a1a1', '9e9e9e9e', 'only question', 2),
    assistant('b1b1b1b1', 'a1a1a1a1', [text('only answer')], 3),
  ]
  const file = seedTranscript(root, lines, ['this line is not json'])
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /only question/)
  doesNotMatch(output, /model_change/)
})

test('a transcript with no renderable turns says so plainly', async () => {
  const { ctx, root, tool } = setup()
  const lines = [
    header(),
    {
      id: '9e9e9e9e',
      modelId: 'claude',
      parentId: null,
      provider: 'anthropic',
      timestamp: stamp(1),
      type: 'model_change',
    },
  ]
  const file = seedTranscript(root, lines)
  const output = await read(tool, ctx, { transcript_path: file })
  match(output, /no renderable turns in /)
})
