import { deepEqual, equal } from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { spawnSidecarProcess } from '../src/sidecar.ts'
import { setEnvVar } from './harness.ts'

const ECHO_SERVER = [
  'process.stdin.setEncoding("utf8")',
  'let buffer = ""',
  'process.stdin.on("data", (chunk) => {',
  '  buffer += chunk',
  '  while (true) {',
  '    const index = buffer.indexOf("\\n")',
  '    if (index < 0) break',
  '    process.stdout.write("echo:" + buffer.slice(0, index) + "\\n")',
  '    buffer = buffer.slice(index + 1)',
  '  }',
  '})',
  'process.stdin.on("end", () => process.exit(0))',
]
  .join('\n')

function waitForExit(proc: { onExit(handler: () => void): void }): Promise<void> {
  return new Promise((resolve) => {
    proc.onExit(resolve)
  })
}

test('delivers child stdout line by line even when chunks split lines', async () => {
  const lines: string[] = []
  const proc = spawnSidecarProcess(
    process.execPath,
    ['-e', 'process.stdout.write("first"); setTimeout(() => process.stdout.write(" line\\nsecond line\\n"), 20)'],
    { cwd: tmpdir() },
  )
  proc.onLine((line) => lines.push(line))
  await waitForExit(proc)
  deepEqual(lines, ['first line', 'second line'])
})

test('send writes newline-terminated lines to the child stdin', async () => {
  const lines: string[] = []
  const proc = spawnSidecarProcess(process.execPath, ['-e', ECHO_SERVER], { cwd: tmpdir() })
  proc.onLine((line) => lines.push(line))
  proc.send('{"id":1}')
  proc.send('{"id":2}')
  proc.end()
  await waitForExit(proc)
  deepEqual(lines, ['echo:{"id":1}', 'echo:{"id":2}'])
})

test('end closes stdin so a read-until-eof child exits on its own', async () => {
  const proc = spawnSidecarProcess(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: tmpdir() })
  proc.end()
  await waitForExit(proc)
})

test('a missing binary reports exit instead of throwing', async () => {
  const proc = spawnSidecarProcess('pi-memsearch-no-such-binary', [], { cwd: tmpdir() })
  await waitForExit(proc)
})

test('kill terminates the child and reports exit once', async () => {
  let exits = 0
  const proc = spawnSidecarProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: tmpdir() })
  proc.onExit(() => exits++)
  proc.kill()
  await waitForExit(proc)
  equal(exits, 1)
})

test('the child runs in the requested working directory', async () => {
  const lines: string[] = []
  const cwd = realpathSync(tmpdir())
  const proc = spawnSidecarProcess(process.execPath, ['-e', 'process.stdout.write(process.cwd() + "\\n")'], { cwd })
  proc.onLine((line) => lines.push(line))
  await waitForExit(proc)
  deepEqual(lines, [cwd])
})

test('the sidecar sees PYTHONIOENCODING=utf-8 even when the parent carries a non-UTF-8 value', async () => {
  const restore = setEnvVar('PYTHONIOENCODING', 'latin-1')
  try {
    const lines: string[] = []
    const proc = spawnSidecarProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.PYTHONIOENCODING + "\\n")'],
      { cwd: tmpdir() },
    )
    proc.onLine((line) => lines.push(line))
    await waitForExit(proc)
    deepEqual(lines, ['utf-8'])
  } finally {
    restore()
  }
})

test('the sidecar keeps the inherited environment alongside the encoding override', async () => {
  const restore = setEnvVar('PI_MEMSEARCH_TEST_CANARY', 'inherited')
  try {
    const lines: string[] = []
    const proc = spawnSidecarProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.PI_MEMSEARCH_TEST_CANARY + "\\n")'],
      { cwd: tmpdir() },
    )
    proc.onLine((line) => lines.push(line))
    await waitForExit(proc)
    deepEqual(lines, ['inherited'])
  } finally {
    restore()
  }
})

test('send after exit is a safe no-op', async () => {
  const proc = spawnSidecarProcess(process.execPath, ['-e', ''], { cwd: tmpdir() })
  await waitForExit(proc)
  proc.send('{"id":1}')
})
