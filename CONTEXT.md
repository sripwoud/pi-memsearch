# pi-memsearch

memsearch-backed long-term memory for pi: a pi package that lets pi write to and recall from the same per-project memory that other coding agents (Claude Code, Codex, OpenClaw, OpenCode) share through memsearch.

## Language

**Memory store**:
The `.memsearch/memory/` directory of a project — plain markdown, the source of truth for everything remembered.
_Avoid_: memory bank, knowledge base

**Daily memory file**:
The one markdown file per calendar day (local date) in the memory store, which every agent's sessions append to.

**Exchange**:
One user prompt through to the fully settled agent response. The unit of capture. pi's own "turn" (one LLM call plus its tool executions) is narrower — an exchange spans many pi turns.
_Avoid_: turn (ambiguous between pi's and memsearch's senses)

**Memory entry**:
The captured record of one exchange in a daily memory file: a timestamp heading, a session anchor, and third-person bullets.

**Session anchor**:
The HTML comment on a memory entry linking it back to its origin: session ID, entry ID, and transcript path. What makes L3 recall possible.
_Avoid_: anchor comment, transcript link

**Mesh**:
The set of agents sharing one project's memory store and index through identical memsearch conventions. Parity with the mesh outranks pi-local design preferences.

**Project scope**:
The directory identity that keys a project's memory and collection: `$MEMSEARCH_DIR` if set, else git root, else cwd — memsearch's own resolution order, mirrored exactly.

**Collection**:
The per-project vector index derived from the memory store, named `ms_<name>_<hash>` by memsearch's derivation. Rebuildable at any time; never the source of truth.
_Avoid_: database, index (when the derived Milvus collection is meant)

**Capture**:
Producing memory entries from live session activity, by any write path.

**Distillation**:
The LLM step of capture: compressing one exchange into third-person bullet summaries.
_Avoid_: summarization (in code and docs, to keep it distinct from memsearch's own `summarize` command)

**Recall**:
Reading memory back through progressive disclosure: search returns chunks (L1), expand returns the full section (L2), the original transcript is the last resort (L3).
_Avoid_: retrieval

**Stable snapshot**:
The byte-stable block of instructions plus recent memory injected into the model's context, refreshed only at checkpoints so prefix caches survive across turns.
_Avoid_: auto-context (that is the deferred per-turn feature, not this)

**Auto-context**:
Per-turn semantic injection of search results into the model's context. Deferred beyond v1; not part of the stable snapshot.
