# Writing a store command

`PI_MEMSEARCH_STORE_CMD` hands store resolution to a command you own, so pi can join a memory store that lives outside the repos — one central store keyed per repository, say, shared with the other agents in the mesh. Unset, pi resolves everything itself and none of this applies.

Why the seam exists, and what was rejected: [ADR 0007](adr/0007-delegated-store-resolution.md). What pi does with the answers: [`runtime.md`](runtime.md).

## The contract

One command, one argument, no flags. It runs with the working directory set to the directory being resolved, so it needs no arguments beyond the mode.

| Mode         | Prints                                      | Required |
| ------------ | ------------------------------------------- | -------- |
| `memory-dir` | Absolute path of the memory store directory | yes      |
| `collection` | Collection name for that store              | yes      |
| `state-dir`  | Absolute path of the index-state directory  | no       |

## The four rules that are easy to get wrong

**Decline by succeeding, not by failing.** `state-dir` is optional, but "optional" means **exit 0 printing nothing**. A non-zero exit is fatal for every mode, including this one. The natural defensive `case` arm —

```sh
*) echo "unknown mode: $MODE" >&2; exit 1 ;;
```

— breaks pi the first time it probes a mode your script predates. Make the catch-all `exit 0`. pi still fails loudly on the required modes, because empty output is an error for those.

**Answer for the directory you are standing in.** Cross-repo fan-out asks about each discovered project, running the command inside that project's _store_ directory rather than a checkout. Derive from the working directory, never from a variable captured elsewhere.

**Absolute paths only.** A relative `memory-dir` or `state-dir` is rejected rather than resolved against something.

**You are called once per directory, per mode, per process.** Answers are memoized for the life of the pi process, so the command may be slow-ish, but it must be deterministic — the same directory has to produce the same answer for the whole session.

## Reference

Mechanism only. The two `*_ROOT` lines are the policy, and the only lines you are meant to change.

```sh
#!/usr/bin/env bash
# Usage: resolver.sh memory-dir|collection|state-dir
set -euo pipefail

MODE="${1:-}"

# Policy — the only lines you are meant to change.
STORE_ROOT="${STORE_ROOT:-$HOME/memories}"
STATE_ROOT="${STATE_ROOT:-$HOME/.local/share/memsearch/state}"

# memsearch ships this with every plugin shell. Call it rather than reimplementing
# the derivation: a second copy drifts, and a drifted collection name is a silo.
DERIVE_COLLECTION="${DERIVE_COLLECTION:?point DERIVE_COLLECTION at the derive-collection.sh shipped with memsearch}"

# Key on the primary checkout so linked worktrees share one store, not one each.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$common_dir" ]; then
  key="$(dirname "$common_dir")"
  memory_dir="$STORE_ROOT/$(basename "$key")"
else
  memory_dir="$STORE_ROOT/$(uname -n)"
  key="$memory_dir"
fi

case "$MODE" in
memory-dir) printf '%s\n' "$memory_dir" ;;
collection) "$DERIVE_COLLECTION" "$key" ;;
state-dir) printf '%s\n' "$STATE_ROOT/$("$DERIVE_COLLECTION" "$key")" ;;
*) exit 0 ;;
esac
```

Keying on `--git-common-dir` is what makes every linked worktree share one corpus. Note this is a deliberate divergence from the stock plugin shells, which key on `--show-toplevel` and therefore give each worktree its own collection — so a resolver doing this must be the resolver _every_ agent on the machine uses, or the two halves silo again. That is the whole failure this seam exists to close.

## Verifying

Run it by hand before exporting anything. All three checks matter:

```sh
cd <a repo>            && resolver.sh memory-dir && resolver.sh collection && resolver.sh state-dir
cd <a linked worktree> && resolver.sh memory-dir   # must match the primary above
cd /tmp                && resolver.sh memory-dir   # non-git fallback
resolver.sh some-future-mode; echo "exit=$?"       # must print nothing and exit 0
```

Then `memory_status` names the store, the collection and the index-state path it actually read, which is the fastest way to see which side of the seam is live.

## If the store is not named `memory`

Everything works except `memory_compact`, which refuses rather than writing a summary outside the store it summarizes. See the compaction section of [`runtime.md`](runtime.md) and [#92](https://github.com/sripwoud/pi-memsearch/issues/92).
