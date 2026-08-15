# Redaction over recovery: memory_forget destroys, nothing restores

[Issue #25](https://github.com/sripwoud/pi-memsearch/issues/25) proposed forget/restore with an audit trail, ported from pi-memory (recovery record written before every mutation, idempotent restore). We ship `memory_forget` alone, with true-redaction semantics: the entry leaves the day file, its chunks leave the collection on reindex, and no copy of the removed content is written anywhere — no recovery record, no audit log, no tombstone.

Concretely:

- **Forget removes exactly one whole memory entry** (timestamp heading, session anchor, bullets), addressed exactly — by `chunk_hash` or by `(date, time)`. No substring matching: pi-memory's fuzzy match is why it needed recovery records; exact addressing removes the over-match risk instead of insuring against it.
- **The tool result echoes the removed entry** — the in-session record. Salvageable facts re-enter via `memory_write`.
- **Forget triggers a reindex and a snapshot refresh**, so redacted content leaves both the collection and the injected context, not just the file.
- **Undo is not pi-memsearch's job.** Git history covers it when the store is committed; a gitignored store has no undo — the deal the user opted into by keeping memory personal.
- **The guarantee is scoped to store + collection.** Session transcripts (L3) and git history survive; other mesh agents may re-capture the fact in later sessions.

The trade-off inverts ADR 0002's asymmetry deliberately. There, capture keeps everything because a false negative is unrecoverable and invisible. Here, forget destroys because recovery negates the guarantee: the motivating case is a captured secret, and bytes that survive in a recovery record are not redacted. When "undoable" and "gone" cannot both hold, the tool does what its name promises.

Considered alternatives:

- **Port pi-memory's model** (recovery records + `memory_restore` + audit trail): rejected — see `.out-of-scope/memory-restore.md`. Correction-grade mistakes are already cheap without it: the store is plain markdown, a hand edit self-heals the index through incremental reindexing.
- **Dual semantics** (forget defaults to correction, a purge flag destroys): two guarantees behind one tool name, more surface, and the soft default would be the one reached for by mistake in the case that matters.
- **Upstream redaction in memsearch**: no upstream feature is needed — incremental indexing already deletes stale chunk IDs when file content changes, and the mutated store remains ordinary mesh markdown. Per ADR 0003, pi may be a smarter reader but never a divergent writer; this write is not divergent.
