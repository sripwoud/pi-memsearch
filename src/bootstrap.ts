import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Backend, BackendUnavailableError, type CommandOptions } from './backend.ts'

export type BootstrapState =
  | { status: 'pending' }
  | { status: 'bootstrapped' }
  | { status: 'existing-config'; configPath: string }
  | { status: 'failed'; reason: string }

export interface Bootstrap {
  ensure(projectDir: string, options?: CommandOptions): Promise<BootstrapState>
}

export interface BootstrapDeps {
  backend: Pick<Backend, 'configSet'>
  env: NodeJS.ProcessEnv
}

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  let state: BootstrapState = { status: 'pending' }
  let inFlight: Promise<BootstrapState> | undefined

  async function run(projectDir: string, options: CommandOptions): Promise<BootstrapState> {
    const globalPath = join(homeDir(deps.env), '.memsearch', 'config.toml')
    if (existsSync(globalPath)) return { configPath: globalPath, status: 'existing-config' }
    const projectPath = join(projectDir, '.memsearch.toml')
    if (existsSync(projectPath)) return { configPath: projectPath, status: 'existing-config' }
    try {
      await deps.backend.configSet('embedding.provider', 'onnx', options)
      return { status: 'bootstrapped' }
    } catch (error) {
      if (isAbort(error)) throw error
      if (error instanceof BackendUnavailableError) return { reason: 'memory backend unavailable', status: 'failed' }
      return { reason: error instanceof Error ? error.message : String(error), status: 'failed' }
    }
  }

  function ensure(projectDir: string, options: CommandOptions = {}): Promise<BootstrapState> {
    if (state.status === 'bootstrapped' || state.status === 'existing-config') return Promise.resolve(state)
    if (inFlight) return inFlight
    inFlight = run(projectDir, options)
      .then((next) => {
        state = next
        return next
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  return { ensure }
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env['HOME'] ?? homedir()
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
