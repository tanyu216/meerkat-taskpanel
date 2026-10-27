# Operating the loop

Running the loop by hand, the flags that matter, the review workflow, and the
board/loop compatibility contract.

## Run by hand

```bash
taskctl loop session                         # the resident pool
taskctl loop run                             # both clocks
taskctl loop run --ping-once                 # one liveness pass
taskctl loop run --continue-once             # one judgment turn

taskctl loop patrol
taskctl loop workflow
taskctl loop poll
taskctl loop tick                            # patrol → workflow → poll in one command

# The live-session mode: status, an explicit pool takeover, the console cycle.
taskctl loop status --json
taskctl loop status --take-over
taskctl loop status --stop
taskctl loop console --json
taskctl loop session --control=external
```

The agent's `taskctl` shim carries `--agent` / `--actor-kind`; add them explicitly from a shell
that does not go through the shim. `--control=external` is the pool half of the manual mode: it
opens no control session and skips `continue.pending`; the live session runs the control turn
and the pool keeps only the project sessions. `loop status --take-over` starts exactly that,
records its pid, and `--stop` stops only that process.

### Main flags

Precedence: flag > process env > agent config > default. The complete surface is
`taskctl loop <verb> --help`; the flags a human actually sets:

| Flag | Meaning |
|---|---|
| `--agent <name>` | agent(s) to work for; repeatable / comma-separated |
| `--actor-kind claude\|codex\|pi` | which worker to wake |
| `--control=internal\|external` | who owns the control turn (session mode) |
| `--reviewer <agent>` | deployment reviewer; a project's `reviewer` overrides it, and an `agent` card with no effective reviewer fails startup |
| `--workflow=yes\|no` / `--workflow-max-actions <n>` | the write channel and its per-pass cap |
| `--workflow-ledger <path>` | alert de-duplication ledger; an unreadable one suppresses nothing |
| `--max-concurrency <n>` / `--project-concurrency <n>` | workers and reviewers share the budget |
| `--recover-stale=yes\|no` | include stale `in_progress` cards in the candidate read; the claim itself is `issue claim` |
| `--allow-all-tools` | full tool access; requires `--allow-all-tools-reason "<who and why>"` |
| `--dry-run` | print intended actions; write nothing |
| `--ping-once` / `--continue-once` | one clock and exit (on `loop run`) |

Transport (`--url`, `--env-file`, `--token`, `--config`, `--projects-json`, `--home`, `--cli`)
and the state/log paths are in `--help`. `--state-dir <dir>` derives the loop's state files;
`--assignee-only` is `--claim-unassigned=no`. There is no `--acceptance-policy` flag: the
card's own `acceptance_mode` is authoritative.

## No resident pool

Poll is the only claim path, and the project session is the only dispatcher, so the loop
refuses to claim when the pool is not live (`sessions.state.json`: pid alive and heartbeat
younger than 60s) or when `--resident=no` is set: poll logs why and emits one `--notify`
alert per cadence (`kind: no_resident`); an event-triggered turn is skipped; a one-shot
continue turn runs **patrol + workflow only** — the prompt omits poll; `patrol
--patrol-llm=yes` degrades to notify-only; review cards accumulate until the pool returns.
That is the cron shape, and the shape on an agent kind whose CLI lacks the resident protocol.
All three agent kinds have an adapter: Claude Code (stream-json), Codex (app-server threads),
Pi (`--mode rpc`).

## Manual mode

The loop has one control turn. In manual mode the **live session** runs it; the pool is
started with `--control=external`, so it opens no control session and leaves
`continue.pending` alone. Nothing else changes: the same `patrol → workflow → poll`, the same
question ladder, the same acceptance rules.

1. `taskctl loop status --json` → `running | busy | starting | configured-idle | partial | absent`.
   - `running` + `pool.controlMode: internal`: the supervisor owns the turn; do not run a
     second one. You may attach as a question console.
   - `configured-idle` / `partial` / `busy`: report; the service manager or an in-flight turn
     owns it.
   - `absent`: ask the human, then `taskctl loop status --take-over` (explicit; the pool
     persists until `taskctl loop status --stop`).
2. Control ticks run `taskctl loop patrol → workflow → poll`. With the external pool live, poll
   claims and enqueues; the pool's project sessions spawn the workers/reviewers.
3. Question ticks run `taskctl loop console --json`: `awaiting` cards, in_progress agent
   questions with no later human comment, and `in_review` cards pending acceptance. The UI
   comment and the in-session answer are the **same record**: re-read the card before asking
   and again before recording; if a human comment is already newer than the question, do not
   ask or duplicate it — use that comment and run a control tick. Otherwise ask, then record
   with `taskctl comment add <ref> --as-human …`. The board comment is authoritative, the
   in-session question is the front-end. Then apply the ladder's move and run a control tick.
