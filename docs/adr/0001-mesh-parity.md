# Mesh parity governs storage, naming, and embedding config

pi-memsearch exists to join pi to the cross-agent memory mesh — the agents (Claude Code, Codex, OpenClaw, OpenCode) sharing one per-project memory store and index through memsearch conventions. Wherever a pi-local design and the mesh convention diverge, the mesh wins, even when the convention lives outside memsearch's Python package or looks better done differently.

Concretely:

- **Store location**: memory lives at `<project>/.memsearch/memory/`, keyed by memsearch's own project-scope resolution (`$MEMSEARCH_DIR`, else git root, else cwd) — not user-global like pi-memory's `~/.pi/agent/memory`, and including the cwd fallback outside git repos.
- **Collection naming**: the `ms_<name>_<hash>` derivation is reimplemented byte-for-byte from memsearch's plugin shell script (sanitized basename, 40-char cap, first 8 hex of SHA-256 of the absolute project path). It is not in the Python package, and we do not invent our own scheme.
- **Embedding provider**: the shared `~/.memsearch/config.toml` is the source of truth. The package never forces provider flags; it bootstraps `embedding.provider = onnx` only when nothing is configured. Forcing a pi-preferred provider would silently split pi's vector space from the other agents (index/query provider mismatch returns garbage).
- **File format**: daily memory files, `## Session HH:MM` / `### HH:MM` headings, third-person bullets, session anchors — exactly what the other plugins write.

Considered alternative: an independent pi-native design (own store location, own naming, pinned provider) would be simpler to build and evolve, but produces exactly the silo that motivated replacing pi-memory. Reversing this decision later strands every embedded collection and orphans pi's memories from the mesh, so divergence must be treated as a breaking change, not a refactor.
