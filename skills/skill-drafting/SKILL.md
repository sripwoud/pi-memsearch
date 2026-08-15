---
name: skill-drafting
description: Turn remembered work into reusable skills via memsearch's skill-candidate store. Use when the user asks to turn this into a skill, make/extract a skill from what we just did, review skill candidates, install a skill candidate, or mine history for recurring workflows. Manages memsearch's skill candidates under .memsearch/skill-candidates/, not pi's own skills system.
---

# Skill drafting

You manage memsearch's **procedural memory**: remembered work expressed as reusable skills, beside the episodic daily memory files. This manages memsearch's skill candidates, not pi's own skills system. memsearch's background pass (`skills distill`) is unavailable under pi — it needs a memsearch-configured API provider and an upstream `plugins.pi.*` platform that does not exist — so drafting is always done by you, the session agent, in the ways below.

Stages: **0** daily memory files → **1** skill candidate (`.memsearch/skill-candidates/`, a git-tracked store that keeps evolving) → **2** installed (a pi skills directory). Candidates are never installed automatically; installing is always a deliberate human step. A request may stop at drafting or review, or continue to installation in the same exchange after explicit approval — match the requested stage.

Invoke memsearch exactly as the extension does, through the pinned spec: `uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch …`.

## Intent routing

- "make/turn this into a skill", "from what we just did" → **A. Capture now**
- "what candidates are there", "review candidates", "install X" → **B. Review & install**
- "mine my history", "find recurring workflows" → **C. Mine history**
- Unclear or empty → run **B**'s `list`; if empty, offer A or C.

## A. Capture now (0→1)

You already have the context, so draft the skill body yourself: markdown without frontmatter, imperative numbered steps for the recurring task, concrete commands and paths, no secrets, self-contained.

**Be exact — do not guess.** You have the live session, so use the real commands, paths, and output, not approximations. If a detail is uncertain, verify it (re-read the relevant files or transcript) or keep that step general — a wrong command is worse than a vague one. Then persist it as a candidate:

```bash
uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch skills add \
  --name "<short-slug>" \
  --description "<what it does AND when it triggers — lead with the verbs a user types>" \
  --body-file - <<'EOF'
## <title>

1. ...
2. ...
EOF
```

`skills add` handles slugging, frontmatter, meta.json, and the git commit. Show the result to the user; install only on explicit approval (see **B**).

## B. Review & install (1→2)

```bash
uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch skills status   # candidate versions pending install
uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch skills list     # add -j for sources and installed paths
git -C .memsearch/skill-candidates log --oneline -5 2>/dev/null || true
```

`skills status` compares each candidate's `SKILL.md` content hash with the hash recorded by the last install — it does not inspect live skill directories. A pending installed skill means the candidate evolved after the last deliberate install; reinstall only after review. When showing candidates, cite the store's recent git history when it clarifies whether a candidate is new, evolved, or re-created.

Before recommending or installing, skim the candidate's body: if a step looks uncertain or loosely summarized, re-check it against the source or flag it and let the user decide — installing copies the candidate as-is, so this is the last chance to catch a wrong step.

Installation is an interactive checkpoint: show the candidate, apply requested tweaks first, then confirm the destination with the user. pi has no memsearch config namespace to preconfigure install paths, so always ask, offering:

- `.pi/skills` — project-local (**recommended**): a skill from this project's memory is usually most relevant here
- `~/.pi/agent/skills` — global, for cross-project workflows

```bash
uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch skills install <name> --path <user-approved-path>
```

One candidate can be installed to several directories (`--path` is repeatable in a single call). After installing, remind the user that a fresh pi session is needed to load the skill.

If the list is empty, offer to capture from the current session (**A**) or mine history (**C**).

## C. Mine history (0→1)

Read the recent daily memory files under `.memsearch/memory/*.md` and look for multi-step procedures that recur across sessions. Draft only procedures that recur and generalize — not one-offs from a single day — and persist each with `skills add`, one call per skill, as in **A**.

**Drill into the original before drafting.** Memory-entry bullets are a lossy summary; the exact commands, flags, and paths live in the origin transcript named by each entry's session anchor. Anchors written by other mesh agents (Claude Code, Codex, OpenClaw) resolve with:

```bash
uvx --from 'memsearch[onnx]>=0.4.17,<0.5' memsearch transcript <file> --turn <id>
```

pi transcripts are not a format that command recognizes (it exits 3) — read the JSONL directly and walk the parent chain, as the recall skill documents: find the line whose `id` matches the anchor's entry id, walk `parentId` links back for the conversation that led there, and scan later lines whose chains pass through it for what followed. If you cannot confirm a detail, keep the step general or omit it — never fabricate.

## Guardrails

- Never install a candidate, enable anything, or write anything outside the candidate store, without the user's explicit go-ahead.
- Never hand-edit `.memsearch/skill-candidates/`; `skills add` is the only write path, and the git-tracked store keeps the history.
