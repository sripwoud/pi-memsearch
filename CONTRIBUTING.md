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

Merging that PR cuts the GitHub release **as a draft** and tags the commit. `npm publish` runs next, and only on success does the workflow flip the draft to published. A failed publish therefore leaves no release announcing a version npm does not have.

A release left as a draft means `npm publish` failed. Fix the cause, then re-run the failed jobs of that run (`gh run rerun <id> --failed`) — a fresh run will not re-cut a release whose draft already exists. If npm already has the version, flip the draft by hand: `gh release edit vX.Y.Z --draft=false --latest`.

Before cutting one:

1. `mise run check`
2. `mise run test`
3. `mise run test:integration`
4. `pi install` the package, then confirm a live session captures and recalls

### Commit types decide whether a release cuts

Only `feat:` (minor), `fix:` (patch) and `!` / breaking (major) bump the version. `docs:`, `refactor:`, `chore:`, `test:` and `build:` open no release PR, however large the diff.

A PR's **squash title is the only commit that reaches `master`** — types on the commits inside it are discarded. Type the PR title for the release you want.

What ships in the tarball, and therefore needs a releasable type when it changes:

| Path                                                           | Ships | Why                       |
| -------------------------------------------------------------- | ----- | ------------------------- |
| `extensions/`, `prompts/`, `skills/`, `src/`                   | yes   | `package.json` `files`    |
| `README.md`, `LICENSE`, `package.json`                         | yes   | npm always includes these |
| `docs/`, `CONTRIBUTING.md`, `AGENTS.md`, `CONTEXT.md`, `test/` | no    | GitHub only               |

A README-only change is consumer-facing — the README is the npm and `pi.dev/packages` landing page — so type it `fix:`. If it already merged as `docs:`, force the release instead:

```sh
git commit --allow-empty -m "chore: release 1.2.3

Release-As: 1.2.3"
```

Use the version you actually want; `Release-As:` is honored whatever the commit type.

> **Note** — `README.md` carries `<!-- x-release-please-version -->` on its "Current release" line, wired through `extra-files` in `release-please-config.json`. Rewriting the README without that marker silently stops the version line from updating.

Raising the memsearch version ceiling in `src/contract.ts`, or the pi peer range in `package.json`, is a deliberate act: bump it, then re-run the integration suite on that line. Type those commits `feat:` (widened support) or `fix:` / `feat!:`. **Never `build:`** — it cuts no release, so the widened support would never reach a consumer. `build:` is for the lockfile and devDependencies, which never ship.

Commit subjects are lowercase, imperative, no trailing period. Do not add co-authors or AI attribution trailers; the hooks reject them.

### Republish to refresh the pi.dev listing

npm's search index snapshots download counts at publish time. A package published before npm's stats pipeline has data for it freezes at zero, which sinks it below the depth pi.dev's catalog crawls — so it never appears in the `/packages` gallery even though its detail page renders. Publishing any new version re-snapshots the count.
