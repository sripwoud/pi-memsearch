# pi-memsearch

[memsearch](https://zilliztech.github.io/memsearch/)-backed long-term memory for [pi](https://pi.dev): pi writes to and recalls from the same per-project memory store that Claude Code, Codex, OpenClaw and OpenCode already share.

## Why

pi ships no built-in memory by design ("primitives, not features"). The existing community option, `pi-memory`, delegates search to [qmd](https://github.com/tobilu/qmd) and keeps its index user-global. Two reasons for a memsearch alternative:

1. **Recall accuracy.** Head-to-head benchmark (2026-08-13, 35 queries over an identical corpus of 223 markdown files, pre-agreed decision rule, blind ground truth): memsearch **32/35** strong hits vs **26/35** for qmd's best mode. They tie on short keyword queries; memsearch wins on paraphrased and natural-question recall — the phrasing you actually use when asking "how did we fix X?" weeks later. Full report: the author's `~/knowledge/inbox/memsearch-vs-pi-memory-benchmark.md`.
2. **Cross-agent memory.** memsearch already integrates Claude Code, OpenClaw, OpenCode and Codex CLI, all sharing one markdown format and one collection-name derivation. This package joins pi to that mesh: pi recalls what Claude Code learned yesterday in the same repo, and vice versa.

## Install

Prerequisites: [uv](https://docs.astral.sh/uv/) (the only external dependency — memsearch runs through `uvx`, so there is no Python packaging to manage), pi >= 0.84.1 (0.84.x is the tested line), Node >= 22.19.

```sh
pi install https://github.com/sripwoud/pi-memsearch      # all projects (~/.pi/settings.json)
pi install https://github.com/sripwoud/pi-memsearch -l   # this project (.pi/settings.json)
```

First run, once per machine: `uvx` resolves `memsearch[onnx]>=0.4.17,<0.5`, and the first embedding downloads the onnx model (~560 MB, ~10 s) — announced as a notice so the pause is not mistaken for a hang. No API key is involved: when no embedding provider is configured anywhere, the package sets `embedding.provider = onnx` in memsearch's global config once. An existing config is never touched.

## What it does

| Surface          | pi mechanism                       | Behavior                                                                              |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Capture          | `agent_settled` hook               | Distills every content-bearing exchange into the daily memory file, in the background |
| Deliberate write | `memory_write` tool                | Persists a memory immediately, on request                                             |
| Indexing         | `session_start` / write / shutdown | Catch-up index, debounced index 5 s after a write, final index at shutdown            |
| Recall           | `/recall`, recall skill, two tools | `memory_search` (chunks) → `memory_expand` (section) → origin transcript              |
| Stable snapshot  | `before_agent_start` hook          | Recent memory appended to the system prompt, byte-identical between checkpoints       |
| Diagnostics      | `memory_status` tool               | Backend, version, scope, collection, index health, chunk count in one call            |

### Memory store

Markdown is the source of truth; the vector index is derived and rebuildable at any time.

- **Location**: `<project>/.memsearch/memory/YYYY-MM-DD.md`, one file per calendar day, appended to by every agent in the mesh.
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

An empty result says so plainly instead of inviting invention.

### Stable snapshot

At session start, day rollover and after compaction, the package builds one block — usage instructions, the tail of today's memory file (3000 chars) and of yesterday's (2000) — and appends it to the system prompt on every turn. It is byte-identical between those checkpoints, so provider prefix caches survive. Mid-session writes deliberately do not refresh it; their content is already visible in tool history.

### Indexing and serialization

Milvus Lite allows a single client at a time, so every memsearch invocation goes through one queue and retries a locked-out call with backoff (200 ms, 500 ms, 1 s, 2 s). Contention from another agent in the mesh resolves without surfacing as an error. `memsearch watch` is never used. Shutdown flushes the pending capture and runs a final index within a 15 s cap.

## Tools

| Tool            | Layer | Purpose                                                                                |
| --------------- | ----- | -------------------------------------------------------------------------------------- |
| `memory_write`  | —     | Persist a memory now: timestamped, anchored, appended to today's file                  |
| `memory_search` | L1    | Top-k scored chunks for a query                                                        |
| `memory_expand` | L2    | Full section for a chunk hash, with its session anchor                                 |
| `memory_status` | —     | Doctor: uv/memsearch presence and version, scope, collection, index state, chunk count |

## Configuration

Everything shared with the mesh — provider, model, chunking — lives in memsearch's own config (`~/.memsearch/config.toml`). Only pi-local behavior is configured here:

| Variable                         | Default                                | Effect                                                                    |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `PI_MEMSEARCH_CAPTURE`           | on                                     | `off` disables automatic capture; `memory_write` keeps working            |
| `PI_MEMSEARCH_CAPTURE_MODEL`     | cheapest model of the session provider | Distillation model, as `<id>` or `<provider>/<id>`                        |
| `PI_MEMSEARCH_SNAPSHOT`          | on                                     | `off` disables snapshot injection                                         |
| `PI_MEMSEARCH_SEARCH_TIMEOUT_MS` | `30000`                                | Per-attempt timeout for `memory_search`                                   |
| `MEMSEARCH_DIR`                  | unset                                  | memsearch's own scope override; the memory store and collection follow it |

## When the backend is missing

Markdown is the source of truth, so a missing `uv` or memsearch degrades rather than breaks:

- Capture and `memory_write` keep appending to the daily file, and the snapshot keeps reading it.
- `memory_search` and `memory_expand` return install instructions instead of an error.
- Availability is re-probed with a short negative cache, so installing `uv` mid-session is picked up without a restart.
- Once the backend is back, the next index makes everything written in the meantime searchable.

`memory_status` is the one-step answer to "why doesn't search work": it reports what is missing, the active config, the index state (including memsearch's own `degraded` status and per-file failures), and the last index failure.

## Unsupported

- **Running alongside `pi-memory`** — both capture every exchange and both inject context. Pick one.
- **Milvus Server / Zilliz Cloud** — Milvus Lite only.
- **Windows** — milvus-lite ships no Windows wheels; use WSL2.
- **A forked or patched memsearch** — the package orchestrates the released CLI, and invents no memory format of its own.

## Post-v1 candidates

Deferred, not rejected: per-turn auto-context (semantic injection on every prompt, once a warm-sidecar design exists — the snapshot is the designed seam); a user-global memory layer beyond `$MEMSEARCH_DIR`; `scratchpad`, `memory_forget`, `memory_restore` and `memory_read` tools; wiring memsearch's own maintenance (`compact`, `skills distill`); and an upstream pi adapter for `memsearch transcript`, so L3 stops parsing pi JSONL here.

## Development

`mise run setup` once, then:

| Task                        | What                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `mise run check` / `fix`    | biome, dprint, tsc                                                     |
| `mise run test`             | Unit suite: deterministic, no backend, no network, no LLM              |
| `mise run test:integration` | Real `uvx` + onnx round trip; needs `uv`, gated on `PI_MEMSEARCH_IT=1` |
| `mise run dev`              | pi with the local extension loaded                                     |

No build step: pi loads `extensions/*.ts` through jiti, so the package ships TypeScript source and uses relative imports with explicit `.ts` extensions.

Before a release: `mise run check`, `mise run test`, `mise run test:integration` (it drives capture → index → search → expand and the lock-contention retry against real memsearch), then `pi install` the package and confirm a live session captures and recalls. Raising the memsearch version ceiling in `src/contract.ts` or the pi peer range in `package.json` is a deliberate act: bump it, then re-run the integration suite on that line.

Evidence base for the design decisions: `docs/research/`. Vocabulary: `CONTEXT.md`. Mesh-parity decision: `docs/adr/0001-mesh-parity.md`.
