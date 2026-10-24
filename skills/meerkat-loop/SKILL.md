---
name: meerkat-loop
description: The external scheduler for a Meerkat TaskPanel board. Runs a 60-second liveness ping, a 10-minute continue turn, and a resident session pool that holds one control conversation plus one project session per target directory. The continue turn runs the notify-only SLA patrol, the board's review workflow, and the poll that claims a card and enqueues its handoff; the project session spawns the worker/reviewer subagent in the project directory. Installs launchd / systemd / cron units and the per-agent-kind wake glue for claude, codex, pi, opencode and cursor; OpenClaw is excluded.
disable-model-invocation: true
---

# Meerkat Loop

The loop runs when no agent is looking. Its scheduler owns two clocks and — in its
default resident shape — a long-lived **session pool**:

| Part | Cadence | Job |
|---|---|---|
| **ping** | 60s | prune registry entries whose pid is gone. No board read, no claim, no LLM |
| **continue** | 600s | hand the control session a bounded `/meerkat-loop` continue prompt (or run it one-shot when no pool is live); that turn runs the entries below |
| **session** (`--session`) | long-lived | one control conversation plus one project conversation per target directory; routes each handoff to the project session, which spawns the worker/reviewer subagent in that directory |

A subagent inherits the **launch cwd** of the session that spawns it, so one
board-wide session cannot serve two project directories. That is why the pool keeps
one project session per directory. Without a live pool, poll claims nothing and only
patrol and workflow run — see `references/operation.md` §No resident pool.

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
   (`--reviewer` / `MEERKAT_TASKPANEL_REVIEWER` / agent config). A `required`
   project with no effective reviewer fails the loop at startup, and
   `agent-only` + `autoAcceptReviews=no` is refused for the same reason.
   `autoAcceptReviews` only controls whether the loop closes a **review card**;
   it does not gate auto-accepting a no-review original.
3. **poll** — scan, **export the card brief**, atomically claim, **enqueue the
   handoff**. It never spawns a worker: the resident project session does, as a
   subagent that inherits the project directory. Runs last so a review card
   dispatched in this turn can be claimed immediately. At the concurrency cap,
   with no project directory for the card, or when the brief cannot be written,
   nothing is claimed.

The exact `taskctl` invocations and the JSON keys each pass reads are the board
skill's capability contract: `meerkat-taskpanel`, `references/capabilities.md`.
This skill records only the decisions — when to patrol, dispatch, claim, wake or
notify.

### Invocation

This skill is **command-only**. Its frontmatter sets `disable-model-invocation: true`, so
the model never sees it in its skill list and never loads it from a keyword or description
match; only an explicit invocation runs it:

```text
/meerkat-loop
```

The text after the command is the turn's instruction, not a subcommand. The supervisor's
continue turn passes `/meerkat-loop Continue — …`; the rest of that prompt (the three
passes, with absolute entry paths) is appended as the turn's input. There is no
argument placeholder, no subcommand and no argument parsing.

`install.sh` copies the skill to `<agent-dir>/skills/meerkat-loop/`, so the bare
`/meerkat-loop` resolves there. On an agent kind that does not slash commands, the prefix
stays literal text and the rest of the prompt still carries the work.

### Who may close

The board's acceptance policy is authoritative and arrives in the plan.
`--acceptance` / `MEERKAT_TASKPANEL_ACCEPTANCE_POLICY` is an advisory local copy,
printed at startup for diagnostics only.

<!-- acceptance-matrix:begin -->
| Scope | `human-only` | `both` (default) | `agent-only` |
|---|---|---|---|
| `top_level` | human only | human or `taskd` | any non-human |
| `review` card | human or `taskd` | human or `taskd` | any non-human |
| `child` (has a parent) | any non-human | any non-human | any non-human |
<!-- acceptance-matrix:end -->

In loop terms it closes every card the matrix lets `taskd` close. Under `human-only`
a top-level `APPROVE` is **held** (`approve_hold`): record the verdict, close the
review card, leave the original `in_review`. A **no-review** top-level card under
`human-only` is left for the human (`auto_accept_skipped`, reason `human_only`);
a child is auto-accepted in every policy. Under `agent-only` a human cannot close a
review card, because the board's review scope allows only a non-human writer. The
board skill's `references/review-workflow.md` is the semantic authority for the
review card, the two rounds and the policy matrix; this skill describes **when** the
loop dispatches and **how** it executes the plan.

A held approval is idempotent: `review_verdict=approve` +
`review_verdict_round` means a second pass rewrites neither the comment nor the
marker. A worker always stops at `in_review`; review cards are never held.

### Event subscriber

