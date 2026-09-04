# memsearch: CLI and index contract (research for pi-memsearch)

Primary source: `/home/user/code/memsearch` (git checkout, `main` @ `d5809d7`, 2026-08-12, version 0.4.17 per `pyproject.toml:7`). Citations are checkout-relative. Runtime behavior marked "measured" was verified live on this machine against the installed release 0.4.16 (`memsearch --version`) — one patch behind the checkout; differences are called out where they matter.

## Summary: what a wrapper needs to know

- Python click CLI, entry point `memsearch = memsearch.cli:cli` (`pyproject.toml:52-53`). Install `uv tool install "memsearch[onnx]"` or shell out via `uvx --from memsearch[onnx] memsearch ...` (`README.md`, `plugins/claude-code/hooks/common.sh:48`).
- Wrapper surface: `index <paths> -c <collection>`, `search <query> -j -k N -c <collection> [--source-prefix P]`, `expand <chunk_hash> -j -c`, `transcript <path> -t <uuid> -j`, `stats -c`, `reset --yes -c`, `config get/set/list -j`. JSON (`-j`) exists on `search`, `expand`, `transcript`, `config list`, `skills list/status` — not on `index`/`stats`/`reset`/`compact`.
- Results on stdout; errors on stderr, exit 1 (`src/memsearch/cli.py:48-50,288-289`; `tests/test_cli_error_handling.py:21,37,77`). Click usage errors exit 2; `transcript` exits 3 on unknown format (`src/memsearch/cli.py:1397-1402`).
- Index is derived and rebuildable; the chunk-hash primary key in Milvus is the only dedup state (`docs/architecture.md:149`). Incremental by default, `--force` re-embeds (`src/memsearch/core.py:184-192`).
- Milvus Lite (default, `~/.memsearch/milvus.db`) is single-client: a concurrent open fails immediately on `fcntl.flock` with exit 1 and a traceback on stderr (measured). Wrapper must serialize calls or retry with backoff.
- Embedding model loads inside `MemSearch.__init__` on every `index`/`search`/`watch`/`compact` call; `expand`/`stats`/`reset` skip it (~0.6 s vs ~2.5 s for `search`, measured; `src/memsearch/cli.py:421-442`).
- Collection naming `ms_<name>_<hash>` is NOT in the Python package — it is plugin shell logic. Reimplement: sanitized dir basename + first 8 hex of SHA-256 of the absolute project path (`plugins/claude-code/scripts/derive-collection.sh:34-50`).
- `.memsearch.toml` project config is restricted to a 7-key allowlist since 0.4.17 — `milvus.uri`, `embedding.provider`, API keys etc. can only come from global config or CLI flags (`src/memsearch/config.py:33-45,441`).
- Stable Python API: `from memsearch import MemSearch` (`src/memsearch/__init__.py:3-5`) — the escape hatch for a warm-process design.

## Version note

The repo moves fast (0.4.0 → 0.4.17 between 2026-04 and 2026-08; `transcript`/`summarize`/`skills` commands, gitignore support, index-state files, and the project-config allowlist all landed in that window). Detect the version at runtime (`memsearch --version` → `memsearch, version X.Y.Z`, `src/memsearch/cli.py:204`) rather than assuming. `docs/cli.md` lags code: it still omits `search --source-prefix` and `--reranker-model` (grep at HEAD: 0 hits for `source-prefix`); code is truth.

## Identity and architecture

| Fact             | Value                                                                                                                               | Source                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Language / build | Python >=3.10, hatchling, `click>=8.1`                                                                                              | `pyproject.toml:11,18-29`                           |
| Core deps        | `pymilvus>=2.5.0,!=2.6.10`, `milvus-lite>=2.5.0` (non-Windows only), `watchdog`, `pathspec>=0.12`, `openai>=1.0` (always installed) | `pyproject.toml:19-28`                              |
| Extras           | `[google] [voyage] [jina] [mistral] [ollama] [local] [anthropic] [onnx] [all]`                                                      | `pyproject.toml:31-50`                              |
| Entry points     | `memsearch` script; `python -m memsearch`                                                                                           | `pyproject.toml:52-53`, `src/memsearch/__main__.py` |
| Public API       | `MemSearch` only export                                                                                                             | `src/memsearch/__init__.py:3-5`                     |

