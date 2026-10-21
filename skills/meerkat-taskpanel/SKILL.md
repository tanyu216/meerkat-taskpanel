---
name: meerkat-taskpanel
description: Coordinate work across an AI Agent team using a shared local task board. Use when an agent or a human needs to create and track tasks, move them through a status workflow, assign owners, comment on a decision, edit a task's description or its priority, link parent/child and blocking relations, record which agent session is working on what, deliver a task with a report, write a periodic (daily / weekly / monthly) report with statistics over completed work, or export the board as markdown. Runs the local `taskctl` CLI; no network required.
---

# Meerkat TaskPanel

A local-first task board for AI Agent teams, driven entirely through the `taskctl` CLI. Each
agent claims a card, heartbeats while it works, comments, and delivers with a report; results
roll up a parent/child tree. This skill is the manual for that surface: the status model, task
management and the board's workflow.

Scheduling is **not** this skill's job. The host-external supervisor is the `meerkat-loop`
skill; this skill never depends on it — only the reverse.

> Paths written as `src/…` or `docs/…` name the taskpanel **source repository**. This skill
> ships only `SKILL.md`, `references/` and `scripts/`; everything you *run* is `taskctl`.

## Running the CLI

From this skill's directory:

```bash
node scripts/run.mjs --help
taskctl --help                              # when a `taskctl` shim is on PATH
```

`scripts/run.mjs` spawns the board CLI with your arguments, pipes stdio and propagates the exit
code. It resolves the CLI in this order, using the first that exists:

1. `$MEERKAT_TASKPANEL_ROOT/src/cli/index.mjs`;
2. `$MEERKAT_TASKPANEL_REPO/src/cli/index.mjs` (recorded by `install.sh`);
3. the checkout this skill sits in;
4. the `taskctl` shim `install.sh` writes beside this skill (`<host>/bin/taskctl`);
5. `taskctl` on `PATH`.

Rung 4 carries your identity: the shim passes `--actor-kind <host>` and a default `--agent
<name>` on every call. `--actor-kind` is required on every command except `--help` /
`--version`; a team passes `--agent jobs` / `linus` / `turing` to override the default, and a
human uses `--as-human`. The identity is a per-host default, not shared config.
`taskd`/`taskctl` read the install-root `.env` for the board URL, token and server policy
(the process environment wins key by key); `--env-file` / `MEERKAT_TASKPANEL_ENV_FILE` selects
another file. If no board is running, `taskctl` starts one (set `TASKD_NO_AUTOSTART=1` to
forbid that).

## The status workflow

