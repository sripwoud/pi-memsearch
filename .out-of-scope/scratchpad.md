# Scratchpad

pi-memsearch has no scratchpad tool — no intra-session notes surface beside the memory store.

## Why this is out of scope

Maximal capture (ADR 0002) already records every exchange to the daily memory file, so a notes tool duplicates capture for anything said in-session. The differentiating requirement — notes that _never_ index — cannot hold inside `.memsearch/memory/`: every mesh agent's indexer sweeps the store, so pi cannot make "provably never indexed" true there. The tool would need a second, pi-only location, which is exactly the divergent store shape ADR 0001/0003 rule out.

The pi-memory precedent is also misleading: its scratchpad's load-bearing role was the compaction handoff (open items re-injected after `session_before_compact`), not note-taking. pi-memsearch already refreshes the stable snapshot on `session_compact`, and no concrete handoff gap has been demonstrated. If one materializes, that is its own feature with its own name (handoff state), not a notes pad.

## Prior requests

- [#25](https://github.com/sripwoud/pi-memsearch/issues/25) — "add scratchpad, memory_forget, memory_restore and memory_read tools"