Modules: `cli.py` (click commands, 1419 lines), `core.py` (`MemSearch` orchestrator), `store.py` (`MilvusStore` over `pymilvus.MilvusClient`), `chunker.py` (heading chunking + chunk IDs), `scanner.py` (discovery + gitignore `IgnorePolicy`), `watcher.py` (watchdog + debounce), `compact.py` (LLM summarize), `config.py` (TOML layering), `reranker.py` (opt-in cross-encoder), `index_report.py`/`index_state.py` (index health diagnostics), `io.py` (tolerant UTF-8 read), `transcript.py` (L3 transcript parsing), `skills.py`+`maintenance.py` (procedural-memory distillation, background maintenance), `embeddings/` (8 providers behind a `Protocol`).

## CLI surface

Shared options on `index`/`search`/`expand`/`watch`/`compact`: `-p/--provider`, `-m/--model`, `--batch-size`, `--base-url`, `--api-key`, `-c/--collection`, `--milvus-uri`, `--milvus-token`; all default None = "use config" (`src/memsearch/cli.py:171-181`). `index`/`watch` add repeatable `--ignore-file NAME` and `--exclude PATTERN` (`src/memsearch/cli.py:184-200`).

### Commands

| Command                                  | Args / own flags                                                                                                                | Output (stdout)                                                                                                                 | JSON                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `index PATHS...`                         | `--force`, `--max-chunk-size` (>=1), `--description` (written on collection creation only), `--ignore-file`, `--exclude`        | `Indexed N chunks.`                                                                                                             | no                                                                      |
| `search QUERY`                           | `-k/--top-k` (default 5, `cli.py:351`), `--source-prefix PATH`, `--reranker-model`, `-j`                                        | text blocks `--- Result i (score: X.XXXX) ---`, content truncated at 500 chars with expand hint; `No results found.` when empty | array; empty → `[]`                                                     |
| `expand CHUNK_HASH`                      | `--section/--no-section` (default section), `-n/--lines N`, `-j`                                                                | source/heading/lines + content; parses anchors                                                                                  | object, optional `anchor`                                               |
| `transcript PATH`                        | `-t/--turn` (prefix match), `-c/--context` (default 3), `-j`                                                                    | conversation turns; auto-detects Claude Code / Codex / OpenClaw formats                                                         | `[{role,uuid,text,tools:[{name,command,output}]}]` (`cli.py:1408-1416`) |
| `watch PATHS...`                         | `--debounce-ms`, `--max-chunk-size`, `--description`, ignore flags                                                              | initial `Indexed N chunks.`, then per-event lines; Ctrl+C to stop                                                               | no                                                                      |
| `compact`                                | `-s/--source`, `-o/--output-dir`, `--llm-provider/-model/-base-url/-api-key`, `--prompt`, `--prompt-file`                       | `Compact complete. Summary:` + markdown                                                                                         | no                                                                      |
| `summarize`                              | `--plugin` (required; claude-code/codex/opencode/openclaw), `--agent-name`; reads stdin                                         | summary text; exit 2 if plugin configured "native" (`cli.py:788-793`)                                                           | no                                                                      |
| `stats`                                  | `-c`, `--milvus-uri`, `--milvus-token` only                                                                                     | `Total indexed chunks: N`                                                                                                       | no                                                                      |
| `reset`                                  | same as stats + confirmation; `--yes` skips                                                                                     | `Dropped collection.`                                                                                                           | no                                                                      |
| `config init/set/get/list`               | `init --project` (allowlisted keys only); `set KEY VALUE [--project]`; `get KEY`; `list [--resolved\|--global\|--project] [-j]` | `get` prints raw value, booleans lowercased for shell use (`cli.py:1203-1205`); `list -j` prints JSON (`cli.py:1229-1231`)      | `list` only                                                             |
| `skills distill/add/list/status/install` | procedural-memory candidate skills under `.memsearch/skill-candidates/`                                                         | listing / status                                                                                                                | `list`,`status`                                                         |

