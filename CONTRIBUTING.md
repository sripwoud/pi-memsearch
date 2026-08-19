# Contributing

## Setup

`mise run setup` — installs node deps and the `hk` git hooks. Never bypass the hooks; fix what they report.

| Task                        | Alias | What                                                                                  |
| --------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `mise run check`            | `c`   | biome, dprint, tsc across the repo                                                    |
| `mise run fix`              | `f`   | Apply lint and format fixes                                                           |
| `mise run test`             | `t`   | Unit suite: deterministic, no backend, no network, no LLM                             |
| `mise run test:integration` | `ti`  | Real `uvx` + onnx round trip; needs `uv`, gated on `PI_MEMSEARCH_IT=1`, 5 min timeout |
| `mise run dev`              | `d`   | pi with the local extension loaded                                                    |

No build step: pi loads `extensions/*.ts` through jiti, so the package ships TypeScript source and uses relative imports with explicit `.ts` extensions.

## Tests

Unit tests sit next to what they cover in `test/`, and never touch the network, the backend or an LLM — `mise run test` must stay deterministic and fast.

The integration suite in `test/integration/` runs against real memsearch and is skipped by `mise run test`:

- `round-trip.test.ts` — capture → index → search → expand
- `lock-contention.test.ts` — the Milvus Lite backoff ladder under a held lock
- `auto-context.test.ts` — the sidecar within its latency budget

## Documentation

`docs/runtime.md` is the event-by-event contract that dev agents read before touching `src/`. **A PR that changes runtime behavior updates it in the same commit.** A stale mechanism doc is worse than none, because agents read it as authoritative.

| Change                                                    | Also update                                  |
| --------------------------------------------------------- | -------------------------------------------- |
| A hook registration, or the order within one              | `docs/runtime.md` → Hook to action           |
| A tunable constant                                        | `docs/runtime.md` → the section that owns it |
| A new failure or degradation path                         | `docs/runtime.md` → Degradation              |
| A new domain term, or a term you had to think twice about | `CONTEXT.md`                                 |
| A decision with a rejected alternative worth recording    | a new `docs/adr/` entry                      |

## Release

Releases go through release-please: a conventional-commit type on `master` opens the release PR.

Before cutting one:

1. `mise run check`
2. `mise run test`
3. `mise run test:integration`
4. `pi install` the package, then confirm a live session captures and recalls

### Commit types decide whether a release cuts

Raising the memsearch version ceiling in `src/contract.ts`, or the pi peer range in `package.json`, is a deliberate act: bump it, then re-run the integration suite on that line.

Both files ship in the published tarball, so type those commits `feat:` (widened support) or `fix:` / `feat!:`. **Never `build:`** — it cuts no release, so the widened support would never reach a consumer. `build:` is for the lockfile and devDependencies, which never ship.

Commit subjects are lowercase, imperative, no trailing period. Do not add co-authors or AI attribution trailers; the hooks reject them.

### Republish to refresh the pi.dev listing

npm's search index snapshots download counts at publish time. A package published before npm's stats pipeline has data for it freezes at zero, which sinks it below the depth pi.dev's catalog crawls — so it never appears in the `/packages` gallery even though its detail page renders. Publishing any new version re-snapshots the count.
