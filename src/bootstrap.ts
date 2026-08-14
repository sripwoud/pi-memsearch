import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Backend, BackendUnavailableError, type CommandOptions } from './backend.ts'

export const ONNX_DOWNLOAD_NOTICE = 'First memory search: downloading the embedding model (one-time, ~10 s).'

const DEFAULT_ONNX_MODEL = 'gpahal/bge-m3-onnx-int8'

export type BootstrapState =
  | { status: 'pending' }
  | { status: 'bootstrapped' }
  | { status: 'existing-config'; configPath: string }
  | { status: 'failed'; reason: string }

export interface Bootstrap {
  claimOnnxDownloadNotice(options?: CommandOptions): Promise<boolean>
  ensure(projectDir: string, options?: CommandOptions): Promise<BootstrapState>
}

export interface BootstrapDeps {
  backend: Pick<Backend, 'configGet' | 'configSet'>
  env: NodeJS.ProcessEnv
}

export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  let state: BootstrapState = { status: 'pending' }
  let inFlight: Promise<BootstrapState> | undefined
  let claimed = false
  let providerLookup: Promise<string | undefined> | undefined

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

  function lookupProvider(options: CommandOptions): Promise<string | undefined> {
    if (state.status === 'bootstrapped') return Promise.resolve('onnx')
    if (state.status !== 'existing-config') return Promise.resolve(undefined)
    providerLookup ??= deps.backend.configGet('embedding.provider', options).catch((error: unknown) => {
      providerLookup = undefined
      if (isAbort(error)) throw error
      return undefined
    })
    return providerLookup
  }

  async function claimOnnxDownloadNotice(options: CommandOptions = {}): Promise<boolean> {
    if (claimed || onnxModelCached(deps.env)) return false
    const provider = await lookupProvider(options)
    if (provider !== 'onnx' || claimed) return false
    claimed = true
    return true
  }

  return { claimOnnxDownloadNotice, ensure }
}

function onnxModelCached(env: NodeJS.ProcessEnv): boolean {
  return existsSync(join(hubCacheDir(env), `models--${DEFAULT_ONNX_MODEL.replaceAll('/', '--')}`))
}

function hubCacheDir(env: NodeJS.ProcessEnv): string {
  const hubCache = env['HF_HUB_CACHE']
  if (hubCache) return hubCache
  const hfHome = env['HF_HOME'] ?? join(env['XDG_CACHE_HOME'] ?? join(homeDir(env), '.cache'), 'huggingface')
  return join(hfHome, 'hub')
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env['HOME'] ?? homedir()
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