(`src/memsearch/cli.py:209-1419`.)

### search JSON result shape (measured)

```json
[{
  "chunk_hash": "6c64e3b992dade38",
  "content": "## Redis\n\n…",
  "source": "/abs/path/test.md",
  "heading": "Redis",
  "heading_level": 2,
  "start_line": 3,
  "end_line": 6,
  "score": 0.9999999
}]
```

Fields fixed by `MilvusStore._QUERY_FIELDS` + `score` (`src/memsearch/store.py:240-250`). `expand -j` → `{chunk_hash, source, heading, start_line, end_line, content[, anchor:{session,turn,transcript}]}` (`src/memsearch/cli.py:492-503`).

### Exit codes and streams

| Condition                                                                                                    | Exit | stderr message                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success                                                                                                      | 0    | —                                                                                                                                                                                                                                                                                                                                                    |
| `env:VAR` in config unset                                                                                    | 1    | `Configuration error: …` (`src/memsearch/cli.py:44-50`, `tests/test_cli_error_handling.py:60-79`)                                                                                                                                                                                                                                                    |
| `MilvusException` (incl. `stats`/`expand` on nonexistent collection: code 100, measured)                     | 1    | `Milvus error (code N): …`                                                                                                                                                                                                                                                                                                                           |
| `expand`: chunk / source file missing                                                                        | 1    | `Chunk not found: …` / `Source file not found: …` (`src/memsearch/cli.py:444-458`)                                                                                                                                                                                                                                                                   |
| Milvus Lite db held by another process                                                                       | 1    | full traceback; 0.4.17 wraps it as `RuntimeError: Could not open the local Milvus database at <path>: … another process already has the database open …` (`src/memsearch/store.py:27-51,90-95`); 0.4.16 said `Failed to open the local Milvus Lite database…` (measured). Underlying milvus-lite error: `another process holds the lock on '<path>'` |
| Click usage error                                                                                            | 2    | click standard                                                                                                                                                                                                                                                                                                                                       |
| `summarize` with native provider / `skills distill` with native provider / `skills install` without `--path` | 2    | explanatory line (`src/memsearch/cli.py:793,1271,1371`)                                                                                                                                                                                                                                                                                              |
| `transcript` unknown format                                                                                  | 3    | `Unrecognized transcript format…` (`src/memsearch/cli.py:1397-1402`)                                                                                                                                                                                                                                                                                 |
| `reset` without `--yes` non-interactive                                                                      | 1    | click confirmation abort (`src/memsearch/cli.py:868`)                                                                                                                                                                                                                                                                                                |
| `config set/get` unknown key                                                                                 | 1    | `Error: …` (`src/memsearch/cli.py:1192-1194,1206-1208`)                                                                                                                                                                                                                                                                                              |

Unexpected exceptions surface as raw tracebacks, exit != 0 (`tests/test_cli_error_handling.py:42-57`).

## Indexing lifecycle