On launchd/systemd, `--subscribe` follows the board's event stream through
`taskctl events follow` (the local event hub) and asks for a continue turn when a
dispatch-relevant event arrives. It ships with the supervisor's enable set — the continue
clock remains the fallback and the only path for time-based work, and an event wakes a turn
only while the resident pool is live (without one it logs and skips). The loop carries no
HTTP code of its own: board discovery, the token and the stream all belong to the CLI. Cron
cannot host a long-lived process. The daemon publishes `subscribe.state.json`, which
`install.sh --supervisor=status` reads.

### Task process directory (`.meerkat/`)

Every task the loop dispatches gets one directory under the project's working directory —
the resolved `target_dir` (`local_path ?? run_dir`), which is also the subagent's cwd:

```text
.meerkat/<identifier>/
  card.md          the board card, exported by the loop (read-only)
  plan.md          the worker's plan (goals, steps, risks, acceptance mapping)
  …                the subagent's notes, logs, evidence, report drafts, attachments
```

- **Before the claim**, poll exports the card with
  `taskctl export md <identifier> --out <target_dir>/.meerkat/<identifier>/card.md`
  (a temp file plus an atomic rename). A failed export **defers the card unclaimed**: a
  claim with no brief has nowhere to run. Patrol's optional LLM lane does the same.
- `card.md` is the **authoritative brief** handed to the subagent and re-read on resume.
  It is machine-generated: **never edit it**. Only the loop overwrites it, through
  `taskctl export md`. It is a snapshot; `taskctl issue get <ref> --json` remains the live
  state and the source of the `version` a write needs.
- Other process files — including **downloaded attachments** — go in the same directory.
  A download is `taskctl attachment list <ref> --json`, then
  `taskctl attachment download <attachment-id> --out .meerkat/<identifier>/<filename>`.
- `--subscribe` follows board events and **batch-refreshes** the briefs of active cards
  (comments and reports included), debounced and rate-limited. A failed refresh leaves the
  previous brief in place. Dispatch is separate: an event wakes a continue turn only while
  the resident pool is live.
- Workers maintain `plan.md` and the reviewer reads it. An unexplained deviation from the
  plan is grounds for `VERDICT: REJECT`; a missing plan is not itself a failure (the
  reviewer falls back to the description and the frozen acceptance snapshot).

### Team roles (optional)

A team is an optional roles root, authored by `setup-meerkat` and never shipped by
`install.sh`. It adds two layers:

1. **Routing** — the loop reads the manifest's role responsibilities and selects the role
   named by the card's assignee (`Jobs`, `Linus`, `Turing`, `Reviewer`).
2. **Workflow** — the handoff carries the role's workflow path; the spawned subagent reads
   it before acting.

Precedence is whole-manifest: `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, then
`<project>/.meerkat/roles/`, then `<agent-dir>/skills/meerkat-loop/roles/`, then
`<agent-dir>/meerkat-taskpanel/roles/`. With no roles root the loop behaves exactly as
before. `setup-meerkat` writes the team's board names to `MEERKAT_TASKPANEL_AGENTS`;
without that list the loop only scans its default agent.

### Questions and decision rights

The ladder is **subagent → main session → human** (details:
`references/decision-policy.md`). A subagent never decides an unauthorized question: it
writes an agent `question` comment, keeps the card `in_progress`, and stops. The project
session answers with a `note` (then reattaches or moves the card to `todo`), or escalates
E1-E5 to the human with `awaiting`. Any human comment resumes an awaiting card, whatever
its kind; the board does not read it, and the resumed worker judges from its content
whether it is a complete decision (ask again if not). The loop never writes a decision kind
for its own answer and never uses `--as-human` except to record what the human actually said
in a human-opened conversation.

## Required board interface

```text
requires: board task-interface v1   — board release >= 1.1.0
```

The loop drives the board only through `taskctl` — the capability subset is the
board skill's `references/capabilities.md` (including `events follow` for the live
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
bash install.sh --target all        # every agent kind; openclaw gets the board only
```

The installer copies this skill into the agent's skill directory, copies the
execution body into `<agent-dir>/meerkat-taskpanel/`, renders the units and wake
glue, and prints the one command that loads a unit. Loading is opt-in:
`install.sh --supervisor=enable` (per agent kind with `--supervisor-actor-kinds`; also
`--supervisor=status`, `--supervisor=disable`). Enabling loads one set — the resident
pool, ping, continue and the event subscriber — and `status` reports each unit's load
state plus runtime facts for the pool and the subscriber.

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
templates/                units, wake glue, agent config (generated)
```

Everything except `SKILL.md`, `references/` and `scripts/board-check.mjs` is
generated by `node scripts/sync-skills.mjs` in the repository this skill is built
from. Do not hand-edit it: edit `scripts/supervisor.mjs`, `scripts/loop/`,
`scripts/wake-cwd.mjs`, `src/foundation/` or `scripts/install/templates/`, then
regenerate. The foundation copy under `scripts/foundation/` is byte-for-byte the
repository's `src/foundation/`; the entry scripts are copied with only their
foundation import specifiers rewritten to point at `./foundation/`.
