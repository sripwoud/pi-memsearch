# memory_restore and the forget audit trail

Redaction has no undo and no audit log. `memory_forget` destroys; nothing restores.

## Why this is out of scope

Restore requires keeping the removed bytes somewhere (pi-memory kept recovery JSON before every forget). Content that survives somewhere is not redacted — and the motivating case for forget is a captured secret, where the guarantee is only real when the bytes are gone. The two requests in the original issue ("redaction" and "restore with an audit trail") are mutually exclusive for the same operation; redaction won (ADR 0004).

Undo belongs to layers that already own history: git, when the store is committed (the README's documented sharing mode), and the session transcript (L3), which is pi's record, not the memory store's. A content-free audit log would make pi-memsearch own a second, operational store to answer "what was ever redacted?" — a question with no demonstrated need. The forget tool result echoes the removed entry (the in-session record); git log is the durable one.

## Prior requests

- [#25](https://github.com/sripwoud/pi-memsearch/issues/25) — "add scratchpad, memory_forget, memory_restore and memory_read tools"
