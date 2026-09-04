# Runtime behavior

What pi-memsearch does, in what order, on every pi event — plus every tunable and every way each path degrades.

Scope: pi-memsearch's own orchestration. The upstream memsearch CLI, index lifecycle and collection naming are documented separately in [`research/memsearch.md`](research/memsearch.md); this file does not restate them. Vocabulary: [`../CONTEXT.md`](../CONTEXT.md). Rationale for each design: [`adr/`](adr/).

Constants are named as they appear in source, so they stay greppable as line numbers drift.

## Hook to action

| pi event             | Actions, in order                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`      | Resolve the repository directory and project scope; fresh abort controllers; indexer catch-up; ensure the embedding provider once; build the stable snapshot; start the sidecar when auto-context is on |
| `before_agent_start` | Append the stable snapshot to the system prompt, rebuilding it first when the local date has rolled over; when auto-context is on, run the per-prompt search                                            |
| `agent_settled`      | Gate the exchange, distill it, append one memory entry, note the write so the debounced index is scheduled                                                                                              |
| `session_compact`    | Rebuild the stable snapshot                                                                                                                                                                             |
| `session_shutdown`   | Abort tool signals; begin indexer shutdown; flush the capture queue and settle the indexer, racing `SHUTDOWN_CAP_MS`; stop the sidecar                                                                  |

Registrations live in `src/extension.ts`, except capture (`src/capture.ts`).

## Memory entries

**Project scope** keys the memory store and the collection: the store command, else `$MEMSEARCH_DIR`, else the git root, else the working directory — memsearch's own resolution order, mirrored exactly, with an opt-in seam in front (`src/scope.ts`).

**Repository directory** is the working directory every memsearch child process runs at: the git root of the session's directory, else that directory. A project `.memsearch.toml` therefore layers as it would for a CLI run there. It coincides with the project scope except when `$MEMSEARCH_DIR` or the store command is set — even then children run at the repository directory, and only the store and collection follow the override.

**Collection** name is `ms_<sanitized-basename>_<8 hex of sha256(abs path)>`, memsearch's derivation (`src/scope.ts`), so pi searches the same collection every other mesh agent builds. It hashes the absolute path: moving a repo yields a new collection, and the next `session_start` catch-up indexes into it.

**Store command**, opt-in via `PI_MEMSEARCH_STORE_CMD`, takes over both derivations so pi can join a store outside the repos. `<cmd> memory-dir` prints the absolute store directory, `<cmd> collection` the collection name; both run with the working directory set to the directory being resolved. It outranks `MEMSEARCH_DIR`. A non-zero exit, empty output, or a relative store path raises an error naming the command and the mode — there is no fallback, because a wrong store means memory written to the wrong place. Answers are memoized per command, mode and directory for the life of the process, so capture, the indexer, every tool call, cross-repo fan-out and auto-context share one subprocess per directory. A store that is not itself named `memory` is fine everywhere except `memory_compact`, which refuses on one (see Memory compaction). Cross-repo fan-out asks it about each discovered project directory, which is a store directory rather than a session directory, so a resolver has to answer for a store it is standing in. The current project is exempt: its leg of the fan-out reuses the collection already resolved for the session, at the session's own directory. Rationale and rejected alternatives: [ADR 0007](adr/0007-delegated-store-resolution.md).

**Entry shape** in a daily memory file:

- `## Session HH:MM` — once per session
- `### HH:MM` — once per exchange
- a session anchor, then third-person bullets

```text
### 22:41
<!-- session:3f2c9b1e-… turn:ab12cd34 transcript:/home/you/.pi/agent/sessions/…/2026-08-13_….jsonl -->
- the user and the agent moved the hot cache to Redis with 5 minute TTLs
```

The session anchor carries the origin session id, the entry id and the transcript path. It is what makes L3 recall possible: any memory entry traces back to the conversation that produced it.

## Capture

Every settled exchange passes two gates before distillation:

- the assistant produced text
- the run was not aborted

What passes is distilled by the cheapest model of the session's provider by default; `PI_MEMSEARCH_CAPTURE_MODEL` overrides, as `<id>` or `<provider>/<id>` (`src/distillation-model.ts`). Automatic memory therefore does not inflate the bill.

A failed or timed-out distillation writes a diagnostic marker with the session anchor intact. The exchange is never dropped — see [ADR 0002](adr/0002-maximal-capture.md) for why capture is maximal.

## Recall

`/recall <query>`, or the agent reaching for the auto-discoverable recall skill on its own, walks progressive disclosure and stops at the shallowest layer that answers.

