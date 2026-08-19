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

**Repository directory**:
The working directory every memsearch child process runs at — the git root of the session's directory, else that directory — so a project `.memsearch.toml` layers as it would for a CLI run at the repo root. Coincides with the project scope except when `$MEMSEARCH_DIR` is set; even then children run here, and only the collection follows the override.
_Avoid_: repo root, git root, project directory, project root

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

**Redaction**:
Destructive removal of one whole memory entry from the memory store and, via reindex, its chunks from the collection. No copy survives anywhere in pi-memsearch — no recovery record, no audit log. Session transcripts and git history are outside the guarantee.
_Avoid_: delete (generic), forget (the tool name, not the concept)

**Context compaction**:
pi shrinking a session's live conversation when its context window fills (the `session_compact` event). A stable-snapshot refresh checkpoint; touches nothing in the memory store.
_Avoid_: compaction (unqualified), compact

**Memory compaction**:
memsearch's `compact` maintenance pass: an LLM condenses the memory store and appends the result to today's daily memory file, which is then re-indexed.
_Avoid_: compaction (unqualified), compact

**Stable snapshot**:
The byte-stable block of instructions plus recent memory injected into the model's context, refreshed only at checkpoints so prefix caches survive across turns.
_Avoid_: auto-context (that is the per-prompt feature, not this)

**Auto-context**:
Opt-in per-prompt semantic injection of search results into the model's context, served by a per-session warm sidecar within a hard latency budget. Complements the recall tools and the stable snapshot; never part of either.

**Sidecar**:
The per-session child process that holds the embedding model warm and serves auto-context searches over stdio, borrowing the Milvus lock per prompt instead of holding it.

**Cross-repo recall**:
Opt-in recall escalation that searches other projects' collections when project-scoped recall misses, labeling hits by origin project. Read-side only — never a second store.
_Avoid_: global memory, global search

**Procedural memory**:
The layer of remembered work expressed as reusable skills, beside the episodic daily memory files. Lives as skill candidates until a human installs one.

**Skill candidate**:
A drafted skill in memsearch's git-tracked `.memsearch/skill-candidates/` store. Evolves under version control; installing it into an agent's skill directory is always a deliberate human step, never automatic.

**Skill drafting**:
Turning remembered work into a skill candidate. In pi this is done by the session agent itself — no LLM sub-process is involved.
_Avoid_: distillation (reserved for the LLM step of capture), skill distillation (memsearch's name for its background pass, which pi cannot run)
