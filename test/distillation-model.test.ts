import type { Api, Model } from '@earendil-works/pi-ai'
import { equal, throws } from 'node:assert/strict'
import { test } from 'node:test'
import { type ModelCatalog, resolveDistillationModel } from '../src/distillation-model.ts'
import { fakeModel } from './harness.ts'

function catalog(models: Model<Api>[]): ModelCatalog {
  return {
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    getAvailable: () => models,
  }
}

test('override with provider/model resolves through the registry, slashes in the id preserved', () => {
  const target = fakeModel({ id: 'anthropic/claude-haiku', provider: 'openrouter' })
  const model = resolveDistillationModel({
    catalog: catalog([fakeModel({ id: 'other' }), target]),
    env: { PI_MEMSEARCH_CAPTURE_MODEL: 'openrouter/anthropic/claude-haiku' },
    sessionModel: undefined,
  })
  equal(model, target)
})

test('override without a slash matches an available model by id', () => {
  const target = fakeModel({ id: 'gpt-mini', provider: 'openai' })
  const model = resolveDistillationModel({
    catalog: catalog([fakeModel({ id: 'other' }), target]),
    env: { PI_MEMSEARCH_CAPTURE_MODEL: 'gpt-mini' },
    sessionModel: fakeModel({ id: 'other' }),
  })
  equal(model, target)
})

test('unresolvable override throws instead of silently falling back', () => {
  throws(
    () =>
      resolveDistillationModel({
        catalog: catalog([fakeModel({ id: 'real' })]),
        env: { PI_MEMSEARCH_CAPTURE_MODEL: 'ghost' },
        sessionModel: fakeModel({ id: 'real' }),
      }),
    /'ghost' not found/,
  )
})

test('default picks the cheapest available model from the session provider', () => {
  const expensive = fakeModel({ id: 'big', input: 15, output: 75 })
  const cheap = fakeModel({ id: 'small', input: 1, output: 5 })
  const cheaperElsewhere = fakeModel({ id: 'tiny', input: 0.1, output: 0.4, provider: 'openai' })
  const model = resolveDistillationModel({
    catalog: catalog([expensive, cheaperElsewhere, cheap]),
    env: {},
    sessionModel: expensive,
  })
  equal(model, cheap)
})

test('equal-cost candidates resolve deterministically by id', () => {
  const b = fakeModel({ id: 'b' })
  const a = fakeModel({ id: 'a' })
  const model = resolveDistillationModel({ catalog: catalog([b, a]), env: {}, sessionModel: b })
  equal(model, a)
})

test('no same-provider candidate falls back to the session model', () => {
  const session = fakeModel({ id: 'local', provider: 'ollama' })
  const model = resolveDistillationModel({
    catalog: catalog([fakeModel({ id: 'remote', provider: 'openai' })]),
    env: {},
    sessionModel: session,
  })
  equal(model, session)
})

test('no session model and no override throws', () => {
  throws(
    () => resolveDistillationModel({ catalog: catalog([fakeModel({ id: 'x' })]), env: {}, sessionModel: undefined }),
    /no model available/,
  )
})
