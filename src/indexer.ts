import { existsSync } from 'node:fs'
import type { Backend } from './backend.ts'
import { deriveCollection, resolveProjectScope } from './scope.ts'

export const INDEX_DEBOUNCE_MS = 5_000
export const SHUTDOWN_CAP_MS = 15_000

export interface IndexTriggers {
  abortInFlight(): void
  beginShutdown(): void
  catchUp(cwd: string): void
  lastFailure(): string | undefined
  noteWrite(cwd: string): void
  settle(): Promise<void>
}

export interface IndexTriggersDeps {
  backend: Pick<Backend, 'index'>
  env: NodeJS.ProcessEnv
  sleep(ms: number): Promise<void>
}

export function createIndexTriggers(deps: IndexTriggersDeps): IndexTriggers {
  let generation = 0
  let indexedGeneration = 0
  let cwd = ''
  let cycle: Promise<void> | undefined
  let controller = new AbortController()
  let lastError: string | undefined
  let shuttingDown = false
  let wakeShutdown: () => void = () => {}
  let shutdownStarted = new Promise<void>((resolve) => {
    wakeShutdown = resolve
  })

  function arm(): void {
    if (!shuttingDown) return
    shuttingDown = false
    shutdownStarted = new Promise<void>((resolve) => {
      wakeShutdown = resolve
    })
  }

  let immediate = false
  let wakeWait: () => void = () => {}

  function request(nextCwd: string, debounce: boolean): void {
    cwd = nextCwd
    generation++
    if (!debounce) {
      immediate = true
      wakeWait()
    }
    if (cycle) return
    cycle = runCycle().finally(() => {
      cycle = undefined
    })
  }

  async function runCycle(): Promise<void> {
    while (indexedGeneration < generation) {
      if (!immediate && !shuttingDown) {
        const seen = generation
        const woken = new Promise<void>((resolve) => {
          wakeWait = resolve
        })
        await Promise.race([deps.sleep(INDEX_DEBOUNCE_MS), shutdownStarted, woken])
        if (generation !== seen && !shuttingDown && !immediate) continue
      }
      immediate = false
      const target = generation
      await runIndex()
      indexedGeneration = target
    }
  }

  async function runIndex(): Promise<void> {
    const scope = resolveProjectScope({ baseDir: cwd, env: deps.env })
    if (!existsSync(scope.memoryDir)) return
    try {
      await deps.backend.index(scope.memoryDir, deriveCollection(scope.dir), { signal: controller.signal })
      lastError = undefined
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    abortInFlight() {
      controller.abort()
      controller = new AbortController()
    },
    beginShutdown() {
      shuttingDown = true
      wakeShutdown()
    },
    catchUp(nextCwd) {
      arm()
      request(nextCwd, false)
    },
    lastFailure() {
      return lastError
    },
    noteWrite(nextCwd) {
      request(nextCwd, true)
    },
    async settle() {
      while (cycle) await cycle
    },
  }
}