| Layer | Tool                | Returns                                                                                                | Cost                |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- |
| L1    | `memory_search`     | Top-k scored chunks, default 5                                                                         | One embedder load   |
| L2    | `memory_expand`     | The full section behind a chunk hash, plus its session anchor                                          | No embedder — cheap |
| L3    | `memory_transcript` | The turns around the anchored entry, following the branch the memory anchors to even past a later fork | Pure file read      |

Scores are normalized RRF ranks over hybrid dense + BM25 retrieval, **not** cosine similarity — do not interpret them as absolute confidence. An empty result says so; it never invents hits.

L3 exists because L2 sometimes loses the reasoning that produced a decision ([ADR 0006](adr/0006-l3-transcript-tool.md)). It never touches the backend, so it works while memsearch is unavailable.

### Cross-repo recall

Opt-in and read-side only. `/recall --all <query>`, or `memory_search` with `scope: "all"`:

- Fans out across every project found under `PI_MEMSEARCH_SCAN_ROOTS` — one sequential `search -c <collection>` per project, including projects only other mesh agents ever indexed.
- A scanned directory counts as a project when it holds `.memsearch/memory/` or `memory/`. The second shape is what `MEMSEARCH_DIR` and the store command produce when the store sits outside the repos; without it, fan-out over such a store finds nothing. It is accepted whether or not the store command is set.
- Hits merge by score, each labeled with its origin project.
- Never-indexed projects are skipped and counted; the result reports searched/skipped totals.
- Expansion follows across repos: pass the hit's origin path as `project` to `memory_expand`. The returned anchor makes L3 work across projects too.

Default recall stays project-scoped, and no store or collection is ever written. There is deliberately no global store ([ADR 0003](adr/0003-no-global-store-cross-repo-recall.md)).

## Redaction

`memory_forget` removes exactly one entry from its daily memory file, addressed by `chunk_hash` or `(date, time)` — no fuzzy matching. The entry's chunks leave the collection on the next reindex. A redaction also refreshes the stable snapshot, so the removed text cannot survive in the system prompt.

No copy survives in pi-memsearch: no recovery record, no audit log. The tool result echoing the removed markdown is the only record; salvageable facts re-enter via `memory_write`. Session transcripts and git history are outside the guarantee ([ADR 0004](adr/0004-redaction-over-recovery.md)).

## Memory compaction

An LLM condenses the whole memory store and appends the summary to today's daily memory file, which memsearch re-indexes immediately. Trigger: `memory_compact`, wrapping memsearch's own `compact`.

