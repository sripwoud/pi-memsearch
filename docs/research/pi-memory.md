# pi-memory research (prior art for pi-memsearch)

Primary source: `/home/sripwoud/code/pi-memory` @ v0.4.2 (`package.json:3`). All paths below are relative to that repo root.

## Summary

- pi-memory is a single-file TypeScript pi extension (`index.ts`, 2431 lines) declared via `"pi": {"extensions": ["./index.ts"]}` in `package.json:17-21`, distributed as an npm package installed with `pi install npm:pi-memory` (`README.md:36-41`). No build step — pi loads TS directly (`README.md:242`).
- Reuse the whole pi-side skeleton: 5 hook points (`session_start`, `before_agent_start`, `session_before_compact`, `session_shutdown`, `input`), `pi.registerTool` for 7 tools, system-prompt injection by returning `{systemPrompt}` from `before_agent_start`, and the KV-cache-stable snapshot mechanism. None of it touches qmd semantics.
- Reuse verbatim: markdown store + timestamped entry format, context builder with per-section char budgets (16K total), forget/restore recovery records, exit-summary pipeline (LLM call with min-message and "all-None" gates, self-imposed 10s shutdown timeout), compaction handoff, debounced background re-index after writes, availability caching with short negative TTL, graceful degradation when the backend is missing.
- Replace: the entire qmd process layer (~500 lines) — availability detection via `qmd collection list`, collection/context auto-setup, `search`/`vsearch`/`query` subcommand mapping, `qmd update` + `qmd embed` maintenance split, "need embeddings" stderr sniffing, ANSI-stripping/lenient JSON parsing, Windows shim bypass, and the 3-mode search tool schema (keyword/semantic/deep maps 1:1 to qmd subcommands).
- One structural divergence to decide deliberately: pi-memory's store is user-global (`~/.pi/agent/memory`, `index.ts:50-58`); memsearch conventions are per-git-root (`.memsearch/memory/`). Everything downstream (collection setup, injection sources, capture targets) keys off that one directory constant.
- pi-memory registers no skills, slash commands, or prompt templates — recall is purely a tool (`memory_search`) plus prompt-injected instructions. The pi-memsearch plan's `/recall` skill has no precedent in this repo.

## 1. Package identity

| Fact               | Value                                                                                                                           | Source                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| npm name / version | `pi-memory` 0.4.2, MIT, author jayzeng                                                                                          | `package.json:2-3,22-23`                                 |
| pi manifest        | `"pi": { "extensions": ["./index.ts"] }`                                                                                        | `package.json:17-21`                                     |
| Code layout        | single file `index.ts` (2431 lines); tests in `test/`; no build step                                                            | `AGENTS.md:5`, `README.md:242`                           |
| Install            | `pi install npm:pi-memory` or `pi install ./pi-memory`                                                                          | `README.md:36-41`                                        |
| Published files    | `index.ts`, `scripts`, `README.md`, `CHANGELOG.md`, `LICENSE`                                                                   | `package.json:32-38`                                     |
| Runtime deps       | none; pi APIs are peerDependencies `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `>=0.81.1` (dev-pinned 0.84.1) | `package.json:50-63`                                     |
| Node engine        | `>=22.19.0` (matches pi runtime)                                                                                                | `package.json:57-59`, `CHANGELOG.md:47-50`               |
| postinstall        | dev-checkout-only git-hooks setup; deliberately silent about qmd on consumer installs                                           | `scripts/postinstall.cjs:12-15,35-42`                    |
| Publishing         | tag-driven GitHub Actions (`v*` tag must match `package.json`), lint+build+unit gates, provenance                               | `README.md:252-267`, `.github/workflows/publish-npm.yml` |

Runtime data lives outside the repo at `~/.pi/agent/memory/`: `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, `recovery/<uuid>.json` (`index.ts:8-12,60-64`; `README.md:98-110`).

## 2. pi integration surface

Entry point: default-exported function receiving `pi: ExtensionAPI` (`index.ts:1426`). Types imported from `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ExtensionContext`, `SessionEntry`, `convertToLlm`, `serializeConversation`) and `@earendil-works/pi-ai` (`Type`, `StringEnum`, `Message`, `complete` from `/compat`) (`index.ts:26-38`).

### Hook points

