import { equal, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { execProcess } from '../src/exec.ts'

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

test('a missing binary rejects with ENOENT', async () => {
  await rejects(() => execProcess('pi-memsearch-no-such-binary', ['--version'], { timeoutMs: 5000 }), /ENOENT/)
})

test('a timed-out process is terminated with SIGTERM', async () => {
  const result = await execProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 200 })
  equal(result.exitCode, null)
  equal(result.signal, 'SIGTERM')
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
