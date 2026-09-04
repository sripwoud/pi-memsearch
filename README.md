<div align="center">

# pi-memsearch

[![npm](https://img.shields.io/npm/v/pi-memsearch?logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/pi-memsearch)
[![ci](https://img.shields.io/github/actions/workflow/status/sripwoud/pi-memsearch/master.yml?branch=master&logo=githubactions&logoColor=white&label=ci)](https://github.com/sripwoud/pi-memsearch/actions/workflows/master.yml?query=branch%3Amaster)

</div>

pi ships no memory by design — "primitives, not features". This package gives it long-term memory through [memsearch](https://zilliztech.github.io/memsearch/), the same per-project memory store Claude Code, Codex, OpenClaw and OpenCode already write to.

- **Recall in the phrasing you use weeks later**: **32/35** strong hits vs **26/35** for `pi-memory`'s qmd backend, over 35 queries against an identical 223-file corpus ([benchmark](docs/research/memsearch-vs-pi-memory-benchmark.md)).
- **Cross-agent**: pi recalls what Claude Code learned yesterday in the same repo, and vice versa.
- **Plain markdown** under `.memsearch/`, yours to commit or gitignore.

Needs [uv](https://docs.astral.sh/uv/), the only external dependency. Then `pi install npm:pi-memsearch`.

The memory writes itself, then answers weeks later:

```text
# .memsearch/memory/2026-08-13.md  ← written by the session, unprompted
### 22:41
- the user and the agent moved the hot cache to Redis with 5 minute TTLs

# a new session, three weeks on
you ▸ /recall how did we fix the flaky redis test?
pi  ▸ memory_search → 5 chunks; top: 2026-08-13 "moved the hot cache to Redis with 5 minute TTLs" (0.81)
      memory_expand → the full "### 22:41" section, with its session anchor
      → answered at layer 2; the origin transcript was never opened
```

## Why memsearch, not `pi-memory`

`pi-memory`, the existing community option, delegates search to [qmd](https://github.com/tobilu/qmd) and keeps its store user-global (`~/.pi/agent/memory`).

|                                     | pi-memsearch | `pi-memory` |
| ----------------------------------- | ------------ | ----------- |
| Search backend                      | memsearch    | qmd         |
| Strong hits, 35 queries / 223 files | **32/35**    | 26/35       |
| Store scope                         | per git root | user-global |

They tie on short keyword queries; memsearch wins on paraphrased and natural-question recall — the phrasing you use when asking "how did we fix X?" weeks later. Method and per-query results: [`docs/research/memsearch-vs-pi-memory-benchmark.md`](docs/research/memsearch-vs-pi-memory-benchmark.md).

memsearch already integrates Claude Code, OpenClaw, OpenCode and Codex CLI, all sharing one markdown format and one collection-name derivation. This package joins pi to that mesh.

## Install

Current release: [1.2.1](CHANGELOG.md). <!-- x-release-please-version -->

Prerequisites: [uv](https://docs.astral.sh/uv/) (the only external dependency — memsearch runs through `uvx`, so there is no Python packaging to manage), pi >= 0.84.1 (0.84.x is the tested line), Node >= 22.19.

```sh
pi install npm:pi-memsearch                                        # all projects (~/.pi/settings.json)
pi install npm:pi-memsearch -l                                     # this project (.pi/settings.json)
pi install npm:pi-memsearch@1.0.0                                  # pinned; `pi update` never advances it
pi install https://github.com/sripwoud/pi-memsearch                # unreleased master
```

First run, once per machine: `uvx` resolves `memsearch[onnx]>=0.4.17,<0.5`, and the first embedding downloads the onnx model once (~560 MB — a ~10 s pause on a fast connection, announced as a notice so it is not mistaken for a hang). No API key is involved: when no embedding provider is configured anywhere, the package sets `embedding.provider = onnx` in memsearch's global config once. An existing config is never touched.

Uninstall with `pi remove npm:pi-memsearch`. The memory markdown under `.memsearch/` survives — it is yours, not the package's.

## What it does

| Surface          | pi mechanism                             | Behavior                                                                                                                               |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Capture          | `agent_settled` hook                     | Distills every content-bearing exchange into the daily memory file, in the background, with the session provider's cheapest model      |
| Deliberate write | `memory_write` tool                      | Persists a memory immediately, on request                                                                                              |
| Indexing         | `session_start` / write / shutdown       | Catch-up index, debounced index 5 s after a write, final index at shutdown                                                             |
| Recall           | `/recall`, recall skill, three tools     | `memory_search` (chunks) → `memory_expand` (section) → `memory_transcript` (origin transcript); `/recall --all` widens across projects |
| Skill drafting   | `skill-drafting` skill                   | Turns remembered work into skill candidates in memsearch's git-tracked store; installs only on request                                 |
| Redaction        | `memory_forget` tool                     | Removes one entry from the daily memory file and, via reindex, the collection; no recovery record, no audit log                        |
| Maintenance      | `memory_compact` tool                    | Memory compaction on request: an LLM condenses the store into today's daily memory file                                                |
| Stable snapshot  | `before_agent_start` hook                | Recent memory appended to the system prompt, byte-identical between checkpoints                                                        |
| Auto-context     | `before_agent_start` hook + warm sidecar | Opt-in: top memory chunks injected per prompt within a 300 ms budget                                                                   |

## Memory store

Markdown is the source of truth; the collection is derived and rebuildable at any time.

- **Location**: `<project>/.memsearch/memory/YYYY-MM-DD.md` — one daily memory file per calendar day, appended to by every agent in the mesh.
- **Git**: commit `.memsearch/` to share memory with collaborators, or gitignore it to keep it personal — the collection lives in `~/.memsearch/milvus.db` either way, so the choice costs nothing.
- **Scope**: `$MEMSEARCH_DIR`, else the git root, else the working directory — memsearch's own resolution order. To put the store somewhere else entirely, `$PI_MEMSEARCH_STORE_CMD` hands both the store path and the collection name to a command of your own ([ADR 0007](docs/adr/0007-delegated-store-resolution.md)).

Collection naming, the entry shape, and the session anchor that lets any memory entry trace back to the conversation that produced it: [`docs/runtime.md`](docs/runtime.md).

## Tools

| Tool                | Layer | Purpose                                                                                                                 |
| ------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `memory_write`      | —     | Persist a memory now: timestamped, anchored, appended to today's daily memory file                                      |
| `memory_search`     | L1    | Top-k scored chunks for a query; `scope: "all"` widens to cross-repo recall                                             |
| `memory_expand`     | L2    | Full section for a chunk hash, with its session anchor; `project` routes to a cross-repo hit's origin                   |
| `memory_transcript` | L3    | Turns around an anchored entry in the origin transcript, on the branch the memory anchors to; pure file read            |
| `memory_forget`     | —     | Redact one entry or compact block from store and collection; the tool result is the only record                         |
| `memory_compact`    | —     | Memory compaction on explicit request; returns memsearch's markdown summary                                             |
| `memory_status`     | —     | Doctor: uv/memsearch presence and version, scope, collection, index state, chunk count, auto-context state and counters |

## Configuration

Everything shared with the mesh — provider, model, chunking — lives in memsearch's own config (`~/.memsearch/config.toml`). Only pi-local behavior is configured here:

| Variable                          | Default                                | Effect                                                                                                                                           |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PI_MEMSEARCH_CAPTURE`            | on                                     | `off` disables automatic capture; `memory_write` keeps working                                                                                   |
| `PI_MEMSEARCH_CAPTURE_MODEL`      | cheapest model of the session provider | Distillation model, as `<id>` or `<provider>/<id>`                                                                                               |
| `PI_MEMSEARCH_SNAPSHOT`           | on                                     | `off` disables snapshot injection                                                                                                                |
| `PI_MEMSEARCH_AUTO_CONTEXT`       | off                                    | `on` enables per-prompt injection via a warm sidecar (~1 GB resident)                                                                            |
| `PI_MEMSEARCH_SEARCH_TIMEOUT_MS`  | `30000`                                | Per-attempt timeout for `memory_search` (each cross-repo invocation too)                                                                         |
| `PI_MEMSEARCH_COMPACT_TIMEOUT_MS` | `300000`                               | Per-attempt timeout for `memory_compact` (LLM pass plus reindex)                                                                                 |
| `PI_MEMSEARCH_SCAN_ROOTS`         | unset                                  | `:`-separated directory roots scanned for other projects' memory stores; required by cross-repo recall                                           |
| `PI_MEMSEARCH_STORE_CMD`          | unset                                  | Command printing the store path (`memory-dir`) and collection name (`collection`), run in the directory being resolved; outranks `MEMSEARCH_DIR` |
| `MEMSEARCH_DIR`                   | unset                                  | memsearch's own scope override; the memory store and collection follow it                                                                        |

Auto-context races a 300 ms hard cap and costs ~0.7–1.0 GB resident memory while on. A deadline miss, an empty result or a locked store all degrade to no injection, so a prompt never waits on memory; remote embedding providers will often miss the cap. Every tunable, and how the sidecar borrows the Milvus lock per prompt: [`docs/runtime.md`](docs/runtime.md#auto-context).

## Troubleshooting

A missing `uv` or memsearch degrades rather than breaks:

| Surface                                            | Without the backend                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Capture, `memory_write`                            | Still append to the daily memory file; the stable snapshot still reads it |
| `memory_search`, `memory_expand`, `memory_compact` | Return install instructions, not an error                                 |
| `memory_transcript`                                | Unaffected — L3 recall is a pure file read that never touches the backend |

Availability is re-probed with a short negative cache, so installing `uv` mid-session is picked up without a restart. Once the backend is back, the next index makes everything written in the meantime searchable.

`memory_status` is the one-step answer to "why doesn't search work": it reports what is missing, the active config, the index state (including memsearch's own `degraded` status and per-file failures), and the last index failure.

| Symptom                                   | Likely cause                                                                               | Fix                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Search returns install instructions       | `uv` or memsearch missing                                                                  | Install [uv](https://docs.astral.sh/uv/); availability is re-probed mid-session |
| First search pauses ~10 s                 | One-time onnx model download                                                               | Wait — the notice announces it                                                  |
| A just-written memory is not found        | The debounced index (5 s after a write) has not run yet                                    | Retry in a moment; shutdown and session start also index                        |
| Search finds nothing after the repo moved | The collection name hashes the absolute path                                               | The next session start catch-up indexes into the new collection                 |
| Nothing is captured                       | `PI_MEMSEARCH_CAPTURE=off`, or the exchange failed a gate (no assistant text, aborted run) | `memory_status` shows the active config                                         |
| Auto-context injects nothing              | Budget misses (slow machine, remote provider), an empty collection, or the sidecar gave up | `memory_status` shows sidecar state and per-prompt skip counters                |

## Unsupported

- **Running alongside `pi-memory`** — both capture every exchange and both inject context. Pick one.
- **Milvus Server / Zilliz Cloud** — Milvus Lite only.
- **Windows** — milvus-lite ships no Windows wheels; use WSL2.
- **A forked or patched memsearch** — the package orchestrates the released CLI, and invents no memory format of its own.

## How it works

- Hook-by-hook behavior, every tunable, every degradation path: [`docs/runtime.md`](docs/runtime.md)
- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Decisions and rejected alternatives: [`docs/adr/`](docs/adr/) — mesh parity ([0001](docs/adr/0001-mesh-parity.md)) constrains the rest
- Benchmarks and the upstream memsearch contract: [`docs/research/`](docs/research/)

## Development

`mise run setup`, then `mise run check` / `test` / `dev`. No build step: pi loads `extensions/*.ts` through jiti, so the package ships TypeScript source and uses relative imports with explicit `.ts` extensions.

Task reference, test layout and the release process: [`CONTRIBUTING.md`](CONTRIBUTING.md).