- Requires `llm.provider` and its API key in memsearch's config, and spends that provider's budget — so the model calls it only on explicit request.
- Returns the full markdown summary, or a plain "nothing to compact" when the collection has no chunks.
- Does not refresh the stable snapshot, same as a mid-session `memory_write`.
- Refuses on a store directory not named `memory`, naming it, and spends nothing. memsearch appends to `<output dir>/memory/<date>.md`, so a store like `<store-root>/<project>` would put the summary in `<store-root>/memory/`, shared with every sibling project and outside the store it summarizes ([#77](https://github.com/sripwoud/pi-memsearch/issues/77)).
- Lands as memsearch's own `## Memory Compact` block, outside pi's entry shape. `memory_forget` with a `chunk_hash` from inside it redacts the whole block; a later `memory_compact` regenerates a fresh summary ([#41](https://github.com/sripwoud/pi-memsearch/issues/41)).

Not pi's context compaction — the live conversation is untouched. The two senses are kept distinct throughout ([`../CONTEXT.md`](../CONTEXT.md)).

## Stable snapshot

One block appended to the system prompt on every turn: usage instructions, the tail of today's daily memory file (3000 chars), the tail of yesterday's (2000).

Rebuilt at four checkpoints:

- `session_start`
- day rollover — detected at `before_agent_start` by comparing the snapshot's local date key against now, not by a separate event
- `session_compact`
- after a `memory_forget` redaction

Byte-identical between checkpoints, so provider prefix caches survive across turns. Mid-session writes deliberately do not refresh it: their content is already visible in tool history, and refreshing would invalidate the cache on every write.

## Auto-context

Opt-in via `PI_MEMSEARCH_AUTO_CONTEXT=on`. Every user prompt runs a semantic search over the project collection and injects the hits as a message invisible in the TUI. Design and rejected alternatives: [ADR 0005](adr/0005-per-session-sidecar-auto-context.md).

| Constant (`src/auto-context.ts`) | Value  | Effect                                                                 |
| -------------------------------- | ------ | ---------------------------------------------------------------------- |
| `AUTO_CONTEXT_TOP_K`             | `3`    | Chunks requested and injected at most                                  |
| `AUTO_CONTEXT_SCORE_FLOOR`       | `0.5`  | Minimum score for a chunk to be injected                               |
| `AUTO_CONTEXT_CHAR_BUDGET`       | `2000` | Total injected characters                                              |
| `AUTO_CONTEXT_CAP_MS`            | `300`  | Hard search deadline; the prompt never waits longer                    |
| `AUTO_CONTEXT_QUERY_LIMIT`       | `500`  | The prompt is truncated to this before becoming the query              |
| `TIMEOUT_CRASH_THRESHOLD`        | `3`    | Consecutive deadline misses that kill the sidecar as unhealthy         |
| `MAX_SIDECAR_RESPAWNS`           | `2`    | Respawns per session; past the cap auto-context is off for the session |
| `SHUTDOWN_GRACE_MS`              | `2000` | Grace given the sidecar to exit at shutdown                            |

Chunks arrive in `memory_search` format, so any injected chunk hash chains into `memory_expand`. Chunks already verbatim in the stable snapshot are dropped.

One sidecar per session (`uv run`, same pinned memsearch spec, same config resolution) holds the embedding model warm for the whole session and opens a throwaway store per prompt. The machine-wide Milvus Lite lock is therefore borrowed for milliseconds, and other mesh agents stay unblocked. Crashes respawn lazily.

Every failure degrades to no injection, tracked in its own counter:

| Outcome                                   | Counter         |
| ----------------------------------------- | --------------- |
| Deadline miss                             | `skippedBudget` |
| Empty result                              | `skippedEmpty`  |
| Locked store, crashed or given-up sidecar | `skippedError`  |

Three consecutive deadline misses count as a crash, so a persistently slow embedding provider walks the respawn cap and switches auto-context off for the session rather than paying 300 ms on every prompt. Remote embedding providers will often miss the cap — a documented limitation, not special-cased. Resident memory while on: ~0.7–1.0 GB.

The injection lands after the prefix-cache boundary the new prompt already invalidates, so snapshot cache stability is untouched.

## Indexing and serialization

Milvus Lite allows a single client at a time, so every memsearch invocation goes through one queue (`src/backend.ts`).

- A locked-out call retries on `BACKOFF_DELAYS_MS` — 200 ms, 500 ms, 1 s, 2 s. Contention from another mesh agent resolves without surfacing as an error.
- Writes schedule an index `INDEX_DEBOUNCE_MS` (5 s) later, so a burst of captures costs one index.
- `session_shutdown` flushes the pending capture and settles the indexer, racing `SHUTDOWN_CAP_MS` (15 s).
- `memsearch watch` is never used: pi owns the indexing schedule, and a watcher would fight the queue for the lock.
- Index state is read from `$MEMSEARCH_DIR/.index-state.json` when that variable is set — memsearch's own state-dir override, and where its child writes the file — else from `.index-state.json` beside the store. A relative `$MEMSEARCH_DIR` resolves at the repository directory, because that is where the child runs; the store itself still resolves at the session directory, so the two can name different parents. `memory_status` prints the path it read. memsearch writes that file only inside a `.memsearch` tree or at `$MEMSEARCH_DIR`, so a store command answering outside both must export `$MEMSEARCH_DIR` itself or there is no index health to report ([ADR 0007](adr/0007-delegated-store-resolution.md)).

## Degradation

A missing `uv` or memsearch never breaks a session:

| Surface                                            | Without the backend                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Capture, `memory_write`                            | Still append to the daily memory file; the stable snapshot still reads it |
| `memory_search`, `memory_expand`, `memory_compact` | Return install instructions, not an error                                 |
| `memory_transcript`                                | Unaffected — a pure file read                                             |
| Auto-context                                       | No injection; the prompt proceeds                                         |

The store command is the deliberate exception: when it is set and fails, resolution raises instead of degrading, because a silent fallback would write memory to the wrong store.

`memory_compact` on a store directory not named `memory` is the other refusal. It is checked before the backend is probed, so it raises naming the store even when `uv` is missing, rather than returning install instructions for a call that could never have written to the right place.

Availability is re-probed with a short negative cache, so installing `uv` mid-session is picked up without a restart. Once the backend is back, the next index makes everything written in the meantime searchable.

`memory_status` reports what is missing, the active config, the index state — including memsearch's own `degraded` status and per-file failures — the chunk count, and the auto-context state with its counters.
