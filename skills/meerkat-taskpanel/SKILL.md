---
name: meerkat-taskpanel
description: Coordinate work across an AI Agent team using a shared local kanban task board (Meerkat TaskPanel). Use when an agent or a human needs to claim a card, find what to work on next, groom the backlog, create and track cards, move work through a status workflow, assign owners, comment on a decision, edit a card's description or priority, link parent/child (epic) and blocking relations, record which agent session is working on what, deliver a card with a report, run or respond to an independent review, ask a human a question (awaiting), or export the board as markdown. Runs the local `taskctl` CLI; no external services required.
---

# Meerkat TaskPanel

A local-first task board for AI Agent teams, driven entirely through the `taskctl` CLI. An
agent claims a card, heartbeats while it works, comments, and delivers with a report; results
roll up a parent/child tree. This page is the working manual — what to do, in order. The rules
behind each step live in the linked references and are not repeated here.

Scheduling is **not** this skill's job: the external supervisor is the `meerkat-loop` skill,
and the board owns the workflow decisions (`issue reconcile --workflow`); the loop only
executes them.

> Paths written as `src/…`, `docs/…` or `scripts/loop/…` name the taskpanel **source
> repository**. This skill ships `SKILL.md`, `references/` and `scripts/`; everything you run
> is `taskctl`.

## Running the CLI

```bash
node scripts/run.mjs --help          # this skill's launcher
taskctl --help                       # when the install shim is on PATH
```

`scripts/run.mjs` spawns the board CLI, pipes stdio and propagates the exit code; it resolves
the CLI from `$MEERKAT_TASKPANEL_ROOT`, then `$MEERKAT_TASKPANEL_REPO` (recorded by
`install.sh`), then the checkout this skill sits in, then the `taskctl` shim, then `PATH`.

The shim passes `--actor-kind <kind>` and a default `--agent <name>` on every call.
`--actor-kind` is required on every command except `--help` / `--version` (and the local
`status` read); a team passes `--agent jobs` / `linus` / `turing` to override the default, and
a human writes with `--as-human`. Configuration is one install-root `.env`, read by both
`taskctl` and `taskd` (the process environment wins key by key; `--env-file` /
`MEERKAT_TASKPANEL_ENV_FILE` selects another). If no board is running, `taskctl` starts one —
`TASKD_NO_AUTOSTART=1` forbids that. Flags, env keys and exit codes:
[`references/cli.md`](references/cli.md).

## The status model

