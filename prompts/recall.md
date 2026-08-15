---
description: Recall past decisions, fixes, and context from the shared project memory
argument-hint: [--all] <query>
---

Use the recall skill: read its SKILL.md if not already loaded, then follow its progressive-disclosure workflow to answer the query below from the project memory store. Report honestly when memory holds nothing relevant.

A leading `--all` widens recall across every project under `PI_MEMSEARCH_SCAN_ROOTS`: strip the flag and call `memory_search` with `scope: "all"` from the start.

Query: $@
