# pi-memsearch

[memsearch](https://zilliztech.github.io/memsearch/)-backed long-term memory for [pi](https://pi.dev), packaged as a community pi package.

## Why

pi ships no built-in memory by design ("primitives, not features") — long-term memory is meant to be an extension. The existing option, `pi-memory`, delegates all search to [qmd](https://github.com/tobilu/qmd). Two reasons to build a memsearch alternative:

1. **Recall accuracy.** Head-to-head benchmark (2026-08-13, 35 queries over an identical personal-memory corpus of 223 markdown files, pre-agreed decision rule, blind ground truth, human-arbitrated edge cases): memsearch **32/35** strong hits vs **26/35** for qmd's best mode. The two are at parity on short keyword queries; memsearch wins on paraphrased and natural-question recall — the phrasing actually used when asking "how did we fix X?" weeks later. qmd's BM25 mode returned *zero* results on 8/35 queries, and its LLM-reranked hybrid (15–24 s/query on CPU) never beat its own plain RRF fusion. Full report: `~/knowledge/inbox/memsearch-vs-pi-memory-benchmark.md`.
2. **Cross-agent memory.** memsearch already integrates Claude Code, OpenClaw, OpenCode, and Codex CLI — all sharing one markdown memory format (`.memsearch/memory/*.md` at the git root) and identical collection-name derivation. A pi package joins pi to that mesh: pi recalls what Claude Code learned yesterday in the same repo, and vice versa. `pi-memory`'s qmd index is a silo.

## What

One pi package bundling:

| Piece | pi mechanism | Responsibility |
|---|---|---|
| Capture | extension (TypeScript) | Distill session turns into `.memsearch/memory/YYYY-MM-DD.md` at the git root, memsearch conventions (markdown = source of truth; the vector index is derived and rebuildable) |
| Index | extension | Invoke the memsearch CLI (`uvx --from 'memsearch[onnx]' memsearch index …`) on session end / memory-file change |
| Recall | skill + prompt template (`/recall`) | Three-layer progressive disclosure: `search` (top-k chunks, `-j`) → `expand <chunk_hash>` (full section) → original transcript |
| Auto-context | extension (optional, off by default) | Inject top-k relevant chunks before a turn via pi's dynamic-context hook |

No Python packaging burden on users: everything shells out through `uvx`; the only prerequisite is `uv`.

## Design constraints (measured, not assumed)

- **~3.4 s per CLI call** (uvx startup + ONNX `bge-m3-onnx-int8` load, every invocation). Fine for explicit `/recall`; per-turn auto-context needs async prefetch or a warm process — decide during design, don't block v1 on it.
- **Milvus Lite is single-client.** Concurrent invocations transiently fail with `Failed to open the local Milvus Lite database`. Every call needs retry-with-backoff (0/70 failures in the benchmark when calls were naturally spaced; frequent during rapid-fire setup). Never run `memsearch watch` alongside ad-hoc calls.
- **Collection naming must match memsearch's own per-project derivation** (`ms_<project>_<hash>`) — that is what keeps the memory shared with the other agent integrations. Reuse memsearch's logic; do not invent a scheme.
- Integration surface: `memsearch search -j -k <n> -c <collection> [--source-prefix <path>]`, `memsearch expand <hash>`, `memsearch index <paths> -c <collection>`, `memsearch stats`; config at `~/.memsearch/config.toml` (`[embedding] provider = "onnx"`).

## Non-goals

- No Milvus server / Zilliz Cloud support in v1 — Milvus Lite default only.
- No fork of memsearch; the package orchestrates the CLI.
- No new memory format — memsearch's markdown conventions verbatim.

## Status

Design phase. Nothing implemented yet.
