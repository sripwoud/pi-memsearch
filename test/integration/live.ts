import type { ExtensionContext, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Complete } from '../../src/capture.ts'
import { type ExecFn, execProcess } from '../../src/exec.ts'
import { createMemsearchExtension } from '../../src/extension.ts'
import { SHUTDOWN_CAP_MS } from '../../src/indexer.ts'
import { deriveCollection } from '../../src/scope.ts'
import { createFakeContext, createFakePi, createProjectRoot, fakeModel, TEST_SESSION } from '../harness.ts'

export const SKIP_UNLESS_GATED: string | false = process.env['PI_MEMSEARCH_IT'] === '1'
  ? false
  : 'set PI_MEMSEARCH_IT=1 to run against real memsearch (needs uv)'

const REAL_HOME = homedir()

const DATA_DIR_LOCKED = 'DataDirLockedError'

export interface LiveHarness {
  branch: SessionEntry[]
  collection: string
  dataDirLockPath: string
  fire(event: string, payload?: object): Promise<unknown[]>
  home: string
  lockedOutAttempts(): number
  memoryDir: string
  restartSession(): Promise<void>
  root: string
  settle(): Promise<void>
  toolText(name: string, params: object): Promise<string>
}

export function setupLive(options: { complete?: Complete } = {}): LiveHarness {
  const root = createProjectRoot('pi-memsearch-it-')
  const home = join(root, 'home')
  mkdirSync(home)

  // The memsearch child inherits this process's environment: point HOME at the throwaway home
  // so its config and Milvus Lite database are isolated, while keeping the HuggingFace cache on
  // the real home so the onnx model is downloaded once per machine rather than once per run.
  process.env['HF_HOME'] ??= join(REAL_HOME, '.cache', 'huggingface')
  process.env['HOME'] = home

  const lockedOut: string[] = []
  const exec: ExecFn = async (command, args, execOptions) => {
    const result = await execProcess(command, args, execOptions)
    if (result.exitCode !== 0 && result.stderr.includes(DATA_DIR_LOCKED)) lockedOut.push(args.join(' '))
    return result
  }

  const pending: Promise<void>[] = []
  const { fire, pi, tools } = createFakePi()
  createMemsearchExtension({
    env: process.env,
    exec,
    now: () => new Date(),
    schedule: (task) => {
      pending.push(task())
    },
    // Real timers for the debounce and the retry backoff: they must keep the event loop alive or the
    // suite exits mid-retry. Never for the shutdown cap, so the suite waits for the real index
    // instead of racing it against a wall clock.
    sleep: (ms) => (ms >= SHUTDOWN_CAP_MS ? NEVER : wait(ms)),
    ...(options.complete ? { complete: options.complete } : {}),
  })(pi)

  // Distillation resolves a model from the registry even when the LLM seam is canned.
  const model = fakeModel({ id: 'integration-distiller' })
  const branch: SessionEntry[] = []
  const ctx = createFakeContext({ branch, cwd: root, model, models: [model], session: TEST_SESSION })

  return {
    branch,
    collection: deriveCollection(root),
    dataDirLockPath: join(home, '.memsearch', 'milvus.db', 'LOCK'),
    fire: (event, payload = {}) => fire(event, payload, ctx),
    home,
    lockedOutAttempts: () => lockedOut.length,
    memoryDir: join(root, '.memsearch', 'memory'),
    root,
    // session_shutdown aborts the tool signal; a new session re-arms it, as in production.
    // session_start also kicks off an immediate catch-up index, so a status call queues
    // behind it as a barrier: no index child is still in flight when this returns.
    async restartSession() {
      await fire('session_start', {}, ctx)
      await runTool(tools, 'memory_status', {}, ctx)
    },
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0))
    },
    toolText: (name, params) => runTool(tools, name, params, ctx),
  }
}

const NEVER = new Promise<void>(() => {})

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function runTool(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: object,
  ctx: ExtensionContext,
): Promise<string> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  const result = await tool.execute(`integration-${name}`, params, undefined, undefined, ctx)
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error(`tool ${name} returned no text content`)
  return first.text
}

const HOLD_LOCK_SOURCE = [
  'import fcntl, sys',
  'handle = open(sys.argv[1], "a")',
  'fcntl.flock(handle, fcntl.LOCK_EX)',
  'print("locked", flush=True)',
  'sys.stdin.read()',
]
  .join('\n')

export interface DataDirLock {
  release(): Promise<void>
}

/**
 * Take the Milvus Lite data-directory lock from another process, the way a second agent in the
 * mesh would. Resolves once the lock is held; `release()` returns after the holder has exited.
 */
export function holdDataDirLock(lockPath: string): Promise<DataDirLock> {
  const child = spawn('uv', ['run', '--no-project', 'python', '-c', HOLD_LOCK_SOURCE, lockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let locked = false
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (locked || !chunk.includes('locked')) return
      locked = true
      resolve({
        release: () =>
          new Promise<void>((released) => {
            child.once('close', () => released())
            child.stdin.end()
          }),
      })
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (!locked) reject(new Error(`lock holder exited (${code}) without taking the lock: ${stderr}`))
    })
  })
}

export async function waitForLockedOutAttempt(live: LiveHarness, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (live.lockedOutAttempts() === 0) {
    if (Date.now() > deadline) throw new Error('no memsearch invocation was locked out within the timeout')
    await wait(100)
  }
}