A card has **eight stored status words**, but only **seven are stages** (the board's columns):
`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`. `awaiting` is an
**attention overlay** — a card parked on a human question, shown under `in_progress`. `done`
and `canceled` are terminal, with one audited exit: reopen to `todo`
(`issue reopen <ref> --reason "<why>"`), which starts a new delivery round; a review card
cannot be reopened — reopen the card it reviews.

Only these moves exist; every other pair is refused (`INVALID_TRANSITION`, or `TERMINAL_STATE`
out of a terminal card):

<!-- status-whitelist:begin -->
```text
backlog     → todo, canceled
todo        → backlog, in_progress, blocked, canceled        (an epic also → in_review)
in_progress → in_review, blocked, todo, canceled, awaiting
awaiting    → in_progress, todo, canceled
in_review   → done, in_progress, blocked
blocked     → todo, in_progress, in_review, canceled
done        → todo
canceled    → todo
```
<!-- status-whitelist:end -->

A legal edge can still be refused. What decides it, one line each:

1. **`in_review` needs evidence for the current round** — a `delivery` report for the card's
   current `delivery_round`, or the audited `--no-report --reason` (≥ 8 characters). Leaving
   `in_review` for `in_progress` or `blocked` starts a new round and voids the old report; use
   `issue deliver` to write the report and move in one transaction.
2. **`done` is acceptance, not a worker's act.** It is reachable only from `in_review`. An
   agent is refused (`ACCEPTANCE_FORBIDDEN`) on a **top-level** card; a **child** card is the
   opposite — only a non-human writer closes it. A human closing a top-level card needs the
   current round's review cards resolved (`REVIEW_PENDING`), and a non-empty acceptance
   baseline must be covered first (`ACCEPTANCE_INCOMPLETE` / `ACCEPTANCE_UNVERIFIED`).
3. **`awaiting` is a question; `blocked` is everything else.** `awaiting` has one entrance —
   `in_progress → awaiting`, naming `E1`–`E5` — and cannot reach `in_review` or `done`.
   `blocked` takes an optional `--blocked-reason`, cleared on exit; `in_review → blocked` is a
   rework and starts a new round.
4. **A container never reaches `done` by itself.** An epic cannot be claimed; the board starts
   it and closes it to `in_review`. A parent cannot enter `in_review` or `done` while any child
   is non-terminal (`CHILDREN_OPEN`).
5. **The claim follows the status.** Held in `in_progress`, `awaiting`, `in_review` and
   `blocked`; released on `todo`/`backlog`/`done`/`canceled`. `todo → in_progress` is a claim;
   a rework keeps the executor.
6. **Reopening needs a reason.** `done`/`canceled → todo` is the only terminal exit, via
   `issue reopen` with a reason ≥ 8 characters; it starts a new round, clears the archive and
   releases the idem key. `in_progress` is not a reopen target.

Every guard in evaluation order, the round table, claim windows, the acceptance policy matrix
and the refusal codes: [`references/status-lifecycle.md`](references/status-lifecycle.md).

## Claim one card, deliver it, stop

Read the claimable set for *you*, take exactly one, then work it:

```bash
taskctl issue candidates --assignee <me>       # read-only: what may I claim?
taskctl issue move <ref> in_progress           # claim exactly one
taskctl issue get <ref> --json                 # description + the frozen acceptance snapshot
taskctl issue heartbeat <ref>                  # keep the claim fresh (at least every 10 minutes)
taskctl report template <ref>                  # fill the TODO lines
taskctl issue deliver <ref> --report-file -    # report + in_review, one transaction
```

Then **stop**: acceptance is somebody else's act. Do **not** claim a card that is any of these
— it is not yours:

- **assigned to someone else** — the board refuses; it is never silently reassigned;
- in **`backlog`** — only the dispatcher or a human releases it to `todo`;
- an **`epic`** — a container, not a unit of work; claim its leaf children;
- a **deployment card** (`kind: deploy`) — dispatched explicitly, never auto-claimed;
- waiting on a **`depends_on` blocker that is not `done`** (a `canceled` predecessor withholds
  it too). `issue candidates` withholds the last three; the claim verb does not re-check
  blockers, so use `taskctl relation list <ref>` when a card you expected is missing.

A heartbeat resets the claim and **nothing else** — not status, not claimer, not the delivery
round — and only the holder may send it. A claim you stop pulsing reads as abandoned.

### The acceptance list is the contract

`issue get <ref> --json` carries `acceptance[]` — the **frozen** snapshot the delivery gate
reads. `meta.acceptance` is only the seed it was copied from; the gate never reads it.

- **The snapshot is non-empty** — that is the list you work to. It is frozen: **append** with
  `issue update <ref> --acceptance "…"`; never replace or remove. Removal is a human-only,
  audited prune (`--drop-acceptance --reason`, ≥ 8 characters). Once the card is `in_review`
  the baseline is locked; a wrong baseline means rework, which starts a new round.
- **The snapshot is empty but `meta.acceptance` / `meta.acceptance_legacy` is not** — a
  grandfathered card whose list renders as a seed. Append it as above; the next round freezes
  it.
- **All three are empty** — a mechanical derivation is still an acceptance decision. Derive
  **1–6 concrete, externally checkable** items (usually 2–6; never pad) only when the project
  session's handoff pre-authorized it for this card, persist them once, and record the act:

```bash
taskctl issue update <ref> --acceptance "…" --acceptance "…" --meta acceptance_derived=yes
taskctl comment add <ref> --kind note \
  --body "acceptance list derived at claim (pre-authorized): 1) … 2) …"
```

Without that pre-authorization, write an agent `question` comment describing the proposed items
and stop; the project session decides, including whether to escalate `E2`. Never derive on an
**epic** (its acceptance is its children) or on a **review card**. If the card is too thin to
yield checkable items, say so in the question rather than inventing them, and say in the
delivery report that the list was derived when it was.

The report must **cover the snapshot**: every item appears by text; `met` or `not_applicable`
(with a non-empty note) passes, `partial` / `not_met` block. A report item beyond the baseline
blocks too if it is unfinished — the report itself says the work is. An imported checkbox list
freezes as plain items: a tick on the card is the author's intent, not this delivery's evidence.

### Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction. The board refuses
`in_review` without a report for the current round (`REPORT_REQUIRED`) and prints the fixing
command; `--no-report --reason "<why>"` (≥ 8 characters, mutually exclusive with
`--report-file`) is the audited waiver for one round. Never move a card to `done` unless its
own `acceptance_mode` lets you: `off` lets the deliverer close it (and `in_progress → done`
directly), `agent` waits for an independent `APPROVE`, `human` means a person closes it. Who
may accept what:
[`references/status-lifecycle.md#7-acceptance-one-mode-per-card`](references/status-lifecycle.md#7-acceptance-one-mode-per-card).

After delivery the board decides. When the card is `agent`, it dispatches an independent
review card, applies the reviewer's `VERDICT:`, and accepts or returns the original. The
mode is resolved once, at creation:

- `--acceptance-mode off|agent|human` on `issue create` is the card's snapshot.
- Omitted, it follows the project's `acceptance` default (`auto` by default). In an `auto`
  project the creator decides: pass a mode, or the card falls back to `human`.
- An `off` card is auto-accepted (`loop-auto`) and may be delivered straight to `done`.
- A `human` card is never auto-accepted; a person closes it.
- The mode can be changed with `taskctl issue update <ref> --acceptance-mode <value>
  --reason "<why>"` (audited as `acceptance_override`). An agent may only tighten
  (`off → agent|human`); leaving `agent` needs no open current-round review.
- A review card is always `acceptance_mode = off`; it is never reviewed again.

## Containers: when the card is an epic

A card filed from the web UI is always a `task`; an epic exists only where someone named one.
Promoting and splitting is a scope decision, so it belongs to the project session (and an
out-of-scope expansion to the human, `E1`). A worker that finds several independent
deliverables writes an agent `question` comment describing the pieces, keeps the card
`in_progress`, and stops.

First decide what the card *is*: if its title and description name the **sum** of the work it
is the container; if they name **one deliverable** it is a child of that container.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (below) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card as a child (or `related` for history) |
| a review card, or a `deploy` card | — | do **not** promote; split a separate container |

Promotion is only for a card that has **not delivered its current-round report**. The rollup
collects the **children's** delivery reports, not the container's own history, so promoting a
card that already delivered strands every child attached after it. A card that has delivered
starts a *new* container instead.

The decision-maker makes the container **before** any child work starts, and records the split
with a `note`:

```bash
taskctl issue update <ref> --kind epic       # the card keeps its status
taskctl comment add <ref> --kind note --body "split into N cards: …"
taskctl issue create --project <p> --title "…" --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

Facts that decide that order:

- **An epic can never be claimed** (`not_claimable`), so a card that must end up `in_progress`
  is claimed **while it is still a `task`**, then promoted. The promoted card keeps its status.
- **The board starts it:** the first child to enter `in_progress` moves the container
  `todo → in_progress`. **The board closes it:** when every child is terminal with at least one
  `done`, it writes the rollup report and moves the epic to `in_review`, never `done`.
- **An epic's delivery *is* its rollup.** A report on an epic must name every live child by
  `ref` (`done` → `met`, `canceled` → `not_applicable` + note, at least one `done`); `done`
  refuses a missing one (`ROLLUP_REQUIRED`) or a stale one (`ROLLUP_STALE`). A waiver cannot
  deliver a container, and an empty epic has nothing to roll up. A child attached after the
  rollup makes it stale — rework the epic to start a new round.
- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source +
  target, so two children for one owner with nothing to tell them apart are the *same card*
  (the second create is read as a retry). Use `--allow-dup` when a target does not apply.
  **`issue create --parent <epic>` links nothing** — only `relation add --type parent` does.
- **Nothing delivered stays open.** If every child was canceled or waived, there is no `done`
  child to roll up — cancel the container instead. A `backlog` or `awaiting` epic does not
  auto-start or auto-close: move it to `todo` (or `in_progress`) first. An `in_review` epic
  that gains a child must be moved back to `in_progress`; the board will not roll it up from
  `in_review`.

Before you write, check the shape: all children in the same project; at most **8** direct
children; at most **8** nodes on a parent chain; an ancestor and a descendant may not `blocks`
each other; a child has exactly one parent. Claim exactly **one** child and work it as usual —
the container holds no work of its own. `issue reconcile` is the board's backstop for its own
start/close rules, not a step you owe. Full rules:
[`references/status-lifecycle.md#6-containers-epic`](references/status-lifecycle.md#6-containers-epic).

## Review cards (flow B)

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round`
(or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a
discovery aid, never the predicate. `meta.flow` absent means flow A; the loop writes
`meta.flow=B` on the review card it dispatches, and a flow-B card is never reviewed again.

Claim it like any `todo` card, but the work is a review, not a change to the original: read the
original's description, every acceptance item, the current round's report and evidence, the
comment trail and (for an epic) its children. Then deliver a report **on this card** whose
first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; put the findings after that
line and in `leftovers`. Move neither card — the loop applies the verdict and closes the review
card.

The review card's `review_round` is the **original's** round being audited; the review card's
own `delivery_round` is a different number (a fresh card starts at 1). A re-delivery after a
rejection needs a new review card for the new round. Full protocol:
[`references/review-workflow.md`](references/review-workflow.md).

## Waiting: a human question, or blocked

- A question for a person is **`awaiting`**, not `blocked` and not a chat message:
  `issue move <ref> awaiting --awaiting-reason E3 --question "…"`. The reason must be `E1`–`E5`
  (scope · acceptance baseline · design direction · security · architecture), and an agent
  must also ask the question (`--question`, or an earlier unanswered one on the card). **Any
  human comment** re-queues the card to `todo`; `awaiting → in_progress` resumes the same
  attempt without a new delivery round.
- **`blocked`** is for everything else. `--blocked-reason` is optional; its literals and
  meanings are in
  [`references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for`](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

## Coordinating with other agents

- **Never force a conflict.** On `VERSION_CONFLICT`, or a claim that looks stale, re-read the
  card once and retry from the fresh state with the current `--if-version`. Blind retries are
  how two agents overwrite each other.
- **Stamp every write with your identity:** `--actor-kind <kind> --session-id <id>`. The
  session id turns a card back into "which conversation did this", and lets a resumed session
  re-attach instead of starting over. `taskctl session id <ref> --seg <seg> --owner <name>`
  derives it before a session starts; with no board reachable,
  [`scripts/session-id.mjs`](scripts/session-id.mjs) computes the same value from the resolved
  task UUID (`--task-id`, from `issue get <ref> --json` → `data.task.id`).
- **The board runs no timer.** On an agent kind with the loop installed, the `meerkat-loop`
  skill owns the scheduler — do not add a second poller or schedule its entries yourself. An
  agent kind or service that owns its own timer drives one tick of
  `candidates → claim → heartbeat`, and binds scripts to `error.code` and
  `error.hint.command`, never to prose.

## Configuring project directories

**The board holds no directories.** The only answer to "which directory does work for this
project happen in" is `projects.json`, kept **beside this skill** — its schema, resolution
rules and validation codes are in [`references/projects-json.md`](references/projects-json.md).

A project with **no directory** is registered with an entry naming none; `taskctl project dir
<project>` says so and succeeds. Do not point it at a directory "so the command works".

A project **absent** from the file has no registered directory, and the board cannot supply
one. Do not guess. When a step needs the directory, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

Work that needs no directory (claiming, moving, commenting, delivering) is unaffected.

## Keeping the brief fresh

A card exported into a project directory is a **snapshot**. Keep it fresh by registering it
with the local event hub once; the command returns immediately and the hub — not your shell —
owns the board connection:

```bash
taskctl export watch <ref> --dir <project-dir> --detach
```

This works the same in every harness: the CLI starts the hub detached (a new session), so a
harness that tears down its command's process group at the end of a turn cannot kill it. Do
not run the watcher with a plain shell `&`. Check it with:

```bash
taskctl export watch <ref> --dir <project-dir> --watch-status
```

and stop it at closeout with:

```bash
taskctl export watch <ref> --dir <project-dir> --stop
```

If the hub cannot run in your sandbox, `--watch-status` says so; fall back to the portable
one-shot at phase boundaries and before a resume:

```bash
taskctl export watch <ref> --dir <project-dir> --once
```

A detached registration is persisted and resumes if the hub restarts; `--ttl` (default 2
hours) and `--stop` bound it. Pass a larger `--ttl` (or `0` to disable it) for a task
expected to outlive two hours. Either form writes `<project-dir>/.meerkat/<identifier>/card.md`
and re-renders it whenever the board changes that card (`comment_added`, `task_updated`, a
move, an attachment, …). It stops refreshing once the card reaches `done` (writing the final
brief first). A card that stops at `in_review` is not done yet: stop the registration when
the session ends, and start a new one if a done card is reopened. The watcher is one-way: it
refreshes the file, it does not wake you, so re-read the brief before a decision or a resume.

**Do not start one when the `meerkat-loop` supervisor dispatched you**: its `--subscribe`
daemon already follows the same hub and refreshes active queued briefs, and a second watcher
is duplicated traffic. Either way `card.md` is machine-generated — never hand-edit it. The
command's output and exact flags are in
[`references/cli.md#export-watch`](references/cli.md#export-watch).

## Where to look

| You need… | Read |
|---|---|
| a status, transition, guard, delivery round, claim window, refusal code, or the board's workflow plan | [`references/status-lifecycle.md`](references/status-lifecycle.md) |
| a command, its flags, exit codes, the `--json` envelope, or the live-stream contract | [`references/cli.md`](references/cli.md) |
| what a reviewer reads and writes, and the two-round model | [`references/review-workflow.md`](references/review-workflow.md) |
| the `taskctl` invocations and JSON keys a supervisor binds to | [`references/capabilities.md`](references/capabilities.md) |
| the `export md` card format, identifier syntax, or `blocked_reason` meanings | [`references/card-schema.md`](references/card-schema.md) |
| how to keep `.meerkat/<identifier>/card.md` current while you work | [`references/cli.md#export-watch`](references/cli.md#export-watch) |
| the project ↔ directory map | [`references/projects-json.md`](references/projects-json.md) |
