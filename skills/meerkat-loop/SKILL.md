---
name: meerkat-loop
description: The external scheduler for a Meerkat TaskPanel board. Runs a 60-second liveness ping, a 10-minute continue turn, and a resident session pool that holds one control conversation, one worker session per target directory, and a reviewer session there on demand. The continue turn runs the notify-only SLA patrol, the board's review workflow, and the poll that claims a card and enqueues its handoff; the worker or reviewer session spawns the matching subagent in the project directory. Runs under launchd / systemd / cron units for claude, codex and pi; OpenClaw is excluded.
disable-model-invocation: true
---

# Meerkat Loop

The loop runs when no agent is looking. Its scheduler owns two clocks and — in its default
resident shape — a long-lived **session pool**:

| Part | Cadence | Job |
|---|---|---|
| **ping** (`taskctl loop run --ping-once`) | 60s | prune registry entries whose pid is gone. No board read, no claim, no LLM |
| **continue** (`taskctl loop run --continue-once`) | 600s | hand the control session a bounded `/meerkat-loop` continue prompt (or run it one-shot when no pool is live); that turn runs the entries below |
| **session** (`taskctl loop session`) | long-lived | one control conversation, one project conversation per target directory, and a reviewer conversation per directory on demand; each lane spawns its worker/reviewer subagent in that directory |

A subagent inherits the **launch cwd** of the session that spawns it, so one board-wide session
cannot serve two project directories. That is why the pool keeps one worker session per
directory, and a reviewer session in the same directory when a review card is queued. Without a
live pool, poll claims nothing and only patrol and workflow run — see
`references/operation.md` §No resident pool.

The continue turn runs three deterministic commands, in this order:

1. **patrol** — notify-only SLA pass. The board computes the SLA rows; the loop de-duplicates
   them, re-reads a survivor and notifies the leader. It also emits the legacy stale-heartbeat
   alerts and the peer-inspector liveness row. No alert moves a card, and no LLM turn starts by
   default.
2. **workflow** — the write channel. The **board** computes the plan and the **loop** applies
   it. For a flow-A delivery, dispatch an independent reviewer regardless of whether the card
   is `acceptance_mode: agent` or `human`, apply the reviewer's `VERDICT:` report, and close
   the review card last. Only the close differs: an `agent` original is accepted by the loop
   (`loop-review`); a `human` original gets the verdict recorded and is left for a person to
   close. There is no kind filter — a finished epic is dispatched in the same pass that rolls
   it up, and its review reads the child cards and the rollup. An `off` card is not
   dispatched: the plan emits `auto_accept` and the loop closes the original directly
   (`loop-auto`). On by default;
   `--workflow=no` disables it. The reviewer is `project.reviewer ??` the deployment reviewer
   (`--reviewer` / `MEERKAT_TASKPANEL_REVIEWER` / per-kind config). An `agent` card with no
   effective reviewer fails the loop at startup: the board would have dispatched a review
   nobody can claim.
3. **poll** — scan, **register the card brief watch**, atomically claim, **enqueue the handoff**. It
   also runs the **question lane**: an unanswered agent `question` on an `in_progress` card is
   enqueued for the project session (no claim, no subagent slot). It never spawns a worker: the
   resident project session does, as a subagent that inherits the project directory. Runs last
   so a review card dispatched in this turn can be claimed immediately. At the concurrency cap,
   with no project directory for the card, or when the brief cannot be written, nothing is
   claimed.

The exact `taskctl` invocations and the JSON keys each pass reads are the `meerkat` board
skill's capability contract (`references/capabilities.md`). This skill records only
the decisions — when to patrol, dispatch, claim, wake or notify. **The board's plan is the
authority on actions**; a refused call carries a named code and hint, and the loop acts on that
rather than pre-checking board rules here.

**Board operations belong to the `meerkat` board skill.** Whenever a step needs a card read or
write — claim, heartbeat, comment, question, report, deliver, move, relation, brief refresh,
attachment — follow that skill; this one records only when and why.

### Invocation

This skill is **command-only**. Its frontmatter sets `disable-model-invocation: true`, so the
model never sees it in its skill list and never loads it from a keyword or description match;
only an explicit invocation runs it:

```text
/meerkat-loop
```

The text after the command is the turn's instruction, not a subcommand. A supervisor's continue
turn passes `/meerkat-loop Continue — …`; the rest of that prompt (the three `taskctl loop`
commands) is appended as the turn's input. There is no argument placeholder, no subcommand and
no argument parsing.

**Read the mode first.** The instruction's first line declares it:

- `mode: supervised` — this session is the **headless supervisor's** control turn. There is no
  interactive user in the session window. **Never ask a question there**; ask on the card with
  a board comment.
- **no marker** — a human invoked the skill in a live session. This is **manual** mode; the
  human is present and can be asked in the conversation (the answer is still recorded as a
  board comment).

