import { equal, rejects } from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execProcess } from '../src/exec.ts'
import { setEnvVar } from './harness.ts'

test('captures stdout, stderr and exit code', async () => {
  const result = await execProcess(
    process.execPath,
    ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
    { timeoutMs: 5000 },
  )
  equal(result.stdout, 'out')
  equal(result.stderr, 'err')
  equal(result.exitCode, 3)
  equal(result.signal, null)
})

test('runs the child in the given working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-cwd-'))
  const result = await execProcess(process.execPath, ['-p', 'process.cwd()'], { cwd: dir, timeoutMs: 5000 })
  equal(result.stdout.trim(), realpathSync(dir))
})

test('a missing binary rejects with ENOENT', async () => {
  await rejects(() => execProcess('pi-memsearch-no-such-binary', ['--version'], { timeoutMs: 5000 }), /ENOENT/)
})

test('a timed-out process is terminated with SIGTERM', async () => {
  const result = await execProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 200 })
  equal(result.exitCode, null)
  equal(result.signal, 'SIGTERM')
})

test('the child sees PYTHONIOENCODING=utf-8 even when the parent carries a non-UTF-8 value', async () => {
  const restore = setEnvVar('PYTHONIOENCODING', 'latin-1')
  try {
    const result = await execProcess(process.execPath, ['-p', 'process.env.PYTHONIOENCODING'], { timeoutMs: 5000 })
    equal(result.stdout.trim(), 'utf-8')
  } finally {
    restore()
  }
})

test('the inherited environment is preserved alongside the encoding override', async () => {
  const restore = setEnvVar('PI_MEMSEARCH_TEST_CANARY', 'inherited')
  try {
    const result = await execProcess(process.execPath, ['-p', 'process.env.PI_MEMSEARCH_TEST_CANARY'], {
      timeoutMs: 5000,
    })
    equal(result.stdout.trim(), 'inherited')
  } finally {
    restore()
  }
})

test('an abort signal rejects and terminates the process', async () => {
  const controller = new AbortController()
  const pending = execProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    signal: controller.signal,
    timeoutMs: 5000,
  })
  controller.abort()
  await rejects(pending, { name: 'AbortError' })
})