A card has **eight stored status words**, but only **seven are stages** (the board's columns):
`backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`. `awaiting` is an
**attention overlay** — a card parked on a human question, shown under `in_progress`. `done`
and `canceled` are terminal, with one audited exit: reopen to `todo`
(`issue reopen <ref> --reason "<why>"`). Reopening starts a new delivery round; a review card
cannot be reopened — reopen the card it reviews.

Only these moves exist; every other pair is refused (`INVALID_TRANSITION`, or `TERMINAL_STATE`
out of a terminal card):

<!-- status-whitelist:begin -->
```text
backlog     → todo, canceled
todo        → backlog, in_progress, blocked, canceled        (an epic also → in_review)
in_progress → in_review, blocked, todo, canceled, awaiting
awaiting    → in_progress, canceled
in_review   → done, in_progress, blocked
blocked     → todo, in_progress, in_review, canceled
done        → todo
canceled    → todo
```
<!-- status-whitelist:end -->

A legal edge can still be refused. Seven rules decide it:

1. **`in_review` needs evidence for the current round.** A `delivery` report — or the audited
   `--no-report --reason` (≥ 8 characters) — for the card's current `delivery_round`; imported
   reports never count. Leaving `in_review` for `in_progress` or `blocked` starts a new round
   and voids the old report. Use `issue deliver` — report and move in one transaction.
2. **`done` is acceptance, and only from `in_review`.** Under the default policy an agent is
   refused (`ACCEPTANCE_FORBIDDEN`) on a **top-level** card; a **child** card is the opposite —
   only a non-human writer closes it. A human closing a top-level card needs the current
   round's review cards resolved (`REVIEW_PENDING`).
3. **`awaiting` has one entrance and two exits.** Only `in_progress → awaiting`, naming
   `E1`–`E5`; only `awaiting → in_progress` (a human replied) or `awaiting → canceled`. It
   cannot reach `in_review` or `done`.
4. **`blocked` is not `awaiting`.** `--blocked-reason` is optional and cleared on exit.
   `in_review → blocked` is a rework and starts a new round; `blocked → in_review` is a legal
   delivery edge.
5. **A container never reaches `done` by itself.** An epic cannot be claimed; the board starts
   it and closes it to `in_review`. A parent cannot enter `in_review` or `done` while any
   child is non-terminal (`CHILDREN_OPEN`).
6. **The claim follows the status.** Held in `in_progress`, `awaiting`, `in_review` and
   `blocked`; released on `todo`/`backlog`/`done`/`canceled`. `todo → in_progress` is a claim;
   a rework keeps the executor.
7. **Reopening needs a reason.** `done`/`canceled → todo` is the only terminal exit:
   `issue reopen <ref> --reason "<why>"` (≥ 8 characters) records `task_reopened`, starts a new
   delivery round, clears the archive and releases the idem key. `in_progress` is not a reopen
   target, and a review card is refused — reopen the original.

The full model — every guard in evaluation order, the round table, claim windows, the
acceptance policy × scope matrix, the creation gate and the refusal codes — is in
[`references/status-lifecycle.md`](references/status-lifecycle.md). Command detail is in
[`references/cli.md`](references/cli.md).

## Claiming work (claim-first)

Read the claimable set for *you*, then take exactly one:

```bash
taskctl issue candidates --assignee <me>   # read-only: what may I claim?
taskctl issue move <ref> in_progress       # take exactly one
```

Do **not** claim a card that is any of these — it is not yours:

- **assigned to someone else** (the board refuses; it is never silently reassigned);
- in **`backlog`**, not released for work (only the dispatcher or a human moves it to `todo`);
- an **`epic`** — a container, not a unit of work; claim its leaf children;
- a **deployment card** (`kind: deploy`) — dispatched explicitly, never auto-claimed;
- waiting on a **`depends_on` blocker that is not `done`** (a `canceled` predecessor withholds
  it too). The candidates read withholds the last three; the claim verb does not re-check
  blockers — use `taskctl relation list <ref>` when a card you expected is missing.

Hold **one card at a time**, keep its claim fresh, deliver with a report, and stop at
`in_review` — acceptance is somebody else's act.

```bash
taskctl issue heartbeat <ref>              # at least every 10 minutes while you work
```

It resets the heartbeat and **nothing else** — not status, not claimer, not the delivery
round — and only the holder may send it. A claim you stop pulsing reads as abandoned.

### Read the acceptance list before you work

`issue get <ref>` omits the description and the acceptance list; read the JSON:

```bash
taskctl issue get <ref> --json     # description, labels, meta.acceptance, meta.acceptance_legacy
```

- **`meta.acceptance` is non-empty** — that is the list you work to. Do not rewrite it. A
  reviewer's rejection may add an item: re-send the whole existing list plus the new one.
- **`meta.acceptance_legacy` is non-empty** (an imported card) — use it as-is; the checkboxes
  are the author's intent, not evidence. If more items are needed, ask:
  `issue move <ref> awaiting --awaiting-reason E2`.
- **Both are empty** — before writing code, derive **1–6 concrete, externally checkable**
  items (usually 2–6; never pad) from the title, description, labels and comments, then
  persist them once:

```bash
taskctl issue update <ref> --acceptance "…" --acceptance "…" \
  --meta acceptance_derived=yes
taskctl comment add <ref> --kind change \
  --body "acceptance list derived at claim: 1) … 2) …"
```

Never derive on an **epic** (its acceptance is its children) or on a **review card**. If the
card is too thin to yield checkable items, do not invent them:
`issue move <ref> awaiting --awaiting-reason E2`. Say in the delivery report that the list was
derived when it was.

## When the card is a container (promote it to an epic)

A card filed from the web UI is always a `task`; an epic exists only where someone named one.
When the card holds several deliverables, make it the container **before** working any of them:

```bash
taskctl issue update <ref> --kind epic
taskctl comment add <ref> --kind change --body "split into N cards: …"
taskctl issue create --project <p> --title "…" --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

Facts that decide that order:

- **An epic can never be claimed** (`not_claimable`), so a card that must end up
  `in_progress` is claimed **while it is still a `task`**, then promoted.
- **The board starts it:** the first child to enter `in_progress` moves the container
  `todo → in_progress` (a board move with an `epic_auto_start` activity).
- **The board closes it:** when every child is terminal with at least one `done`, the board
  writes the rollup report (one line per child, carrying the child's own delivery evidence)
  and moves the epic to `in_review`. A `canceled` child does not block the close and is
  listed as `not_applicable`; write its cancellation reason as a comment on that child.
- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source +
  target, so two children for one owner with nothing to tell them apart are the *same card*
  (the second create is read as a retry). Use `--allow-dup` when a target does not apply.
- **`issue create --parent <epic>` links nothing** — only `relation add … --type parent` does.
- **Nothing delivered stays open:** if every child was canceled or waived, close the container
  by hand (`report template` → `issue deliver`).
- **The container rests in `todo`** until its first child starts; it is never claimed.
- **`issue reconcile` is the backstop, not a step you owe** — `--dry-run` reports the plan,
  the plain form applies it, and both are idempotent.

### Choose the container before you split

First decide what the card *is*: if its title and description name the **sum** of the work it
is the container; if they name **one deliverable** it is a child of that container.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (above) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card as a child (or `related` for history) |
| a review card, or a `deploy` card | — | do **not** promote; split a separate container |

Promotion is only for a card that has **not delivered its current-round report**. The rollup
collects the **children's** delivery reports, not the container's own history, and a terminal
container never rolls up — promoting a card that already delivered strands every child attached
after it. A card that has delivered starts a *new* container instead.

Before you write, check the shape: all children in the same project; at most **8** direct
children; at most **8** nodes on a parent chain; an ancestor and a descendant may not `blocks`
each other; a child has exactly one parent.

The promoted card keeps its status. A `backlog` or `awaiting` epic does not auto-start or
auto-close — move it to `todo` (or `in_progress`) first. An `in_review` epic that gains a child
must be moved back to `in_progress`; the board will not roll it up from `in_review`.

Claim exactly **one** child and work it as usual; the container holds no work of its own.

## Finishing

```bash
taskctl report template <ref>                 # fill the TODO lines
taskctl issue deliver <ref> --report-file -   # report + move to in_review, one transaction
```

The board refuses `in_review` without a report for the current round (`REPORT_REQUIRED`) and
prints the exact fixing command. `--no-report --reason "<why>"` (≥ 8 characters, mutually
exclusive with `--report-file`) is the audited waiver for one round. Never move a **top-level**
card to `done` yourself; a **child** card is closed by a non-human writer. See
[`references/status-lifecycle.md`](references/status-lifecycle.md#7-acceptance-policy--scope).

## Asking a human, or blocked

- A question for a person is **`awaiting`**, not `blocked` and not a chat message:
  `issue move <ref> awaiting --awaiting-reason E3`. The reason must be `E1`–`E5`
  (scope · acceptance baseline · design direction · security · architecture). Resume with
  `awaiting → in_progress` — the same attempt, no new delivery round. Put the question in a
  comment.
- **`blocked`** is for everything else. `--blocked-reason` (optional; `clarify`, `decision`,
  `dependency`, `out_of_bounds`, `defect`, `external`, `resource`, `unknown`) records what it
  waits for and is cleared on exit. See
  [`references/card-schema.md`](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

## Coordination rules

- **Never force a conflict.** On `VERSION_CONFLICT`, or a claim that looks stale, re-read the
  card once and retry from the fresh state with the current `--if-version`. Blind retries are
  how two agents overwrite each other.
- **Stamp every write with your identity:** `--actor-kind <host> --session-id <id>`. The
  session id is what turns a card back into "which conversation did this", and lets a resumed
  session re-attach instead of starting over. `--actor-kind human` is reserved; a human write
  uses `--as-human`. To know the id before the session starts, `taskctl session id <ref> --seg
  <seg> --owner <name>` derives it without registering. With no board reachable,
  [`scripts/session-id.mjs`](scripts/session-id.mjs) computes the same value from the resolved
  task UUID (`--task-id`, from `issue get <ref> --json` → `data.task.id`).

## Owning the clock

The board runs no timer. On a host with the loop installed, the `meerkat-loop` skill owns the
scheduler — do not add a second poller or schedule its entries yourself. A host or service
that owns its own timer drives the board directly; one tick is:

```bash
taskctl --json issue candidates --assignee <agent> --include-unassigned --stale
taskctl --json issue claim <ref>                       # atomic; the loser starts no worker
taskctl issue heartbeat <ref>
taskctl --json issue list --status in_progress --limit 500   # slow pass: stuck claims
```

The workflow decisions are the board's: `taskctl issue reconcile --workflow` returns the
review/dispatch plan, and the loop only executes it. Bind scripts to `error.code` and
`error.hint.command`, never to prose (see [`references/cli.md`](references/cli.md#--json)).
Use one launcher (`scripts/run.mjs`); in cron name an absolute `node` with a real `PATH`; let
`taskd` start once and be reused rather than restarted per tick.

## Configuring project directories

**The board holds no directories.** The only answer to "which directory does work for this
project happen in" is `projects.json`, kept **beside this skill** (next to `SKILL.md`). Add
one entry per project:

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" },
    { "run_dir": "/Users/you/ops-inbox", "project": "Ops" },
    { "project": "Community" }
  ]
}
```

`project` is the board project's **id** (preferred) or name. `local_path` is its own directory
(absolute, existing); `run_dir` is where a worker starts for a project that has none;
`dir = local_path ?? run_dir`. Both are checked — a relative, missing or non-directory path is
as unusable as no entry. A directory resolves to the entry whose `local_path` is it or an
ancestor; the **longest** match wins. `run_dir` never takes part in that direction.

A project with **no directory** is registered with an entry naming none; `taskctl project dir
<project>` says so and succeeds. Do not point it at a directory "so the command works".

A project **absent** from the file has no registered directory, and the board cannot supply
one. Do not guess. When a step needs the directory, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

Work that needs no directory (claiming, moving, commenting, delivering) is unaffected. Schema,
resolution rules, the validation codes and re-install behaviour:
[`references/projects-json.md`](references/projects-json.md).

## Reference

- [`references/status-lifecycle.md`](references/status-lifecycle.md) — statuses, transitions,
  guards in evaluation order, delivery rounds, claim/heartbeat windows, acceptance matrix,
  creation gate, refusal codes, the board's workflow decisions.
- [`references/cli.md`](references/cli.md) — every command and flag, global options, exit
  codes, the delivery gate, the `--json` envelope.
- [`references/card-schema.md`](references/card-schema.md) — the markdown card: frontmatter
  keys, body sections, round-trip rules (`taskctl export md`).
- [`references/reports.md`](references/reports.md) — periodic (daily / weekly / monthly)
  reports and their statistics.
- [`references/projects-json.md`](references/projects-json.md) — the local project ↔
  directory map.