| Hook                     | Registered at   | Does                                                                                                                                                                                                               |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_start`          | `index.ts:1428` | reset per-session state; subscribe `ctx.ui.onTerminalInput` to detect Ctrl+D (``) for exit-reason tagging; `detectQmd()`; auto-`setupQmdCollection()`; catch-up `ensureQmdEmbed()`; refresh memory snapshot        |
| `session_shutdown`       | `index.ts:1465` | receives `event.reason` (`reload`/`new`/`resume`/`fork` skipped by default, `index.ts:540-544`); generates LLM exit summary raced against 10s self-timeout; appends to today's daily log; synchronous `qmd update` |
| `input`                  | `index.ts:1532` | sniffs `/quit` text to tag exit reason; returns `{action: "continue"}`                                                                                                                                             |
| `before_agent_start`     | `index.ts:1540` | builds/reuses memory context, returns `{systemPrompt: event.systemPrompt + block}` (`index.ts:1581-1583`) — this is the injection mechanism                                                                        |
| `session_before_compact` | `index.ts:1587` | writes handoff entry (open scratchpad items + last 15 lines of today's log) to daily log; refreshes snapshot in `finally`                                                                                          |

### Tool registration

`pi.registerTool({name, label, description, parameters, async execute(toolCallId, params, signal, onUpdate, ctx)})`; parameters are TypeBox schemas (`Type.Object`, `StringEnum`) (`index.ts:1635-1656` for the first). Seven tools registered — asserted in `test/unit.test.ts:2011`:

| Tool             | Registered at   |
| ---------------- | --------------- |
| `memory_write`   | `index.ts:1635` |
| `scratchpad`     | `index.ts:1756` |
| `memory_read`    | `index.ts:1934` |
| `memory_forget`  | `index.ts:2046` |
| `memory_restore` | `index.ts:2153` |
| `memory_search`  | `index.ts:2216` |
| `memory_status`  | `index.ts:2351` |

Tool results are `{content: [{type:"text", text}], isError?, details}` (e.g. `index.ts:1679-1695`).

### ExtensionContext surface used

`ctx.sessionManager.getSessionId()` / `.getBranch()` (defensively feature-detected, `index.ts:360-368`); `ctx.model`, `ctx.modelRegistry.getApiKey`/`getApiKeyForProvider`/`find` (also feature-detected, `index.ts:370-403`); `ctx.hasUI`, `ctx.ui.notify` / `.onTerminalInput` / `.getEditorText`; `ctx.isIdle()` (`index.ts:1434-1441`). The extension can call the LLM itself: `complete(model, {systemPrompt, messages}, {apiKey, reasoningEffort: "low"})` (`index.ts:467-471`).

No skill, slash-command, or prompt-template registration anywhere in the repo — the model learns memory conventions solely from the injected system-prompt header (`index.ts:1567-1576`) and tool descriptions.

## 3. Capture pipeline

Three write paths; no full-transcript storage:

1. **Model-driven `memory_write`** — long_term (append or overwrite `MEMORY.md`) or daily (always append). Every entry is stamped `<!-- YYYY-MM-DD HH:MM:SS [8-char-session-id] -->` above the content (`index.ts:1675,1716,1736`). Tool description instructs the model to use `#tags` and `[[wiki-links]]` (`index.ts:1638-1644`).
2. **Auto exit summary on real quit** (Ctrl+D, `/quit`, session end) — session branch serialized via `convertToLlm` + `serializeConversation`, truncated to last 80K chars (`index.ts:161,312-327`); LLM prompted for fixed headings Decisions / Lessons Learned / Notes / Follow-ups (`index.ts:329-348`); gated: skipped under 4 messages (`index.ts:162,429-435`), skipped when every section is "None." (`isExitSummaryEmpty`, `index.ts:518-525`), skipped on lifecycle transitions unless `PI_MEMORY_SUMMARIZE_TRANSITIONS` (`index.ts:540-544`), raced against 10s timeout because pi awaits shutdown handlers with no timeout (`index.ts:527-538,1498-1502`). Appended to today's daily log (`index.ts:1509-1519`).
3. **Compaction handoff** — on `session_before_compact`, open scratchpad items + last 15 lines of today's log appended as a `<!-- HANDOFF ... -->` block, so it re-enters context on the next turn via daily-log injection (`index.ts:1587-1632`; `README.md:158-172`).

Dedup at capture: none. Correction is post-hoc via `memory_forget` (removes whole timestamped entry blocks matching a case-insensitive substring, writes a recovery record before mutating, `index.ts:675-725,2105-2116`) and `memory_restore` (idempotent, appends only missing entries, `index.ts:2182-2191`).

## 4. Storage & retrieval via qmd

All qmd interaction is CLI shell-out via `execFile` — never a library import (`index.ts:26,936-948`).

### qmd command inventory

