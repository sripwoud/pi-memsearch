# No user-global memory store; cross-repo recall is read-side only

Issue #24 proposed a user-global memory layer above project scope. Real usage showed the pain was never a memory that belonged to no repo — it was recalling in the *wrong* repo: knowing a memory exists but not which project holds it. That is a search-scope problem, not a storage-scope gap. We decided against any second store: repo-less scope already has a mesh-blessed answer (`MEMSEARCH_DIR` pointed at a shared directory — the Claude Code, Codex, and OpenClaw plugins honor it identically), and the wrong-repo pain is solved by opt-in recall-side fan-out across the existing per-project collections.

The principle this crystallized, extending ADR 0001: mesh parity binds the write side — store bytes, locations, collection naming. The query surface may exceed the mesh, provided memory never becomes readable only through pi-memsearch. pi may be a smarter reader; it must never be a divergent writer.

## Considered options

- **User-global store layer** (as #24 proposed): rejected. Requires pi-only collection naming and capture routing no other mesh agent knows (fractures ADR 0001 parity), introduces cross-repo capture pollution, and duplicates what `MEMSEARCH_DIR` already does. Upstream's own two-scope design (memsearch PR #525, blended multi-scope search) is unmerged and stale since 2026-07 — shipping ahead of it risks reconciling divergent scope semantics later.
- **Do nothing**: markdown as source of truth means `rg` across `*/.memsearch/memory/` covers keyword-grade cross-repo recall today, but memsearch's measured edge over grep-class search is paraphrase queries — exactly the phrasing of a wrong-repo lookup weeks later.

## Consequences

Cross-repo recall must be explicitly opt-in — it never dilutes default project-scoped recall (a ~25-collection fan-out also costs one process start plus query embedding per collection, so it cannot be the default path). Hits are labeled by origin project (recoverable from each hit's `source` path). Implementation uses only public memsearch CLI surface (sequential `search -c <collection>`), so it collapses to a thin wrapper if upstream ships multi-scope search.
