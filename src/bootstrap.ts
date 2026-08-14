import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Backend, BackendUnavailableError } from './backend.ts'

export const ONNX_DOWNLOAD_NOTICE = 'First memory search: downloading the embedding model (one-time, ~10 s).'

const DEFAULT_ONNX_MODEL = 'gpahal/bge-m3-onnx-int8'

export type BootstrapState =
  | { status: 'pending' }
  | { status: 'bootstrapped' }
  | { status: 'existing-config'; configPath: string }
  | { status: 'failed'; reason: string }

export interface Bootstrap {
  claimOnnxDownloadNotice(): Promise<boolean>
  ensure(projectDir: string): Promise<BootstrapState>
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
  let modelLookup: Promise<string | undefined> | undefined

  async function run(): Promise<BootstrapState> {
    try {
      await deps.backend.configSet('embedding.provider', 'onnx')
      return { status: 'bootstrapped' }
    } catch (error) {
      if (error instanceof BackendUnavailableError) return { reason: 'memory backend unavailable', status: 'failed' }
      return { reason: error instanceof Error ? error.message : String(error), status: 'failed' }
    }
  }

  function ensure(projectDir: string): Promise<BootstrapState> {
    if (state.status === 'bootstrapped') return Promise.resolve(state)
    if (inFlight) return inFlight
    const configPath = existingConfigPath(deps.env, projectDir)
    if (configPath !== undefined) {
      state = { configPath, status: 'existing-config' }
      return Promise.resolve(state)
    }
    inFlight = run()
      .then((next) => {
        state = next
        return next
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  function lookupProvider(): Promise<string | undefined> {
    if (state.status === 'bootstrapped') return Promise.resolve('onnx')
    if (state.status !== 'existing-config') return Promise.resolve(undefined)
    providerLookup ??= deps.backend.configGet('embedding.provider').catch(() => {
      providerLookup = undefined
      return undefined
    })
    return providerLookup
  }

  function lookupModel(): Promise<string | undefined> {
    if (state.status === 'bootstrapped') return Promise.resolve(DEFAULT_ONNX_MODEL)
    modelLookup ??= deps.backend.configGet('embedding.model').then(
      (value) => (value === '' ? DEFAULT_ONNX_MODEL : value),
      () => {
        modelLookup = undefined
        return undefined
      },
    )
    return modelLookup
  }

  async function claimOnnxDownloadNotice(): Promise<boolean> {
    if (claimed || onnxModelCached(deps.env, DEFAULT_ONNX_MODEL)) return false
    const provider = await lookupProvider()
    if (provider !== 'onnx') return false
    const model = await lookupModel()
    if (model === undefined || onnxModelCached(deps.env, model)) return false
    if (claimed) return false
    claimed = true
    return true
  }

  return { claimOnnxDownloadNotice, ensure }
}

function existingConfigPath(env: NodeJS.ProcessEnv, projectDir: string): string | undefined {
  const globalPath = join(homeDir(env), '.memsearch', 'config.toml')
  if (existsSync(globalPath)) return globalPath
  const projectPath = join(projectDir, '.memsearch.toml')
  if (existsSync(projectPath)) return projectPath
  return undefined
}

function onnxModelCached(env: NodeJS.ProcessEnv, model: string): boolean {
  return existsSync(join(hubCacheDir(env), `models--${model.replaceAll('/', '--')}`))
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