| Command                                                               | Purpose                                                                           | Timeout                                         | Source               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------- |
| `qmd collection list`                                                 | availability probe (chosen over `qmd status`, which triggers slow device probing) | 15s                                             | `index.ts:1081-1089` |
| `qmd collection list --json`                                          | check `pi-memory` collection exists                                               | 10s                                             | `index.ts:1100`      |
| `qmd collection add <dir> --name pi-memory`                           | first-run bootstrap                                                               | 10s                                             | `index.ts:1043`      |
| `qmd context add <path> <desc> -c pi-memory`                          | path descriptions `/daily` and `/` (best-effort)                                  | 10s                                             | `index.ts:1053-1067` |
| `qmd update`                                                          | re-index after writes, debounced 500ms, fire-and-forget                           | 30s                                             | `index.ts:1172-1180` |
| `qmd update` (awaited)                                                | final index at shutdown                                                           | 30s                                             | `index.ts:1182-1190` |
| `qmd embed`                                                           | incremental embeddings; in-flight/pending queue; first run may download model     | 10min                                           | `index.ts:1128-1161` |
| `qmd search / vsearch / query --json -c pi-memory -n <limit> <query>` | keyword / semantic / deep search                                                  | 60s default (`PI_MEMORY_QMD_SEARCH_TIMEOUT_MS`) | `index.ts:1291-1325` |

### Robustness plumbing around the CLI

- Env hygiene: `NO_COLOR=1`, `FORCE_COLOR` deleted (`index.ts:930-934`).
- Output hardening: ANSI CSI/OSC stripping because qmd emits spinners even with `--json` (`index.ts:1263-1269`); lenient JSON parse skipping non-JSON leading lines and handling literal "No results found." (`index.ts:1271-1289`).
- Result-shape tolerance: qmd's JSON is not treated as stable — path read as `path ?? file`, text as `content ?? chunk ?? snippet`, top level as array or `{results}` or `{hits}` (`index.ts:1244-1261,1314`).
- Windows: npm cmd-shims for qmd are broken (literal `/bin/sh` interpreter), so the extension locates `node_modules/@tobilu/qmd/dist/cli/qmd.js` on PATH and invokes it with `node` directly (`index.ts:877-927`; `CHANGELOG.md:117-123`).
- Caching: availability and collection existence cached 5min positive / 5s negative TTL, so installing qmd mid-session is picked up fast (`index.ts:950-961`); collection cache seeded after setup (`index.ts:1068-1070`).
- Search limit clamped 1-25 (default 5) before reaching `-n` (`index.ts:1237-1242`).
- Query sanitation for auto-injection: control chars stripped, 200-char cap (`index.ts:1196-1201`).

### Latency handling

Everything backend-touching is async and never on the critical path: writes schedule a debounced background `qmd update` chaining into `qmd embed` (`index.ts:1176-1179`); per-turn auto-search (per-turn mode only) is `Promise.race`d against 3s and fails silently (`index.ts:1204-1234`); embeddings probe raced against 4s returning `"unknown"` rather than blocking (`index.ts:1334-1351`); explicit `memory_search` alone tolerates the full 60s.

## 5. Context injection UX

`before_agent_start` appends a `## Memory` block to the system prompt containing usage instructions ("If someone says 'remember this,' write it immediately", tags/links guidance, tool routing) plus the built context (`index.ts:1567-1583`).

`buildMemoryContext` (`index.ts:780-869`) assembles sections in priority order with per-section budgets (`index.ts:151-159`; rationale in `design.md:110-138`):

| Priority | Section                                  | Budget               | Truncation |
| -------- | ---------------------------------------- | -------------------- | ---------- |
| 1        | open scratchpad items only               | 2K chars / 120 lines | from start |
| 2        | today's daily log                        | 3K / 120             | tail (end) |
| 3        | auto-search results (per-turn mode only) | 2.5K / 80            | from start |
| 4        | `MEMORY.md`                              | 4K / 150             | middle     |
| 5        | yesterday's daily log                    | 3K / 120             | tail       |
| —        | overall cap                              | 16K chars            | from start |

No relevance thresholds — search results are included as returned (top 3, keyword mode) or omitted entirely on error/empty (`index.ts:1209-1229`).

### KV cache-stable snapshot (default mode)

The injected block is byte-stable across turns so local prefix caches (llama.cpp, vLLM, MLX) survive; it refreshes only at checkpoints: `session_start`, `session_before_compact`, `memory_write(target: long_term)` / `memory_forget` / `memory_restore` (via `snapshotDirty`), and day rollover (`index.ts:1384-1420,1550-1563`; `README.md:125-138`). Daily/scratchpad writes deliberately do not dirty the snapshot — their content is already visible in tool-call history (`index.ts:1709-1713`). A caveat line in the header tells the model the snapshot timestamp and to use `memory_read`/`memory_search` for authoritative state (`index.ts:1559-1562`).

