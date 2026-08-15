import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { type Backend, DEFAULT_TOP_K, MissingCollectionError } from './backend.ts'
import type { SearchHit } from './contract.ts'
import { deriveCollection } from './scope.ts'

export const SCAN_ROOTS_ENV = 'PI_MEMSEARCH_SCAN_ROOTS'

export function resolveScanRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env[SCAN_ROOTS_ENV] ?? ''
  const roots = raw
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root !== '')
    .map((root) => resolve(root))
  if (roots.length === 0) {
    throw new Error(
      `Cross-repo search requires ${SCAN_ROOTS_ENV}: a "${delimiter}"-separated list of directories whose immediate children are scanned for .memsearch/memory stores.`,
    )
  }
  return roots
}

export function discoverProjects(roots: string[]): string[] {
  const projects = new Set<string>()
  for (const root of roots) {
    let children: string[]
    try {
      children = readdirSync(root)
    } catch (error) {
      throw new Error(
        `Cross-repo search cannot scan ${root} (configured in ${SCAN_ROOTS_ENV}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    for (const child of children) {
      const dir = join(root, child)
      if (existsSync(join(dir, '.memsearch', 'memory'))) projects.add(dir)
    }
  }
  return [...projects].sort()
}

export interface CrossRepoHit extends SearchHit {
  project: string
}

export interface CrossRepoResult {
  hits: CrossRepoHit[]
  searched: string[]
  skipped: string[]
}

export interface CrossRepoSearch {
  backend: Backend
  currentProject: string
  onProgress?: (done: number, total: number) => void
  onQueued?: (holder: string) => void
  projects: string[]
  query: string
  signal?: AbortSignal
  topK?: number
}

export async function searchAcrossProjects(params: CrossRepoSearch): Promise<CrossRepoResult> {
  const targets = dedupeByCollection([params.currentProject, ...params.projects])
  const hits: CrossRepoHit[] = []
  const searched: string[] = []
  const skipped: string[] = []
  const options = {
    ...(params.onQueued === undefined ? {} : { onQueued: params.onQueued }),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.topK === undefined ? {} : { topK: params.topK }),
  }
  for (const target of targets) {
    params.signal?.throwIfAborted()
    try {
      const found = await params.backend.search(params.query, target.collection, options)
      for (const hit of found) hits.push({ ...hit, project: target.dir })
      searched.push(target.dir)
    } catch (error) {
      if (!(error instanceof MissingCollectionError)) throw error
      skipped.push(target.dir)
    }
    params.onProgress?.(searched.length + skipped.length, targets.length)
  }
  hits.sort((first, second) => second.score - first.score)
  return { hits: hits.slice(0, params.topK ?? DEFAULT_TOP_K), searched, skipped }
}

function dedupeByCollection(dirs: string[]): { collection: string; dir: string }[] {
  const seen = new Set<string>()
  const targets: { collection: string; dir: string }[] = []
  for (const dir of dirs) {
    const collection = deriveCollection(dir)
    if (seen.has(collection)) continue
    seen.add(collection)
    targets.push({ collection, dir })
  }
  return targets
}
