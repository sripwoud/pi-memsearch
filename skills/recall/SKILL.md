---
name: recall
description: Recall past decisions, fixes, and context from the shared project memory store. Use when the user asks about earlier work ("what did we decide about X", "how did we fix Y", "have we seen this before"), when a question likely predates this session, when the stable snapshot surfaces a relevant memory entry but lacks detail, or when a memory may live in another project (cross-repo recall). Searches scored chunks, expands the best hits, and as a last resort reads the origin session transcript.
---

# Recall

Answer from the project memory store through progressive disclosure: search chunks (L1), expand sections (L2), read the origin transcript (L3). Stop at the shallowest layer that answers the question; each deeper layer costs more context.

## L1 — search chunks

Call `memory_search` with the question in natural phrasing. Each hit carries a relevance score, a `chunk_hash`, its source as `file:start-end`, and the chunk text.

- Answer directly from the hits when they already settle the question.
- When nothing relevant comes back, retry once with a paraphrase (different wording, same meaning) before concluding memory has nothing.

### Cross-repo escalation

Only after the project-scoped search and its paraphrase retry both miss — or when the user explicitly asks to search all projects — call `memory_search` again with `scope: "all"`. It fans out across every project under `PI_MEMSEARCH_SCAN_ROOTS`, labels each hit with its origin project path, and reports how many projects were searched and skipped. When it fails because the variable is unset, relay that message instead of retrying. Never escalate while project-scoped hits already answer the question.

## L2 — expand a section

When a hit looks relevant but truncated, call `memory_expand` with its `chunk_hash`. It returns the full memory-file section and, when the entry was captured from a session, its session anchor: origin session id, entry id, and transcript path. For a cross-repo hit, also pass its origin project path as `project` so expansion reaches the right collection; the returned anchor makes L3 work across projects too.

## L3 — read the origin transcript (last resort)

Only when the expanded section still leaves the question open and carries a session anchor. Call `memory_transcript` with the anchor's transcript path as `transcript_path` and its entry id as `turn`: it renders the conversation around that exchange (`context` turns each side, default 3) and follows the branch the memory anchors to, even when the session forked later. Omit `turn` to read the tail of the session's live branch (`limit` turns, default 20). It is a pure file read, so it works even when the memory backend is unavailable.

Fallback, only if the tool is missing: transcripts are line-delimited JSON whose entries form a tree via `id` (8-char hex) and `parentId` — grep for the anchor's entry id and walk `parentId` links back for the conversation that led to it.

## Answering

- Ground every claim in what was recalled and cite its memory file (the date is the filename).
- When recall finds nothing relevant, say so plainly; never invent a memory.
- When the tools report the memory backend unavailable, relay their install instructions instead of retrying.
