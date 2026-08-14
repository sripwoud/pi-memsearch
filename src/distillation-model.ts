import type { Api, Model } from '@earendil-works/pi-ai'

export interface ModelCatalog {
  find(provider: string, modelId: string): Model<Api> | undefined
  getAvailable(): Model<Api>[]
}

export interface DistillationModelOptions {
  catalog: ModelCatalog
  env: NodeJS.ProcessEnv
  sessionModel: Model<Api> | undefined
}

export function resolveDistillationModel({ catalog, env, sessionModel }: DistillationModelOptions): Model<Api> {
  const override = env['PI_MEMSEARCH_CAPTURE_MODEL']
  if (override) return resolveOverride(catalog, override)

  const cheapest = catalog
    .getAvailable()
    .filter((model) => model.provider === sessionModel?.provider)
    .sort(byCostThenId)[0]
  if (cheapest) return cheapest
  if (sessionModel) return sessionModel
  throw new Error('no model available for distillation: no session model and no PI_MEMSEARCH_CAPTURE_MODEL set')
}

function resolveOverride(catalog: ModelCatalog, override: string): Model<Api> {
  const slash = override.indexOf('/')
  const model = slash === -1
    ? catalog.getAvailable().find((candidate) => candidate.id === override)
    : catalog.find(override.slice(0, slash), override.slice(slash + 1))
  if (!model) throw new Error(`capture model '${override}' not found in the model registry`)
  return model
}

function byCostThenId(a: Model<Api>, b: Model<Api>): number {
  return a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id)
}