4. Bound the loop (control cadence 600 s, question tick 30 s, TTL 30 min). Never decide E1–E5
   yourself, never claim/move a work card, never start a second pool, and run at most one
   console per agent directory (`session.lock` guards the pool; two consoles would race the
   workflow ledger). For unattended operation, enable the units.

`--opened-by human` is the same idea at the single-turn level; manual mode adds the pool and
the repeated loop around it.

## Card briefs and task process directories

The loop gives each dispatched card one directory under the project's working directory (the
resolved `target_dir`):

```text
.meerkat/<identifier>/
  card.md          exported by the loop; read-only to agents
  plan.md          the worker's plan: goals, steps, risks, acceptance mapping
  …                notes, logs, evidence, report drafts, downloaded attachments
```

**Register before claim.** `poll` resolves the project directory, then registers the card
with the local event hub, naming `<target_dir>/.meerkat/<identifier>/card.md` (and the
original's brief when it is a review card). The hub writes the first snapshot before it
answers `registered`, then keeps the file fresh until the card is `done` or `canceled`; the
registration has no TTL. If registration fails — or the card is already terminal — it is
**deferred unclaimed** and the next turn retries. A refused claim unregisters it again.
Patrol's `--patrol-llm=yes` lane registers the same way.

**The brief is authoritative for dispatch and resume.** The handoff names the relative path
(its cwd is the project directory), says to read it first, and says never to edit it: only
the hub watch overwrites it (a manual `taskctl export md` produces the same file, but the loop never needs one). `taskctl issue get <ref> --json` stays in the handoff for
live status and the `version` a write needs. A resumed session re-reads the brief before
continuing.

**Attachments go in the same directory:** `taskctl attachment list <ref> --json`, then
`taskctl attachment download <attachment-id> --out .meerkat/<identifier>/<filename>`.

**Refresh on events.** The hub refreshes every registered file on the board's events, with a
debounced batch (300 ms, 2 s maximum wait) and a 5 s floor between batches; a failed refresh
only logs and keeps the previous file. The loop's subscriber does not write briefs. Dispatch
is separate: an event wakes a continue turn only while the resident pool is live.

**The plan file.** Workers maintain `plan.md` beside the brief and update it as they learn; the
reviewer reads it and treats an unexplained deviation as grounds for `VERDICT: REJECT`. A
missing plan is not itself a failure: the reviewer falls back to the description and the
frozen acceptance snapshot. The board holds no directory; this is a loop convention under the
project's own working directory.

## The working tree

The loop schedules conversations, not sandboxes. Parallel cards in one project share its
working directory, and `--project-concurrency` above 1 means they run there at the same time.
If cards can touch the same files, give each its own `git worktree` — a role or deployment
convention; the loop neither creates nor merges worktrees, and it does not detect conflicts.
It logs one warning per directory when it first admits parallel work in a git checkout.

## Team roles (optional)

A team is an optional roles root authored by `setup-meerkat`. The loop reads `manifest.json`
there and adds routing (the role named by the card's assignee supplies responsibilities and
boundaries) and a workflow path carried in the handoff. Precedence is whole-manifest:
`--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, then `<project>/.meerkat/roles/`, then
`<agent-dir>/skills/meerkat-loop/roles/`. A malformed manifest warns and degrades to no role;
it never wedges a tick. `setup-meerkat`
writes the team's board names to `MEERKAT_TASKPANEL_AGENTS`; without that list the loop scans
only its default agent, so a role card is never claimed.

## Questions and decision rights

The ladder is **subagent → main session → human**; the full policy is
`references/decision-policy.md`. A subagent never decides an unauthorized question: it writes
an agent `question` comment, keeps the card `in_progress`, and stops. Poll's **question lane**
then enqueues the unanswered question for the project session (no claim, no subagent slot),
which answers with a `note` and moves the card to `todo`, or escalates E1-E5 to the human with
`issue move <ref> awaiting --awaiting-reason E1..E5 --question "…"`.

A question is asked as a **round**: the frontier is every open decision whose prerequisites are
settled, numbered Q1..Qn with a recommendation, worded so "yes" accepts it. One round is one
question string per card — the subagent puts the whole frontier in one `question` comment, the
project session answers the decidable items in one `note`, and an escalation names the E1-E5
items in one `awaiting` string. Facts are the asker's job; never ask the human for a fact the
card, code or docs can establish. In manual mode the console lists every waiting card, so ask
them in one message with one numbered block per card, then recompute and ask only the newly
unblocked round. The full protocol is `references/decision-policy.md` §Decision rounds.

Any human comment auto-resumes an awaiting card — the kind does not matter and the board does
not read it. Approve, reject and direction are judged from the content by the resumed worker;
an incomplete or ambiguous answer is not consent, and the card goes back to `awaiting` for
another human comment. The loop never writes a decision kind for its own answer, and never
uses `--as-human` except to record what the human actually said in a human-opened conversation
(`--opened-by human`). With `--opened-by supervisor` the question stays on the board for the
human.

## The workflow channel

The SLA rows are notify-only. The workflow pass is the only path that writes a card, and the
board decides what it writes: one plan (container reconcile, review outcomes, auto-accept,
dispatch), which the loop then executes. The exact invocation and every action field are the
board skill's capability contract (`references/capabilities.md` §6–7); the review-card shape
and its structural identity are `references/review-workflow.md` in the same skill.

A flow-A delivery that lands in `in_review` **on a card whose `acceptance_mode` is `agent`** is
dispatched to the configured reviewer as a **review card**. The reviewer is
`project.reviewer ??` the deployment reviewer. Poll wakes every configured reviewer through the
normal atomic claim; a dedicated reviewer sees only review cards and never the public pool.

An `off` card gets no review card. The plan carries `auto_accept`, which the loop applies
(`loop-auto`); an `off` card may also skip `in_review` entirely (`issue deliver --to done`). A
`human` card is left for the person (`auto_accept_skipped`, reason `human_mode`).

What keeps it safe to run unattended:

- **One review card per (original, delivery round)** — idempotency key
  `loop-review|<ref>|r<round>`. A re-delivery after a rejection is a new round and is reviewed
  again.
- **The review card is closed last** — a crash between the original's move and the card's close
  is recovered next pass.
- **A truncated board read dispatches nothing**, and a reviewer equal to the card's own
  assignee is refused (`self_review_not_independent`).
- **A canceled review card ends `canceled`** — the two-hop `in_review → in_progress →
  canceled`; it is never recorded as `done`.
- **A review card always has a closer** — the loop closes the card it dispatched.

The plan's alerts are log-only; the board returns them with the plan (`capabilities.md` §6).
An unreadable or incomplete verdict produces an alert and a bounded `reopen_review` (two
attempts); when the bound is reached the card is left for a human. The verdict contract and the
loop's action per verdict are `references/review-workflow.md` §6; the agent-facing protocol is
§3. The reviewer reads the original's description, every acceptance item, the current round's
report, the comment trail and (for an epic) its children, and writes `VERDICT: APPROVE` or
`VERDICT: REJECT` on the review card. The reviewer moves nothing; the loop is the acceptor.

## Headless permission boundary

A dispatched worker is non-interactive, so it must run under a pre-declared boundary — a tool
allowlist, a permission mode, a sandbox. The resident adapters ship **no** permission bypass.
The pool keeps role allowlists by default (control: read + `taskctl` + `node`; reviewer:
read/search + `taskctl` + `git`, no write; worker: the same plus edit/write). A review card
runs in its own `role=reviewer` conversation, so the allowlist reaches the subagent it spawns.
Claude and Pi enforce it; Codex has no per-role tool surface, and the pool logs a one-time
warning when it opens a reviewer lane there. Full tool access is the documented opt-in, in the
agent config rather than a unit flag:

```bash
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON="<who authorized it and why>"
```

The reason is required. With it, every session runs with the user's full OS permissions; the
project directory is a working directory, **not** an isolation boundary.

## Compatibility

The loop declares `task-interface v1` and board release ≥ 0.1.0 in `SKILL.md`, enforced by
`taskctl loop compat`; the board declares its release and contract `schema_version` through
`taskctl --version --json`. The gate is deliberately coarse: it answers "is this a board of the
generation I was written against?", not "does every command still behave identically". A change
to the `task-interface` surface means a new generation on both sides.

### What the loop needs from its runtime tree

The loop **is** part of the toolkit now (`taskctl loop …`), so it needs no separate body and no
checkout of its own: the installed tree (or the checkout, for a development run) is enough, and
`MEERKAT_TASKPANEL_REPO` in the agent config names it. A combined install (`--target all`,
npm/npx) records `~/.meerkat-taskpanel`; an agent-only install records the checkout. Moving the
tree is a re-install — the units need no reload because they name the CLI entry through that
key.
