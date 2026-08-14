---
name: recall
description: Recall past decisions, fixes, and context from the shared project memory store. Use when the user asks about earlier work ("what did we decide about X", "how did we fix Y", "have we seen this before"), when a question likely predates this session, or when the stable snapshot surfaces a relevant memory entry but lacks detail. Searches scored chunks, expands the best hits, and as a last resort reads the origin session transcript.
---

# Recall

Answer from the project memory store through progressive disclosure: search chunks (L1), expand sections (L2), read the origin transcript (L3). Stop at the shallowest layer that answers the question; each deeper layer costs more context.

## L1 — search chunks

Call `memory_search` with the question in natural phrasing. Each hit carries a relevance score, a `chunk_hash`, its source as `file:start-end`, and the chunk text.

- Answer directly from the hits when they already settle the question.
- When nothing relevant comes back, retry once with a paraphrase (different wording, same meaning) before concluding memory has nothing.

## L2 — expand a section

When a hit looks relevant but truncated, call `memory_expand` with its `chunk_hash`. It returns the full memory-file section and, when the entry was captured from a session, its session anchor: origin session id, entry id, and transcript path.

## L3 — read the origin transcript (last resort)

Only when the expanded section still leaves the question open and carries a session anchor. pi transcripts are line-delimited JSON: a session header line first, then one entry object per line. Entries form a tree via `id` (8-char hex) and `parentId`; the conversation as it happened is the parent-chain walk from an entry back to the root — raw line order interleaves abandoned branches.

1. Find the line whose `"id"` equals the anchor's entry id (grep the file; never read it whole).
2. Walk `parentId` links backwards from that entry for the conversation that led to it.
3. For what followed, scan later lines whose `parentId` chains pass through the anchored entry — the active branch is the parent-chain walk from the leaf, so descendants continue the exchange.

## Answering

- Ground every claim in what was recalled and cite its memory file (the date is the filename).
- When recall finds nothing relevant, say so plainly; never invent a memory.
- When the tools report the memory backend unavailable, relay their install instructions instead of retrying.
