# memsearch (bge-m3) vs qmd (pi-memory) — search-accuracy benchmark

_Run: 2026-08-13 UTC, two rounds. This is the evidence behind the README's 32/35-vs-26/35 claim and the decision to build pi-memsearch._

Per-query transcripts reference private corpus content (work repositories, personal infrastructure) and are not published. Everything decision-relevant — protocol, decision rule, totals, breakdowns, arbitration rulings — is transcribed here from them.

## Contenders

|              | memsearch 0.4.16                      | qmd 2.5.3                                                                                                                                    |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding    | `gpahal/bge-m3-onnx-int8` (ONNX, CPU) | `embeddinggemma-300M-Q8_0` (llama.cpp, CPU)                                                                                                  |
| Reranker     | none (default disabled)               | hybrid mode: `Qwen3-Reranker-0.6B-Q8` + `qmd-query-expansion-1.7B`                                                                           |
| Modes tested | vector (only mode)                    | `search` (BM25), `vsearch` (vector), `query` (hybrid: expansion + RRF + rerank), `query --no-rerank` (**rrf**: BM25 + vector fusion, no LLM) |
| Index        | Milvus Lite 3.x, 13,929 chunks        | SQLite, 5,548 chunks                                                                                                                         |

## Corpus and queries

Identical corpus for both systems, indexed the same day: 223 markdown files of agent-session memory across four private repositories — a session archive (70 files), a Solidity contracts repo (72), a homelab/infra repo (62), and a dotfiles repo (19).

35 queries in two rounds, top-3 scored:

- **Round 1 (Q1–17)**: 12 queries reused from an April 2026 comparison plus 5 fresh paraphrased ones.
- **Round 2 (Q18–35)**: stratified sample — topics drawn by deterministic every-Nth-file sampling across the four corpora, round-1 topics excluded, 6 queries per style (short keyword / paraphrase / natural question). Ground truth was sampled by a read-only agent and all queries were written **before any search ran** (blind ground truth).

**Decision rule, agreed upfront**: memsearch wins at a margin of ≥6 strong hits over qmd's best single mode, else adopt pi-memory.

## Scoring

Strong hit = a top-3 result clearly referring to the expected session/topic, verified by resolving candidate chunks to their session headers in the source files. Ambiguous cases went to human arbitration (log below).

## Results

| Metric                  | memsearch | qmd BM25 | qmd vector | qmd hybrid | qmd rrf |
| ----------------------- | --------- | -------- | ---------- | ---------- | ------- |
| Strong hits /35         | **32**    | 15       | 23         | 25         | **26**  |
| Best-rank (r1/r2/r3)    | 28/4/0    | 12/2/1   | 13/9/1     | 14/4/7     | 15/7/4  |
| Median latency          | 3.4–3.9 s | 0.2 s    | 6.2–6.7 s  | 15–24 s    | 1.7 s   |
| Zero-result queries /35 | 0         | **8**    | 0          | 0          | 0       |

Sub-totals:

| Set                                 | memsearch | BM25 | vector | hybrid | rrf   |
| ----------------------------------- | --------- | ---- | ------ | ------ | ----- |
| Q1–12 (April set, keyword-flavored) | 10/12     | 8/12 | 10/12  | 8/12   | 8/12  |
| Q13–17 (fresh, paraphrased)         | 5/5       | 0/5  | 3/5    | 2/5    | 3/5   |
| Q18–35 (stratified)                 | 17/18     | 7/18 | 10/18  | 15/18  | 15/18 |

Round-2 style breakdown (6 queries each):

| Style      | memsearch | BM25 | vector | hybrid | rrf |
| ---------- | --------- | ---- | ------ | ------ | --- |
| keyword    | 6/6       | 4/6  | 3/6    | 6/6    | 6/6 |
| paraphrase | 5/6       | 2/6  | 3/6    | 4/6    | 4/6 |
| question   | 6/6       | 1/6  | 4/6    | 5/6    | 5/6 |

The pattern held across both rounds: near-parity on keyword-style queries, memsearch pulls away on reworded intent (paraphrase and question styles). memsearch missed 3 of 35; one of those (an acronym absent from the corpus as a literal token) was missed by every mode.

## Human arbitration log

All ambiguous top-3 results were resolved by the user on 2026-08-13, before totals were computed:

| Call | Question                                                                                       | Ruling     | Effect                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| Q8   | Does a chunk from the planning session that contains the queried step count as "this session"? | Hit        | memsearch +1                                                                                   |
| Q3   | Does a chunk about the same artifact from a different session count?                           | Hit        | qmd vector +1                                                                                  |
| Q16  | Does an earlier session on the same script count for a query about its later rewrite?          | Miss       | qmd hybrid/rrf unchanged — the deciding call: a hit here would have meant margin 5 → pi-memory |
| Q20  | Do adjacent sessions of the same feature (design discussion, later follow-up) count?           | Both count | memsearch, hybrid, rrf each +1 (margin-neutral)                                                |

## Verdict

qmd's best single mode = **rrf** (26/35). **memsearch 32 − qmd-rrf 26 = margin 6 → threshold met → build pi-memsearch.**

## Latency and ergonomics (reported, not part of the verdict)

- memsearch ~3.4–3.9 s/call = uvx startup + ONNX model load on every invocation; representative of what pi glue pays per call.
- qmd rrf: 1.7 s flat, no LLM. If pi-memory is ever revisited, rrf — not its default hybrid — is the mode worth using.
- qmd hybrid (the LLM path): 15–24 s median, 61 s max; accuracy ≤ rrf in both rounds — expansion + rerank never beat plain fusion on this corpus.
- qmd BM25: 0.2 s, but returned literally nothing on 8/35 queries — silent-empty is the worst failure mode for a memory tool.

## Method caveats

- Chunking differs: memsearch produced 13,929 chunks vs qmd's 5,548 over the same 223 files.
- Both systems were warmed with throwaway queries (excluded). All 68 round-1 timed calls succeeded; round-1 had two latency outliers under background CPU load, round 2 ran on an idle machine.
- The memsearch index was freshly rebuilt from source the same day (Milvus Lite 2.x→3.x migration); corpus freshness was verified in both systems before round 1.
- Milvus Lite is single-client — back-to-back memsearch invocations can transiently fail to open the DB. The benchmark runner had retries (0 triggered across 70 timed calls), but pi-memsearch's glue must handle it.