The two modes run the same control turn — see §Execution modes. On an agent kind that does not
slash commands, the `/meerkat-loop` prefix stays literal text and the rest of the prompt still
carries the work.

### Execution modes

There is **one control turn**: `patrol → workflow → poll`, the same question ladder and the
same acceptance rules. Two drivers run it; the turn says which.

- **Supervised** (`mode: supervised`). The scheduler (ping/continue/events) or a one-shot
  supplies the prompt. This session is **headless**: no user is watching the session window, so
  never ask a question there. The prompt is authoritative: run exactly the commands it lists —
  poll is absent when no pool is live. Ask the human on the card, as a comment. Do not start a
  clock, a pool, a subscriber or a watcher; return when the turn is done.
- **Manual** (no marker). A human invoked the skill in a live session. The session is the
  control turn and the pool is the dispatcher; the human is the clock and the question
  front-end. Questions may be asked in the conversation and are recorded as board comments.

#### Manual mode

1. **Detect.** Run `taskctl loop status --json`:
   - `running` — a pool is live. `pool.controlMode` says who owns the turn. `internal` means
     the supervisor owns it: do **not** run a second control turn; you may attach as a question
     console. `external` means a live session owns it; run the loop.
   - `configured-idle` / `partial` / `busy` — report; do not start a pool and do not fight the
     service manager.
   - `absent` — nothing is running. Ask the human before taking over.
2. **Take over (explicit only).** If `absent` and the human agrees, run
   `taskctl loop status --take-over`: it starts the pool in **external-control** mode (project
   sessions still dispatch) and records its pid. Stop it with `taskctl loop status --stop`. If
   the human declines, stop after the read-only report.
3. **Control tick.** Run the three commands the supervised prompt lists — `taskctl loop patrol`,
   `taskctl loop workflow`, `taskctl loop poll`. With the external pool live, poll claims and
   enqueues; the pool's project sessions spawn the workers/reviewers.
4. **Question tick — one round across all waiting cards.**
   `taskctl loop console --json` lists the `awaiting` cards, in-progress agent questions no
   human has answered, and `in_review` cards pending acceptance. **Both
   answer channels are the same record** — a human comment in the board UI and an answer typed
   in this conversation:
   - Before asking, re-read the card's comment trail (the `meerkat` board skill's comment
     list). If a human comment is newer than the question, the human already answered — so
     do not ask again, do not write a second comment, and run a control tick.
   - Otherwise ask the whole frontier in **one message**: one numbered block per card, each item
     Q1..Qn with a recommendation, worded so "yes" accepts it. Facts are yours to look up —
     never ask for a fact the card, code or docs can establish. A question that depends on
     another open one waits for the next round. One round is one question string per card:
     never drip one comment per item.
   - After they answer, re-read once more: if a human comment (a UI answer posted while you were
     asking) is already newer than the question, do not duplicate it; otherwise record their
     answer verbatim as a human comment (`--as-human`, per the `meerkat` board skill). The
     board comment is authoritative; the in-session question is only the front-end.
   - Apply the move the question ladder prescribes (an awaiting card resumes on the human
     comment; an in_progress agent question → `todo`/reattach) and run a control tick so the
     resumed card is processed promptly. Only a human comment resumes awaiting.
5. **Bound the loop.** Control ticks follow the continue cadence (default 600s); question ticks
   default to 30s; stop at the requested TTL (default 30 min) or on "stop". On exit report the
   pool pid and `taskctl loop status --stop`.

**Never** decide an E1–E5 question yourself; never claim or move a work card; never start a
second pool. Run at most one manual console per agent directory: `session.lock` guards the
pool, but two consoles would still race the workflow ledger.

```bash
# The agent's own `taskctl` shim carries `--agent` and `--actor-kind`; a session
# that overrides either passes the flag explicitly.
taskctl loop status --json
taskctl loop console --json
taskctl loop patrol
taskctl loop workflow
taskctl loop poll
```

`--take-over`, `--stop`, `--dry-run` and the policy flags (`--workflow`, `--reviewer`,
`--claim-unassigned`, …) belong to the verb they modify — `taskctl loop <verb> --help` is the
list. An install that has no shim on `PATH` can use `<agent-dir>/bin/taskctl`, or
`node <runtime>/src/cli/index.mjs loop …` with `--agent`/`--actor-kind`.

### Who may close

The card's own `acceptance_mode` is authoritative and arrives on the card; the loop keeps no
local copy and there is no board-level policy. In loop terms it closes what the plan lets
`taskd` close: an `agent` original after a current-round `APPROVE`, its review card, and an
`off` card the plan auto-accepts. A `human` card is still reviewed, but it is never accepted
by the loop — record the verdict on the original, close the review card, and let the person
close it. A card with a parent is never `human` (the board refuses the mode at the parent edge
and at `issue update --acceptance-mode human`), and every unresolved card — task or epic —
defaults to `agent`. A worker always stops at `in_review`; review cards
are never held, and the loop always closes the card it dispatched. The `meerkat` board
skill's `references/review-workflow.md` is the semantic authority; this skill describes **when** the
loop dispatches and **how** it executes the plan.