- Discovery: recursive walk of each path; only `.md`/`.markdown` (case-insensitive); hidden files/dirs skipped (roots passed explicitly are exempt, so `.memsearch/memory/` works); dedup by realpath; sorted (`src/memsearch/scanner.py:21-67`). Optional gitignore semantics: `--ignore-file .gitignore` discovers ignore files per directory within each root (never parents); `--exclude` adds gitignore-style patterns; both off by default (`src/memsearch/scanner.py:86-101`, `src/memsearch/config.py:80-88`).
- Chunking: split at headings `#`–`######`; preamble = own chunk (heading `""`, level 0). Sections > `max_chunk_size` (default 1500 chars) split at paragraph > line > sentence/char boundaries with `overlap_lines` (default 2) carried over; every emitted piece re-bounded to `max_chunk_size` (`src/memsearch/chunker.py:80-142,145-246`). Chunks whose body minus headings/HTML-comments is < 2 chars are dropped (`src/memsearch/chunker.py:12-14,31-44`).
- Embedding hygiene: HTML comments (session anchors) stripped from the text sent to the embedder; stored content unchanged (`src/memsearch/chunker.py:17-28`, `src/memsearch/core.py:203-207`).
- Chunk ID (primary key): `sha256("markdown:{source}:{start_line}:{end_line}:{content_hash}:{model}")[:16]` with `content_hash = sha256(content)[:16]`; matches OpenClaw's format (`src/memsearch/chunker.py:59-77`).
- Incremental per file: new IDs vs existing IDs queried by `source`; stale (old − new) deleted; only (new − old) embedded; `--force` embeds all (`src/memsearch/core.py:161-194`). Change detection is purely content-addressed — mtime/size are scanned but unused for dedup.
- Deleted-file cleanup is scoped to directory roots of the current run — indexing a single explicit file no longer prunes unrelated sources (changed vs 0.4.x-early; `src/memsearch/core.py:127-136,455-472`).
- Per-file failures are logged, skipped, and the run still exits 0 printing only the success count (`src/memsearch/core.py:118-125`, `src/memsearch/cli.py:269-278`). Failures land in `IndexReport.failed_files`, persisted to `.memsearch/.index-state.json` (schema v1) when an indexed path lies inside a `.memsearch` tree or `$MEMSEARCH_DIR` is set; state includes status ok/degraded/error, timestamps, failed files (`src/memsearch/index_report.py:19-31`, `src/memsearch/index_state.py:14-46`). A wrapper should read that file to detect partial failure.
- Collection schema (created on first write-mode open if absent): `chunk_hash` VARCHAR(64) PK, `embedding` FLOAT_VECTOR(dim), `content` VARCHAR(65535) analyzer-enabled, `sparse_vector` SPARSE_FLOAT_VECTOR auto-generated by a Milvus BM25 Function over `content`, `source`/`heading` VARCHAR(1024), `heading_level`/`start_line`/`end_line` INT64; FLAT/COSINE + SPARSE_INVERTED_INDEX/BM25 indexes; collection explicitly loaded after open (`src/memsearch/store.py:103-152`).
- Dimension guard: opening an existing collection with a provider of a different dim raises `ValueError` advising `memsearch reset --yes` (`src/memsearch/store.py:154-173`). The Claude Code plugin greps index output for `dimension mismatch` and auto reset+reindexes (`plugins/claude-code/hooks/session-start.sh:126-141`).
- Derived state: Milvus db at `milvus.uri` (default `~/.memsearch/milvus.db`, parent auto-created; `src/memsearch/store.py:84-86`). Plugin conventions: memory markdown `<git-root>/.memsearch/memory/*.md`, pidfiles `.memsearch/.watch.pid` / `.memsearch/.index.pid`, state `.memsearch/.index-state.json`, skill candidates `.memsearch/skill-candidates/` (`plugins/claude-code/hooks/common.sh:29-42,130,176`, `src/memsearch/config.py:162-178`). ONNX model artifacts live in the HuggingFace cache, offline-first (`src/memsearch/embeddings/onnx.py:63-111` at 0.4.0; same mechanism at HEAD).
- Non-UTF-8 bytes in memory files are replaced, not fatal (`src/memsearch/io.py:11-28`).

## Search behavior

