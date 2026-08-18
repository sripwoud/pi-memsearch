# L3 transcript recall as a local tool: encapsulate the tree walk, keep the anchor address

Recall's third layer — reading the origin transcript behind a session anchor — was prose in the recall skill: grep the JSONL for the anchored entry, walk `parentId` links by hand. That put the least-forgiving step of the ladder (a tree walk over pi's session format, where raw line order interleaves abandoned branches) on the model's instruction-following and on read/grep tools being available at all. Prior art confirmed the fragility: the competing upstream plugin ([zilliztech/memsearch#650](https://github.com/zilliztech/memsearch/pull/650)) shipped the same walk as a tool and still got it half wrong — its parent-only walk means the "turns after the target" half of its context window is unreachable. The decision: a `memory_transcript` tool, in-process TypeScript, tested in the existing harness.

Concretely:

- **Anchor-addressed, backend-free.** Parameters are the anchor's own parts — `transcript_path`, optional `turn` (entry id, unique prefix accepted), `context` (turns around the target, default 3), `limit` (tail turns when no target, default 20). L3 is only reachable through L2, which already handed the model the anchor, so the tool never calls memsearch: it is a pure file read that keeps working when uv or the backend is missing, matching the degradation story everywhere else.
- **The walk, both directions.** Root → target via the `parentId` chain; past the target, continue along the file's live leaf when its parent chain passes through the target, else along the most recent leaf within the target's subtree — a `/fork` after the captured exchange must not amputate the continuation the memory anchors to. Deterministic, recency-tied, testable.
- **Recall output, not capture.** Per-turn text capped (~2000 chars), tool calls rendered as one-liners (`name(arg=val…)`), thinking and images dropped, tool results folded away. Maximal capture (ADR 0002) governs what is written; L3 is read-side, where context economy rules. Anyone needing raw tool results still has the transcript path.
- **Fail fast, no fuzzy matching.** Unknown transcript path, unknown or ambiguous turn prefix: an error naming what was looked for — the same contract as `memory_forget`'s addressing.
- **The recall skill's L3 section becomes tool usage** plus one fallback line for the manual walk, so the model is never offered two competing paths.

This does not contradict the `memory_read` rejection (surface without depth): a daily-file read composes from `memory_status` plus pi's file tools in one obvious step, while the branch walk is subtle enough that the one prior implementation shipped broken.

Considered alternatives:

- **Skill-only status quo**: rejected — L3 correctness rested on the model re-deriving a tree algorithm per use, and on file tools being present.
- **`chunk_hash` addressing**: rejected — it re-couples L3 to backend availability and pays an expand round-trip for an anchor the ladder already surfaced.
- **Bundled python script** (upstream plugin's shape): rejected — adds a `python3` runtime dependency and an untestable seam; in-process TS slots into the unit harness.
- **Wait for the upstream adapter**: rejected as a blocker, kept as the endgame — [#27](https://github.com/sripwoud/pi-memsearch/issues/27) stands: when `memsearch transcript` grows a pi adapter, the local parser becomes a thin call behind an unchanged tool interface.