`PI_MEMORY_SNAPSHOT=per-turn` restores per-prompt rebuild plus automatic keyword search of the user prompt (top 3 injected) — at the cost of busting the KV cache every turn (`index.ts:1546-1549`; `README.md:140-144`).

## 6. Configuration

All config is env vars; no config file. Documented at `README.md:186-196`; implementations:

| Var                                 | Default                             | Code                 |
| ----------------------------------- | ----------------------------------- | -------------------- |
| `PI_MEMORY_DIR`                     | `~/.pi/agent/memory`                | `index.ts:50-58`     |
| `PI_MEMORY_SNAPSHOT`                | `stable` (`per-turn` opt-out)       | `index.ts:1408-1411` |
| `PI_MEMORY_QMD_UPDATE`              | `background` (`manual`/`off`)       | `index.ts:489-495`   |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS`   | 60000                               | `index.ts:964-967`   |
| `PI_MEMORY_NO_SEARCH`               | unset (per-turn mode only)          | `index.ts:1547`      |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS`   | unset (transitions skip summaries)  | `index.ts:497-500`   |
| `PI_MEMORY_EXIT_SUMMARY`            | enabled (`0/off/false/no` disables) | `index.ts:506-509`   |
| `PI_MEMORY_EXIT_SUMMARY_MODEL`      | session model                       | `index.ts:395-417`   |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | 10000                               | `index.ts:535-538`   |

`memory_status` doubles as a doctor tool reporting all of the above plus qmd/collection/embedding health (`index.ts:2351-2430`).

## 7. qmd-specific vs backend-agnostic

| Component                                                                                                | Classification               | Notes                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package manifest / pi extension declaration                                                              | generic                      | `package.json:17-21`                                                                                                                                                     |
| Hook wiring (5 hooks) + tool registration pattern                                                        | generic                      | `index.ts:1426-1587`                                                                                                                                                     |
| Markdown store, entry stamp format, daily/local-date keying                                              | generic                      | `index.ts:60-64,90-114`; memsearch would relocate to `.memsearch/memory/`                                                                                                |
| Context builder, budgets, truncation, priority order                                                     | generic                      | `index.ts:151-159,780-869`                                                                                                                                               |
| Snapshot / KV-cache stability machinery                                                                  | generic                      | `index.ts:1384-1420`                                                                                                                                                     |
| Exit-summary pipeline (LLM call, gates, shutdown timeout)                                                | generic                      | `index.ts:298-544`                                                                                                                                                       |
| Compaction handoff                                                                                       | generic                      | `index.ts:1587-1632`                                                                                                                                                     |
| Scratchpad line-preserving mutations                                                                     | generic                      | `index.ts:596-662`                                                                                                                                                       |
| forget/restore + recovery records                                                                        | generic                      | `index.ts:664-774` (note: recovery JSON kept outside the `**/*.md` index, `README.md:177`)                                                                               |
| Debounce-after-write re-index pattern                                                                    | generic pattern, qmd command | `index.ts:1172-1180`; swap in `memsearch index`                                                                                                                          |
| Availability/collection caching TTLs                                                                     | generic pattern              | `index.ts:950-961`                                                                                                                                                       |
| `detectQmd` / `checkCollection` / `setupQmdCollection` (collection + path-context model)                 | qmd-specific                 | `index.ts:1040-1126`; memsearch derives `ms_<project>_<hash>` itself — reuse its derivation, don't port this                                                             |
| `runQmdSearch` subcommand map (`search`/`vsearch`/`query`) + flags                                       | qmd-specific                 | `index.ts:1291-1325`; memsearch has one search verb with `-j -k -c`                                                                                                      |
| `memory_search` 3-mode tool schema (keyword/semantic/deep)                                               | qmd-specific                 | `index.ts:2216-2236`; modes exist because qmd exposes three engines. memsearch is single-mode hybrid — schema should change, likely adding `expand <chunk_hash>` instead |
| Result-shape guessing (`path??file`, `content??chunk??snippet`)                                          | qmd-specific                 | `index.ts:1244-1261`; memsearch `-j` output is documented — parse strictly                                                                                               |
| ANSI stripping / lenient JSON scan                                                                       | qmd-specific symptom         | `index.ts:1263-1289`; keep only if memsearch output proves noisy                                                                                                         |
| `qmd update` vs `qmd embed` two-step maintenance + "need embeddings" stderr sniffing + `probeEmbeddings` | qmd-specific                 | `index.ts:1128-1190,1281-1351`; memsearch `index` does chunk+embed in one pass                                                                                           |
| Windows `qmd.js` shim bypass                                                                             | qmd-specific                 | `index.ts:877-927`; uvx has its own launch story                                                                                                                         |
| Install-instruction strings                                                                              | qmd-specific                 | `index.ts:1014-1037`                                                                                                                                                     |
| Latency claims in tool description (~30ms/~2s/~10s)                                                      | qmd-specific                 | `index.ts:2222-2224`                                                                                                                                                     |

