# memory_read

No tool wraps a plain read of a daily memory file.

## Why this is out of scope

Composition already covers it: `memory_status` prints the project scope (the store path), day files are date-keyed (`YYYY-MM-DD.md`), and pi's built-in file reading does the rest. Semantic lookups belong to recall (search → expand → transcript). A tool that adds only path convenience over an existing read primitive is surface without depth.

## Prior requests

- [#25](https://github.com/sripwoud/pi-memsearch/issues/25) — "add scratchpad, memory_forget, memory_restore and memory_read tools"