- Always hybrid: dense COSINE + BM25 sparse, fused by `RRFRanker(k=60)`; scores normalized to [0,1] by dividing by the theoretical max `2/(60+1)`; 1.0 = ranked #1 in both retrievers (`src/memsearch/store.py:189-240`, `docs/cli.md:468`).
- Empty-collection guard returns `[]` (BM25 crashes on avgdl=0; `src/memsearch/store.py:200-203`).
- CLI default top-k 5 (`src/memsearch/cli.py:351`); Python API default 10 (`src/memsearch/core.py:220`).
- `--source-prefix` → Milvus filter `source like "<prefix>%"`; the prefix is `expanduser().resolve()`d, so relative prefixes resolve against the CLI's cwd and must match the absolute stored `source` (`src/memsearch/core.py:241-245`).
- Reranking opt-in via `--reranker-model` / `[reranker].model` (empty = disabled, default); fetches `top_k*3` then cross-encodes; default constant `Alibaba-NLP/gte-reranker-modernbert-base`; silently skipped if no backend installed (`src/memsearch/config.py:96-98`, `src/memsearch/core.py:247-254`, `src/memsearch/reranker.py:1-27`).
- Query provider/model must match index-time provider/model — mismatched vector spaces return garbage silently (`docs/cli.md:467`).

## Configuration

Priority: dataclass defaults → `~/.memsearch/config.toml` → restricted `./.memsearch.toml` → CLI flags (`src/memsearch/config.py:1-5,431-444`). Project path is literally `Path(".memsearch.toml")` — cwd-relative; control cwd or pass flags (`src/memsearch/config.py:26`).

**Project-config allowlist (0.4.17):** only `milvus.collection`, `embedding.batch_size`, `chunking.max_chunk_size`, `chunking.overlap_lines`, `indexing.ignore_files`, `indexing.exclude`, `watch.debounce_ms` are honored from `.memsearch.toml`; anything else (URIs, providers, keys, prompts, plugin automation) is silently filtered at load, and `config set --project` rejects it with exit 1 (`src/memsearch/config.py:33-45,385-404,567-570`). A wrapper wanting per-project `milvus.uri` or provider must use CLI flags.

| Key                                                                          | Default                   | Notes                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `milvus.uri`                                                                 | `~/.memsearch/milvus.db`  | local path = Milvus Lite; `http(s)://`/`tcp://` = server/Zilliz (`src/memsearch/store.py:74`)                      |
| `milvus.token` / `milvus.collection`                                         | `""` / `memsearch_chunks` | (`src/memsearch/config.py:49-52`)                                                                                  |
| `embedding.provider`                                                         | `openai`                  | openai/google/voyage/jina/mistral/ollama/local/onnx                                                                |
| `embedding.model`                                                            | `""` = provider default   | table below                                                                                                        |
| `embedding.batch_size`                                                       | 0 = provider default      | onnx default 32                                                                                                    |
| `embedding.base_url` / `api_key`                                             | `""`                      | `env:VAR_NAME` indirection supported (`src/memsearch/config.py:251-277`)                                           |
| `chunking.max_chunk_size` / `overlap_lines`                                  | 1500 / 2                  |                                                                                                                    |
| `indexing.ignore_files` / `exclude`                                          | `[]` / `[]`               | new config files from the wizard opt in to `.gitignore` (`src/memsearch/config.py:80-88`, `cli.py:929-932`)        |
| `watch.debounce_ms`                                                          | 1500                      |                                                                                                                    |
| `reranker.model`                                                             | `""` = disabled           |                                                                                                                    |
| `llm.provider/model/base_url/api_key`                                        | `""`                      | for compact; `[compact]` deprecated with DeprecationWarning (`src/memsearch/config.py:446-457`)                    |
| `llm.providers.<name>.*`                                                     | —                         | named providers for plugin summarize routing; env refs resolved lazily (`src/memsearch/config.py:113-123,288-294`) |
| `prompts.compact/summarize/project_review/user_profile/memory_to_skill`      | `""`                      | custom prompt files                                                                                                |
| `plugins.<platform>.summarize/project_review/user_profile/memory_to_skill.*` | see source                | per-platform automation, `<platform>` ∈ claude-code/codex/opencode/openclaw (`src/memsearch/config.py:140-205`)    |

