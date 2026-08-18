<div align="center">

# pi-memsearch

[![npm](https://img.shields.io/npm/v/pi-memsearch?logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/pi-memsearch)
[![ci](https://img.shields.io/github/actions/workflow/status/sripwoud/pi-memsearch/master.yml?branch=master&logo=githubactions&logoColor=white&label=ci)](https://github.com/sripwoud/pi-memsearch/actions/workflows/master.yml?query=branch%3Amaster)

</div>

[memsearch](https://zilliztech.github.io/memsearch/)-backed long-term memory for [pi](https://pi.dev): pi writes to and recalls from the same per-project memory store that Claude Code, Codex, OpenClaw and OpenCode already share.

## Why

pi ships no built-in memory by design ("primitives, not features"). The existing community option, `pi-memory`, delegates search to [qmd](https://github.com/tobilu/qmd) and keeps its index user-global. Two reasons for a memsearch alternative:

1. **Recall accuracy.** Head-to-head benchmark (2026-08-13, 35 queries over an identical corpus of 223 markdown files): memsearch **32/35** strong hits vs **26/35** for qmd's best mode. They tie on short keyword queries; memsearch wins on paraphrased and natural-question recall — the phrasing you actually use when asking "how did we fix X?" weeks later. Full report: [`docs/research/memsearch-vs-pi-memory-benchmark.md`](docs/research/memsearch-vs-pi-memory-benchmark.md).
2. **Cross-agent memory.** memsearch already integrates Claude Code, OpenClaw, OpenCode and Codex CLI, all sharing one markdown format and one collection-name derivation. This package joins pi to that mesh: pi recalls what Claude Code learned yesterday in the same repo, and vice versa.

## Install

Current release: [1.2.0](CHANGELOG.md). <!-- x-release-please-version -->

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

| Surface          | pi mechanism                             | Behavior                                                                                               |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Capture          | `agent_settled` hook                     | Distills every content-bearing exchange into the daily memory file, in the background                  |
| Deliberate write | `memory_write` tool                      | Persists a memory immediately, on request                                                              |
| Indexing         | `session_start` / write / shutdown       | Catch-up index, debounced index 5 s after a write, final index at shutdown                             |
| Recall           | `/recall`, recall skill, two tools       | `memory_search` (chunks) → `memory_expand` (section) → origin transcript                               |
| Skill drafting   | `skill-drafting` skill                   | Turns remembered work into skill candidates in memsearch's git-tracked store; installs only on request |
| Redaction        | `memory_forget` tool                     | Removes one entry from the day file and, via reindex, the collection; no copy kept                     |
| Maintenance      | `memory_compact` tool                    | Memory compaction on request: an LLM condenses the store into today's file                             |
| Stable snapshot  | `before_agent_start` hook                | Recent memory appended to the system prompt, byte-identical between checkpoints                        |
| Auto-context     | `before_agent_start` hook + warm sidecar | Opt-in: top memory chunks injected per prompt within a 300 ms budget                                   |
| Diagnostics      | `memory_status` tool                     | One-call health report — see [Tools](#tools)                                                           |

### Memory store

Markdown is the source of truth; the vector index is derived and rebuildable at any time.

- **Location**: `<project>/.memsearch/memory/YYYY-MM-DD.md`, one file per calendar day, appended to by every agent in the mesh.
- **Git**: commit `.memsearch/` to share memory with collaborators, or gitignore it to keep it personal — the vector index lives in `~/.memsearch/milvus.db` either way, so the choice costs nothing.
- **Project scope**: `$MEMSEARCH_DIR`, else the git root, else the working directory — memsearch's own resolution order.
- **Collection**: `ms_<sanitized-basename>_<8 hex of sha256(abs path)>`, memsearch's derivation, so pi searches the same collection the other agents build.
- **Entry shape**: `## Session HH:MM` once per session, `### HH:MM` per exchange, then a session anchor and third-person bullets:

```text
### 22:41
<!-- session:3f2c9b1e-… turn:ab12cd34 transcript:/home/you/.pi/agent/sessions/…/2026-08-13_….jsonl -->
- the user and the agent moved the hot cache to Redis with 5 minute TTLs
```

The anchor is what makes the third recall layer possible: any memory can be traced back to the conversation that produced it.

### Capture

After each exchange settles, two hard gates apply — the assistant produced text, and the run was not aborted — and everything that passes is distilled. Distillation uses the cheapest model of the session's provider by default, so automatic memory does not inflate the bill; a failed or timed-out call writes a diagnostic marker with the anchor intact rather than dropping the exchange.

### Recall

`/recall <query>`, or the agent reaching for the auto-discoverable recall skill on its own, walks progressive disclosure and stops at the shallowest layer that answers:

1. `memory_search` — top-k scored chunks (default 5). Scores are normalized RRF ranks over hybrid dense + BM25 retrieval, not cosine similarity.
2. `memory_expand` — the full section behind a chunk hash, plus its anchor. Loads no embedder, so it is cheap.
3. The origin transcript at the anchor's path, read directly — last resort.

```text
you ▸ /recall how did we fix the flaky redis test?
pi  ▸ memory_search → 5 chunks; top: 2026-08-13 "moved the hot cache to Redis with 5 minute TTLs" (0.81)
      memory_expand → the full "### 22:41" section, with its session anchor
      → answered at layer 2; the origin transcript was never opened
```

An empty result says so plainly instead of inviting invention.

When the conversation happened in _another_ repo, cross-repo recall widens the search: `/recall --all <query>` (or `memory_search` with `scope: "all"`) fans out across every project found under `PI_MEMSEARCH_SCAN_ROOTS` — one sequential `search -c <collection>` per project, including projects only other mesh agents ever indexed. Hits merge by score, each labeled with its origin project; never-indexed projects are skipped and counted, and the result reports searched/skipped totals. Expansion follows across repos: pass the hit's origin path as `project` to `memory_expand`. Strictly opt-in and read-side only — default recall stays project-scoped, and no store or collection is ever touched ([ADR 0003](docs/adr/0003-no-global-store-cross-repo-recall.md)).

### Redaction

`memory_forget` removes exactly one entry — addressed by `chunk_hash` or `(date, time)`, no fuzzy matching — from its day file; the entry's chunks leave the collection on the next reindex. No copy survives in pi-memsearch — no recovery record, no audit log — so the tool result echoing the removed markdown is the only record, and salvageable facts re-enter via `memory_write`. Session transcripts and git history are outside the guarantee (`docs/adr/0004-redaction-over-recovery.md`).

### Memory compaction

`memory_compact` runs memsearch's `compact` — an LLM condenses the whole memory store and appends the summary to today's daily memory file, which memsearch immediately re-indexes. Not to be confused with pi's context compaction: the live conversation is untouched. It requires `llm.provider` (and its API key) in memsearch's config and spends that provider's budget, so the model calls it only on explicit request; the tool result is the full markdown summary, or a plain "nothing to compact" when the collection has no chunks. Like a mid-session `memory_write`, it does not refresh the stable snapshot. The summary lands as memsearch's own `## Memory Compact` block, outside pi's entry shape; `memory_forget` with a chunk_hash from inside the block redacts the whole block, and a later `memory_compact` regenerates a fresh summary ([#41](https://github.com/sripwoud/pi-memsearch/issues/41)).

### Stable snapshot

At session start, day rollover, after context compaction and after a `memory_forget` redaction, the package builds one block — usage instructions, the tail of today's memory file (3000 chars) and of yesterday's (2000) — and appends it to the system prompt on every turn. It is byte-identical between those checkpoints, so provider prefix caches survive. Mid-session writes deliberately do not refresh it; their content is already visible in tool history.

### Auto-context

Opt-in (`PI_MEMSEARCH_AUTO_CONTEXT=on`): every user prompt runs a semantic search over the project collection and injects up to 3 chunks (score ≥ 0.5, ~2000 chars total, `memory_search` format — any injected chunk hash chains into `memory_expand`) as a message invisible in the TUI. A per-session Python sidecar (`uv run`, same pinned memsearch spec, same config resolution) keeps the embedding model warm for the whole session and opens a throwaway store per prompt, so the machine-wide Milvus Lite lock is borrowed for milliseconds and other mesh agents stay unblocked. The search races a **300 ms hard cap**: a miss, an empty result, a locked store or a crashed sidecar all degrade to no injection — the prompt never waits on memory. Crashes respawn lazily, capped at 2 per session; past the cap auto-context is off for the session. Costs ~0.7–1.0 GB resident memory while on; remote embedding providers will often miss the cap (documented limitation, not special-cased). Chunks already verbatim in the stable snapshot are dropped, and the injection lands after the prefix-cache boundary the new prompt already invalidates, so cache stability is untouched. Design and rejected alternatives: [ADR 0005](docs/adr/0005-per-session-sidecar-auto-context.md).

### Indexing and serialization

Milvus Lite allows a single client at a time, so every memsearch invocation goes through one queue and retries a locked-out call with backoff (200 ms, 500 ms, 1 s, 2 s). Contention from another agent in the mesh resolves without surfacing as an error. `memsearch watch` is never used. Shutdown flushes the pending capture and runs a final index within a 15 s cap.

## Tools

| Tool             | Layer | Purpose                                                                                                                 |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| `memory_write`   | —     | Persist a memory now: timestamped, anchored, appended to today's file                                                   |
| `memory_search`  | L1    | Top-k scored chunks for a query; `scope: "all"` widens to cross-repo recall                                             |
| `memory_expand`  | L2    | Full section for a chunk hash, with its session anchor; `project` routes to a cross-repo hit's origin                   |
| `memory_forget`  | —     | Redact one entry or compact block from store and collection; the tool result is the only record                         |
| `memory_compact` | —     | Memory compaction on explicit request; returns memsearch's markdown summary                                             |
| `memory_status`  | —     | Doctor: uv/memsearch presence and version, scope, collection, index state, chunk count, auto-context state and counters |

## Configuration

Everything shared with the mesh — provider, model, chunking — lives in memsearch's own config (`~/.memsearch/config.toml`). Only pi-local behavior is configured here:

| Variable                          | Default                                | Effect                                                                                                    |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PI_MEMSEARCH_CAPTURE`            | on                                     | `off` disables automatic capture; `memory_write` keeps working                                            |
| `PI_MEMSEARCH_CAPTURE_MODEL`      | cheapest model of the session provider | Distillation model, as `<id>` or `<provider>/<id>`                                                        |
| `PI_MEMSEARCH_SNAPSHOT`           | on                                     | `off` disables snapshot injection                                                                         |
| `PI_MEMSEARCH_AUTO_CONTEXT`       | off                                    | `on` enables per-prompt injection via a warm sidecar (~1 GB resident) — see [Auto-context](#auto-context) |
| `PI_MEMSEARCH_SEARCH_TIMEOUT_MS`  | `30000`                                | Per-attempt timeout for `memory_search` (each cross-repo invocation too)                                  |
| `PI_MEMSEARCH_COMPACT_TIMEOUT_MS` | `300000`                               | Per-attempt timeout for `memory_compact` (LLM pass plus reindex)                                          |
| `PI_MEMSEARCH_SCAN_ROOTS`         | unset                                  | `:`-separated directory roots scanned for other projects' memory stores; required by cross-repo recall    |
| `MEMSEARCH_DIR`                   | unset                                  | memsearch's own scope override; the memory store and collection follow it                                 |

## Troubleshooting

A missing `uv` or memsearch degrades rather than breaks:

- Capture and `memory_write` keep appending to the daily file, and the snapshot keeps reading it.
- `memory_search`, `memory_expand` and `memory_compact` return install instructions instead of an error.
- Availability is re-probed with a short negative cache, so installing `uv` mid-session is picked up without a restart.
- Once the backend is back, the next index makes everything written in the meantime searchable.

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

## Development

`mise run setup` once, then:

| Task                        | What                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `mise run check` / `fix`    | biome, dprint, tsc                                                     |
| `mise run test`             | Unit suite: deterministic, no backend, no network, no LLM              |
| `mise run test:integration` | Real `uvx` + onnx round trip; needs `uv`, gated on `PI_MEMSEARCH_IT=1` |
| `mise run dev`              | pi with the local extension loaded                                     |

No build step: pi loads `extensions/*.ts` through jiti, so the package ships TypeScript source and uses relative imports with explicit `.ts` extensions.

Before a release: `mise run check`, `mise run test`, `mise run test:integration` (it drives capture → index → search → expand and the lock-contention retry against real memsearch), then `pi install` the package and confirm a live session captures and recalls. Raising the memsearch version ceiling in `src/contract.ts` or the pi peer range in `package.json` is a deliberate act: bump it, then re-run the integration suite on that line. Both files ship in the published tarball, so type those commits `feat:` (widened support) or `fix:`/`feat!:` — never `build:`, which cuts no release. `build:` is for the lockfile and devDependencies, which never reach a consumer.

Evidence base for the design decisions: [`docs/research/`](docs/research/). Vocabulary: [`CONTEXT.md`](CONTEXT.md). Mesh-parity decision: [`docs/adr/0001-mesh-parity.md`](docs/adr/0001-mesh-parity.md).
