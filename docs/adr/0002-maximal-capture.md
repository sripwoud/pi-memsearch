# Capture is maximal: hard gates only, never a model-side relevance veto

Every exchange that clears three mechanical gates is distilled into a memory entry. Nothing decides whether an exchange is _worth_ remembering — not the distillation model, not a heuristic, not the user. The gates exist to drop exchanges with no content to distill, not to filter for significance.

Concretely:

- **The gates are mechanical and total**: the exchange must contain a user message, must contain at least one assistant text block that is non-empty after trimming, and its last assistant message must not have stopped as `aborted`. Aborted runs and pure command invocations produce no entry because there is nothing to summarize, not because they were judged unimportant.
- **The distillation prompt has no escape hatch**: it asks for 2–10 bullets and offers no way to return nothing. A model told it may skip unremarkable exchanges will skip them, and "unremarkable" is decided without knowing what will be asked in six weeks.
- **Failure is recorded, never dropped**: a distillation that times out (30s default) or errors still appends an entry carrying the diagnostic marker and the intact session anchor. A flaky LLM call degrades an entry's content; it never removes the exchange from the record.
- **Cost is controlled by model choice, not by capturing less**: distillation defaults to a cheap fast model, overridable via `PI_MEMSEARCH_CAPTURE_MODEL`. The lever for spend is which model reads the exchange, never whether the exchange is read.
- **The only veto is the user's, and it is all-or-nothing**: `PI_MEMSEARCH_CAPTURE=off` disables capture entirely. There is no per-exchange opt-out, because a per-exchange decision is the judgment call this ADR refuses to make.

The cost is real and accepted: daily memory files accumulate entries for exchanges that turn out to be worthless, every captured exchange spends distillation tokens, and recall must rank against a noisier corpus.

Considered alternative: ask the model whether an exchange is worth remembering, and skip it when not. This reads as the obvious economy, but the error is asymmetric in a way the economy hides. A false positive costs a few tokens and one noisy line in a daily file, both of which search ranking absorbs. A false negative is unrecoverable — once the session moves on, the exchange is gone from the store, and nothing in the system reports what was declined, so the loss is invisible until someone searches for it and finds nothing. A relevance filter also fails hardest exactly where memory earns its keep: it drops what has no _visible_ future use, which is the same class of question recall exists to answer.

Reversing this is cheap forward and impossible backward. Adding a veto later is a prompt change; the memory captured under this policy stays useful. Removing this policy retroactively cannot recover exchanges that were never written. Prefer the direction that keeps the data.
