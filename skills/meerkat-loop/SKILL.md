---
name: meerkat-loop
description: The host-external scheduler for a Meerkat TaskPanel board. Runs a 60-second liveness ping and a 10-minute continue turn that wakes the host to run the notify-only SLA patrol, the board's review workflow, and the atomic claim-and-wake poll. Installs launchd / systemd / cron units and the per-host wake glue for claude, codex, pi, opencode and cursor; OpenClaw is excluded.
---

# Meerkat Loop

The loop runs when no agent is looking. Its scheduler owns two clocks:

| Clock | Cadence | Job |
|---|---|---|
| **ping** | 60s | prune registry entries whose pid is gone. No board read, no claim, no LLM |
| **continue** | 600s | wake the host with a bounded `Continue` prompt; that turn runs the entries below |

The continue turn runs three deterministic passes, in this order:

1. **patrol** — notify-only SLA pass. The board computes the SLA rows; the loop
   de-duplicates them, re-reads a survivor and notifies the leader. It also
   emits the legacy stale-heartbeat alerts and the peer-inspector liveness row,
   whose marker file lives on this host. No alert moves a card, and no LLM turn
   starts by default.
2. **workflow** — the write channel. The **board** computes the plan and the
   **loop** applies it. For a flow-A
   delivery whose `review_required` snapshot is 1, dispatch an independent
   reviewer, apply the reviewer's `VERDICT:` report to the original, and close
   the review card last. A card at 0 is not dispatched: the plan emits
   `auto_accept` and the loop closes the original directly (`loop-auto`).
   On by default; `--workflow=no` disables it.
   The reviewer is `project.reviewer ??` the deployment reviewer
   (`--reviewer` / `MEERKAT_TASKPANEL_REVIEWER` / host config). A `required`
   project with no effective reviewer fails the loop at startup, and
   `agent-only` + `autoAcceptReviews=no` is refused for the same reason.
   `autoAcceptReviews` only controls whether the loop closes a **review card**;
   it does not gate auto-accepting a no-review original.
3. **poll** — scan, atomically claim, wake one worker. Runs last so a review
   card dispatched in this turn can be claimed immediately.

The exact `taskctl` invocations and the JSON keys each pass reads are the board
skill's capability contract: `meerkat-taskpanel`, `references/capabilities.md`.
This skill records only the decisions — when to patrol, dispatch, claim, wake or
notify.

### Who may close

The board's acceptance policy is authoritative and arrives in the plan.
`--acceptance` / `MEERKAT_TASKPANEL_ACCEPTANCE_POLICY` is an advisory local copy,
printed at startup for diagnostics only.

| policy | top-level original | child card | review card |
|---|---|---|---|
| `human-only` | **hold** — record the verdict, close the review card, leave the card `in_review` | close | close |
| `both` (default) | close | close | close |
| `agent-only` | close | close | close |

A review card is closed by the loop (`taskd`) or a human under `human-only` /
`both`; under `agent-only` a human cannot close one, because the board's review
scope allows only a non-human writer. A **no-review** top-level card under
`human-only` is left for the human (`auto_accept_skipped`, reason `human_only`);
a child is auto-accepted in every policy. The board skill's
`references/review-workflow.md` is the semantic authority for the review card,
the two rounds and the policy matrix; this skill describes **when** the loop
dispatches and **how** it executes the plan.

A held approval is idempotent: `review_verdict=approve` +
`review_verdict_round` means a second pass rewrites neither the comment nor the
marker. A worker always stops at `in_review`; review cards are never held.

### Event subscriber (optional)

On launchd/systemd, `--subscribe` follows the board's event stream through
`taskctl events tail` and asks for a continue turn when a dispatch-relevant event
arrives. The loop carries no HTTP code of its own: board discovery, the token and
the stream all belong to the CLI. The continue clock remains the fallback and the
only path for time-based work. Cron cannot host a long-lived process.

## Required board interface

```text
requires: board task-interface v1   — board release >= 1.1.0
```

The loop drives the board only through `taskctl` — the capability subset is the
board skill's `references/capabilities.md` (including `events tail` for the live
stream; the loop never calls the HTTP API). `task-interface v1` first shipped in
board 1.0.0; the board-side workflow plan landed in 1.1.0.

Gate check before pointing a loop at a board:

```bash
node scripts/board-check.mjs                 # taskctl on PATH
node scripts/board-check.mjs --repo <checkout>
node scripts/board-check.mjs --json          # machine-readable verdict
```

Exit 3 means no verdict: the board could not be asked, or its declared version
is below the floor. The gate does not prove that every command still behaves the
same way; the compatibility table in `references/operation.md` records that
pairing.

## Installing

```bash
bash install.sh --target claude     # or codex, pi, opencode, cursor
bash install.sh --target all        # every host; openclaw gets the board only
```

The installer copies this skill into the host's skill directory, copies the
execution body into `<host>/meerkat-taskpanel/`, renders the units and wake
glue, and prints the one command that loads a unit. Loading is opt-in:
`install.sh --supervisor=enable` (per host with `--supervisor-hosts`; also
`--supervisor=status`, `--supervisor=disable`).

**OpenClaw is deliberately excluded.** `install.sh --target openclaw` installs
the board skill only: the openclaw-team framework already runs an equivalent
supervisor, and installing both would put two supervisors on one board.

## Layout

```text
SKILL.md                  this file
references/operation.md   install paths, flags, workflow rules, compatibility
manifest.txt              the execution body's file list (generated)
scripts/board-check.mjs   the interface gate (authored)
scripts/supervisor.mjs    the scheduler (generated)
scripts/wake-cwd.mjs      the wake glue's resolver (generated)
scripts/loop/*.mjs        the passes, subscriber and their seams (generated)
scripts/foundation/**     modules the execution body imports (generated)
templates/                units, wake glue, host config (generated)
```

Everything except `SKILL.md`, `references/` and `scripts/board-check.mjs` is
generated by `node scripts/sync-skills.mjs` in the repository this skill is built
from. Do not hand-edit it: edit `scripts/supervisor.mjs`, `scripts/loop/`,
`scripts/wake-cwd.mjs`, `src/foundation/` or `scripts/install/templates/`, then
regenerate. The foundation copy under `scripts/foundation/` is byte-for-byte the
repository's `src/foundation/`; the entry scripts are copied with only their
foundation import specifiers rewritten to point at `./foundation/`.