`config set` coerces ints, booleans (`true/false/1/0/yes/no/on/off`), and lists (JSON array or comma-separated) (`src/memsearch/config.py:29-31,572-597`). `config init` is interactive — wrappers use `config set`.

### Embedding providers

| Provider | Default model           | Dim  | Key env var                           | Extra             |
| -------- | ----------------------- | ---- | ------------------------------------- | ----------------- |
| openai   | text-embedding-3-small  | 1536 | `OPENAI_API_KEY` (+`OPENAI_BASE_URL`) | base dep          |
| google   | gemini-embedding-001    | 768  | `GOOGLE_API_KEY`                      | `[google]`        |
| voyage   | voyage-3-lite           | 512  | `VOYAGE_API_KEY`                      | `[voyage]`        |
| jina     | jina-embeddings-v4      | 2048 | `JINA_API_KEY`                        | `[jina]`          |
| mistral  | mistral-embed           | 1024 | `MISTRAL_API_KEY`                     | `[mistral]`       |
| ollama   | nomic-embed-text        | 768  | `OLLAMA_HOST` optional                | `[ollama]`        |
| local    | all-MiniLM-L6-v2        | 384  | none                                  | `[local]` (torch) |
| onnx     | gpahal/bge-m3-onnx-int8 | 1024 | none                                  | `[onnx]`          |

(`src/memsearch/embeddings/__init__.py:38-47`, `docs/cli.md:856-863`). Missing extra → `ImportError` with install hint. Compact/summarize LLM defaults: gpt-5-mini / claude-sonnet-4-6 / gemini-3-flash-preview; keys `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_API_KEY` (`src/memsearch/compact.py:72-76,92-96`).

Env vars read by core: provider API keys (via SDKs), `env:` refs, and `MEMSEARCH_DIR` (index-state dir override, `src/memsearch/index_state.py:31`). `MEMSEARCH_NO_WATCH=1` is plugin-shell-only (`plugins/claude-code/hooks/common.sh`).

## Collection naming (`ms_<name>_<hash>`)

Not in the Python package (grep at HEAD: no `ms_` derivation in `src/`); each plugin ships an identical `derive-collection.sh`. Algorithm to reimplement byte-for-byte (`plugins/claude-code/scripts/derive-collection.sh:16-50`):

1. Project dir = `$MEMSEARCH_DIR` if explicitly set (global scope), else git root, else `CLAUDE_PROJECT_DIR`/cwd; resolve absolute (`plugins/claude-code/hooks/common.sh:29-42`, `plugins/claude-code/skills/memory-recall/SKILL.md:12`).
2. `sanitized` = basename → lowercase → `[^a-z0-9]`→`_` → collapse `__+`→`_` → strip edge `_` → first 40 chars.
3. `hash` = first 8 hex of `sha256(absolute_path)` (no trailing newline: `printf '%s' | sha256sum`).
4. `ms_${sanitized}_${hash}` — e.g. `/home/user/my-app` → `ms_my_app_a1b2c3d4`.

Identical scripts in codex/openclaw/opencode plugins; this shared derivation is what makes cross-agent memory work (`docs/architecture.md:233-235`).

## Performance (measured, 0.4.16, warm caches)

| Call                                   | Wall   | Why                                                                              |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `memsearch --version`                  | ~1.0 s | interpreter + click + import                                                     |
| `stats` (Lite)                         | ~0.6 s | Milvus Lite spin-up only, no embedder (`src/memsearch/cli.py:846-855`)           |
| `search -j` (onnx)                     | ~2.5 s | + ONNX tokenizer/session load + probe embed in provider `__init__` + query embed |
| `index` 1 file (onnx, cold collection) | ~4.5 s | + collection creation + chunk embed                                              |

pi README's ~3.4 s/call sits inside this bracket. Cost structure: embedder constructed eagerly in `MemSearch.__init__` (`src/memsearch/core.py:79-85`); the ONNX provider loads tokenizer + inference session and runs a probe embedding at construction (`src/memsearch/embeddings/onnx.py`, 0.4.0 lines 49-61, unchanged mechanism). Levers:

