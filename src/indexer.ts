import { existsSync } from 'node:fs'
import type { Backend } from './backend.ts'
import { deriveCollection, resolveProjectScope } from './scope.ts'

export const INDEX_DEBOUNCE_MS = 5_000
export const SHUTDOWN_CAP_MS = 15_000

export interface IndexTriggers {
  abortInFlight(): void
  beginShutdown(): void
  catchUp(cwd: string): void
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
  let shuttingDown = false
  let wakeShutdown: () => void = () => {}
  const shutdownStarted = new Promise<void>((resolve) => {
    wakeShutdown = resolve
  })

  function request(nextCwd: string, debounce: boolean): void {
    cwd = nextCwd
    generation++
    if (cycle) return
    cycle = runCycle(debounce).finally(() => {
      cycle = undefined
    })
  }

  async function runCycle(debounce: boolean): Promise<void> {
    let wait = debounce
    while (indexedGeneration < generation) {
      if (wait && !shuttingDown) {
        const seen = generation
        await Promise.race([deps.sleep(INDEX_DEBOUNCE_MS), shutdownStarted])
        if (generation !== seen && !shuttingDown) continue
      }
      wait = true
      const target = generation
      await runIndex()
      indexedGeneration = target
    }
  }

  async function runIndex(): Promise<void> {
    const scope = resolveProjectScope({ baseDir: cwd, env: deps.env })
    if (!existsSync(scope.memoryDir)) return
    await deps
      .backend
      .index([scope.memoryDir], deriveCollection(scope.dir), { signal: controller.signal })
      .catch(() => undefined)
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
      request(nextCwd, false)
    },
    noteWrite(nextCwd) {
      request(nextCwd, true)
    },
    async settle() {
      while (cycle) await cycle
    },
  }
}