### Event subscriber

On launchd/systemd, `taskctl loop subscribe` follows the board's event stream through
`taskctl events follow` (the local event hub) and asks for a continue turn when a
dispatch-relevant event arrives. The continue clock remains the fallback and the only path for
time-based work; an event wakes a turn only while the resident pool is live (without one it
logs and skips). Cron cannot host a long-lived process. The daemon publishes
`subscribe.state.json`.

### Task process directory (`.meerkat/`)

Every task the loop dispatches gets one directory under the project's working directory — the
resolved `target_dir` (from the machine-local map at the config root: `local_path ?? run_dir`),
which is also the subagent's cwd:

```text
.meerkat/<identifier>/
  card.md          the board card, exported by the loop (read-only)
  plan.md          the worker's plan (goals, steps, risks, acceptance mapping)
  …                the subagent's notes, logs, evidence, report drafts, attachments
```

- **Before the claim**, poll registers the card with the local event hub, naming
  `<target_dir>/.meerkat/<identifier>/card.md` (and the original's brief for a review card).
  The hub writes the first snapshot before it answers, then keeps the file fresh until the
  card is `done` or `canceled`. A failed registration — or a card that is already terminal —
  **defers the card unclaimed**; a refused claim unregisters it again. A claim with no brief
  has nowhere to run.
- `card.md` is the **authoritative brief** handed to the subagent and re-read on resume. The
  hub rewrites it from the board: **never edit it**. It is a snapshot; the live card (read as
  JSON through the `meerkat` board skill) is the live state and the source of the `version` a
  write needs.
- Other process files — including **downloaded attachments** — go in the same directory; the
  `meerkat` board skill owns the attachment list and download commands.
- The hub owns the refresh, debounced and rate-limited, for every registration; a failed
  refresh leaves the previous brief in place. Dispatch is separate: an event wakes a continue
  turn only while the resident pool is live.
- Workers maintain `plan.md` and the reviewer reads it. An unexplained deviation is grounds for
  `VERDICT: REJECT`; a missing plan is not itself a failure (the reviewer falls back to the
  description and the frozen acceptance snapshot).

### Team roles (optional)

A team is an optional roles root. It adds routing (the role named by the card's assignee
supplies responsibilities and boundaries) and a workflow path carried in the handoff.
Precedence is whole-manifest: `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, then
`<project>/.meerkat/roles/`, then `<agent-dir>/skills/meerkat-loop/roles/`. With no roles root
the loop behaves exactly as before. The loop's own `references/decision-policy.md` is the
single decision-authority source; a team's `decision-policy.md` is ignored. An `ownership.md`,
if the team has one, is a short routing guide the project session reads to assign one
accountable role per work shape; the create names that role as the card's assignee, and the
assignee still selects the executing role. A shape
the guide does not describe goes to a worker outside the roles — a board name absent from the
manifest — rather than being force-fit into a role.
`MEERKAT_TASKPANEL_AGENTS` lists the team's board names; without it the loop only scans its
default agent. An outside-roles worker must be listed there too, since it has no role record
to be discovered from.

### Questions and decision rights

The ladder is **subagent → main session → human**, and the full protocol is
`references/decision-policy.md`. A subagent never decides an unauthorized question: it writes
an agent `question` comment, keeps the card `in_progress`, and stops. Poll's **question lane**
wakes the project session with the unanswered question (no claim, no subagent slot); it answers
with a `note` and moves the card to `todo`, or escalates E1-E5 to the human with `awaiting`.
Only a human comment resumes an awaiting card, whatever its kind; the board does not read it,
and the resumed worker judges from its content whether the decision is complete. The loop
never writes a decision kind for its own answer and never signs `--as-human` for itself. A
round asks the whole frontier at once — one question string per card — so the next pass asks
only what the answers unblocked.

## Required board interface

```text
requires: board task-interface v1   — board release >= 0.1.0
```

The loop drives the board only through `taskctl` — the capability subset is the `meerkat`
board skill's `references/capabilities.md` (including `events follow` for the live stream; the loop never
calls the HTTP API). `task-interface v1` and the board-side workflow plan both ship in the
0.1.0 baseline. Gate check before pointing a loop at a board:

```bash
taskctl loop compat                 # taskctl on PATH
taskctl loop compat --repo <path>   # the runtime tree / checkout to inspect
taskctl loop compat --json          # machine-readable verdict
```

Exit 3 means no verdict: the board could not be asked, or its declared version is below the
floor. The gate does not prove that every command still behaves the same way; the compatibility
table in `references/operation.md` records that pairing.