- `expand`/`stats`/`reset` bypass the embedder entirely (`MilvusStore(dimension=None)` read-only mode; `src/memsearch/cli.py:437-442`) — L2 expansion is cheap; route `/recall` follow-ups there freely.
- uvx adds <0.3 s warm, ~2 s cold; the plugin warms it via `uvx --upgrade --from 'memsearch[onnx]' memsearch --version` at session start (`plugins/claude-code/hooks/session-start.sh:19-21`).
- First-ever onnx run downloads model files from HuggingFace; plugin comments cite ~10 s first ONNX load (`plugins/claude-code/hooks/session-start.sh:123`); warm-cache tip: run any dummy search once (`docs/troubleshooting.md:100-108`).
- A warm Python process (API below) amortizes everything except the embed itself.

## Programmatic API

`from memsearch import MemSearch` is the documented stable surface (`src/memsearch/__init__.py`, `docs/python-api.md`). Constructor mirrors CLI kwargs incl. `ignore_files`/`exclude` (`src/memsearch/core.py:55-93`). Methods: `await index(force=False) -> int`; `await index_with_report(force=False) -> IndexReport` (status ok/degraded + per-file failures, `src/memsearch/core.py:108-152`); `await index_file(path) -> int`; `await search(query, top_k=10, source_prefix=None) -> list[dict]`; `await compact(...) -> str`; `watch(on_event=..., on_error=..., debounce_ms=...) -> FileWatcher` (sync, background thread); `close()`; context manager (`src/memsearch/core.py:154-445`).

The API does not read TOML config — layering happens only in the CLI (`src/memsearch/cli.py:238-250`); an API consumer passes everything explicitly. For pi-memsearch (TypeScript) the CLI is the practical interface; the API matters only if a warm Python sidecar is added to kill the per-call model load. `compact` appends to `<output-dir|first-path>/memory/YYYY-MM-DD.md` and immediately re-indexes it (`src/memsearch/core.py:320-336`).

## Sharp edges for a wrapper

