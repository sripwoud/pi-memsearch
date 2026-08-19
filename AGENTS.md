# pi-memsearch

## Tooling

`mise run setup` once, then `mise run check` (biome + dprint + tsc), `mise run fix`, `mise run test` (`node --test`).

No build step: pi loads `extensions/*.ts` through jiti, so ship TypeScript source and use relative imports with explicit `.ts` extensions.

Integration suite, test layout and the release process: `CONTRIBUTING.md`.

## Agent skills

### Issue tracker

GitHub Issues on `sripwoud/pi-memsearch`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical strings, unmodified. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Runtime docs

`docs/runtime.md` is the event-by-event contract: hook-to-action ordering, every tunable constant, every degradation path. Read it before changing `src/`.

Changing runtime behavior means updating it in the same commit — a stale mechanism doc is worse than none, because agents read it as authoritative. `CONTRIBUTING.md` carries the change-to-doc mapping.