## 8. Design decisions worth copying or avoiding

Copy:

- **Graceful degradation as invariant**: every backend feature has timeout + fallback; core tools never require the backend; `memory_search` returns install instructions instead of erroring opaquely (`design.md:61-64`, `index.ts:2243-2254`).
- **Fail-silent auto-injection** with a hard 3s race — errors produce an absent section, never a broken turn (`index.ts:1230-1234`).
- **Self-imposed shutdown timeout** — pi awaits shutdown handlers indefinitely (`index.ts:529-534`); critical for memsearch given ~3.4s per uvx call.
- **Curated-write gates** — min-message threshold and all-"None." filter keep boilerplate out of a log that gets re-injected every session (`index.ts:429-435,511-525`; `CHANGELOG.md:22-27`).
- **Short negative-TTL availability cache** so installing the backend mid-session works without restart (`index.ts:950-956`).
- **Local calendar date for daily keys** — UTC filed evening writes under tomorrow (`index.ts:90-99`; `CHANGELOG.md:56-58`).
- **Recovery record written before mutation** so a failed write never reports an unrecoverable deletion (`index.ts:2113-2116`).
- **In-flight/pending queue for the expensive indexing call** (`index.ts:1132-1161`) — the natural home for memsearch's required retry-with-backoff around Milvus Lite's single-client limit (pi-memory needs none because qmd has no such constraint).
- **Test seams**: injectable `execFile`, base-dir override, cache resetters (`index.ts:66-78,972-1010`) enable a fully deterministic unit suite (2400 lines, no backend, no LLM).
- **`memory_status` doctor tool** — one call answers "why doesn't search work" (`index.ts:2350-2430`).

Avoid / decide differently:

- **Per-turn search injection was demoted from default** (0.2.0 default → opt-in at 0.3.10) because prompt-dependent injection busts the KV cache every turn (`CHANGELOG.md:127-135`, `README.md:140-144`). pi-memsearch's "auto-context off by default" matches this lesson; the 3.4s CLI startup makes per-turn even less viable without prefetch.
- **Defensive result-shape guessing** exists because qmd's JSON was unstable (`index.ts:1244-1261`); with memsearch's documented `-j` schema, prefer strict parsing that fails loudly.
- **Silent `catch { return false }` in `setupQmdCollection`** conflates "already exists" with real failures (`index.ts:1046-1049`) — surface bootstrap errors in the status tool instead.
- **Middle-truncation of MEMORY.md at 4K** is flagged by the author as an unvalidated tradeoff as memory grows (`design.md:401-405`).

## Open questions

- Exact pi `ExtensionAPI` hook signatures/payloads are not vendored in this repo; they live in `@earendil-works/pi-coding-agent` (node_modules). Hook names, return shapes (`{systemPrompt}`, `{action:"continue"}`), and the 5-arg `execute` signature are confirmed only by usage here and the mock in `test/unit.test.ts:75-92`. Verify against pi source before relying on other events.
- `ctx.sessionManager.getBranch` and `ctx.modelRegistry.getApiKey`/`find` are feature-detected with optional casts (`index.ts:360-368,374-388,399-403`), implying these APIs vary across pi versions — pin and verify the peer-dep floor pi-memsearch targets.
- Whether pi supports "skills"/prompt-template registration (as pi-memsearch's plan assumes for `/recall`) cannot be answered from this repo — pi-memory uses tools only.
- `design.md`'s recall-eval numbers (15/15 vs 10/15) are explicitly illustrative, never measured (`design.md:384-387`); the search-mode latency figures (~30ms/~2s/~10s) appear only in prose/tool descriptions (`README.md:90-95`, `index.ts:2222-2224`), not in measurements in the repo.
- `session_before_compact` handoff behavior when compaction fires mid-tool-call, and whether `before_agent_start` fires for sub-agents, are not observable from this codebase.