- **Milvus Lite is single-client.** milvus-lite takes `fcntl.flock(LOCK_EX|LOCK_NB)` — no waiting, instant `DataDirLockedError`. Measured: two parallel `search` on one `.db` → loser exits 1 with a traceback dump on stderr. 0.4.17 wraps it as `RuntimeError: Could not open the local Milvus database at <path>: …` naming "another process already has the database open" as a likely cause (`src/memsearch/store.py:27-51,90-95`); 0.4.16 used a different, misleading message (`Failed to open the local Milvus Lite database… older Milvus Lite release`). Detect on either wrapper string or the underlying `another process holds the lock`; retry with backoff. Never run `watch` alongside ad-hoc calls on Lite — the Claude Code plugin skips `watch` on Lite and does one-shot indexing at session start instead (`plugins/claude-code/hooks/common.sh:228-231`, `docs/platforms/claude-code/troubleshooting.md:133`).
- **Lock contention re-measured on 0.4.17 (2026-08-14, milvus-lite 3.2.0).** `memsearch[onnx]>=0.4.17,<0.5` resolves milvus-lite 3.x, which moved the lock from `<dir>/.<db>.lock` (2.x, `fcntl.lockf`) to `<db-dir>/LOCK` (`fcntl.flock`) — the `.db` path is now a directory. A locked-out call still exits 1, and its stderr carries both `DataDirLockedError: another process holds the lock on '<db dir>'` and the wrapper's `RuntimeError: Failed to open the local Milvus Lite database.` — the same phrasing 0.4.16 used for an incompatible database, so that string alone does not identify contention. Detect on the `another process holds the lock` chain and retry.
- **milvus_lite subprocess can outlive the CLI.** `MilvusStore.close()` explicitly releases the Lite server to free the lock (`src/memsearch/store.py:307-318`); a SIGKILLed memsearch skips it. The plugin sweeps orphaned `milvus_lite/lib/milvus` processes because rapid open/close cycles leak them and can consume tens of GB of virtual memory (`plugins/claude-code/hooks/common.sh:128-172`). A wrapper spawning memsearch should SIGTERM (not SIGKILL) and consider an orphan sweep.
- **No JSON for `index`/`stats`/`reset`/`compact`.** Parse `Indexed (\d+) chunks\.` and `Total indexed chunks: (\d+)` (`src/memsearch/cli.py:278,855`).
- **`index` exits 0 despite per-file failures**; read `.memsearch/.index-state.json` (`status: "degraded"`, `failed_files`) for truth (`src/memsearch/core.py:118-125`, `src/memsearch/index_state.py`).
- **Project config allowlist** silently drops non-allowlisted keys from `.memsearch.toml` — a wrapper that writes `milvus.uri` there will be ignored without error (`src/memsearch/config.py:385-399`).
- **`.memsearch.toml` discovery is cwd-relative** (`src/memsearch/config.py:26`) — run from project root or pass flags.
- **`reset` prompts** unless `--yes`; `config init` always interactive.
- **`expand` requires the source file at the exact absolute indexed path**; moved/deleted → exit 1 (`src/memsearch/cli.py:455-458`). Indexes are not portable across machines or repo moves (absolute `source` paths).
- **Provider/model switches change chunk IDs** (model in the composite hash) → full re-embed; dimension change additionally requires `reset` (`src/memsearch/chunker.py:65-77`, `src/memsearch/store.py:154-173`).
- **Windows:** Milvus Lite unsupported; local URI raises `RuntimeError` on win32 (`src/memsearch/store.py:74-83`).
- **`pymilvus != 2.6.10` exclusion** (`pyproject.toml:19`) — respect if pinning.
- **Remote-server `stats` lag** after upserts (flush/compaction); Lite immediate (`docs/cli.md:774`).
- **Score semantics:** normalized RRF rank fusion, not cosine similarity — 0.5 ≈ "top hit in one of two retrievers"; thresholds are rank-based (`src/memsearch/store.py:237-240`).
- **Memory-file conventions** the capture side must reproduce for cross-agent parity: `<git-root>/.memsearch/memory/YYYY-MM-DD.md`, `## Session HH:MM` headings, `### HH:MM` turn subheadings, anchor `<!-- session:ID turn:UUID transcript:/abs/path.jsonl -->` (parse regex `<!--\s*session:(\S+)\s+turn:(\S+)\s+transcript:(\S+)\s*-->`, `src/memsearch/cli.py:480-482`; file shape `docs/platforms/claude-code/how-it-works.md:145-199`; writer `plugins/claude-code/hooks/stop.sh:117-126`).
- **Recall reference flow** (what the pi `/recall` skill should mirror): `search "<q>" --top-k 5 -j -c <coll>` → evaluate → `expand <hash> -c <coll>` per relevant hit → optional L3 `transcript <path> -t <uuid> -c 3` (`plugins/claude-code/skills/memory-recall/SKILL.md:20-30`; L3 now core CLI).

## Open questions

- Exact decomposition of the pi-measured ~3.4 s/call (uvx vs import vs ONNX load) not isolated; measured bracket here: 1.0 s base → 2.5 s search. Cold uvx cache untested.
- 0.4.17 timings not re-measured live; the lock message was (see the sharp edge above).
- `skills`/`maintenance` semantics (candidate store format, git commits inside `.memsearch/skill-candidates/`) skimmed only via CLI layer — potentially relevant to pi skills integration later, out of v1 scope.
- `watch` against Milvus Server and Zilliz Cloud (token auth, latency) unexercised — out of scope per pi README non-goals.
- The plugin `summarize` routing (`[llm.providers]`, `plugins.<platform>.summarize`) was verified at config/CLI level, not end-to-end.
