# pi-memsearch

## Tooling

`mise run setup` once, then `mise run check` (biome + dprint + tsc), `mise run fix`, `mise run test` (`node --test`).

No build step: pi loads `extensions/*.ts` through jiti, so ship TypeScript source and use relative imports with explicit `.ts` extensions.

## Agent skills

### Issue tracker

GitHub Issues on `sripwoud/pi-memsearch`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical strings, unmodified. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
