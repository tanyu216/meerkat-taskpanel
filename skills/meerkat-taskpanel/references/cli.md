# `taskctl` CLI reference

> **Status: implemented (M2).** The surface below is real and is what `taskctl --help`
> prints; it is aligned with **`task-interface v1`** and grouped by the card's vocabulary.

`taskctl` is an **HTTP client** for `taskd`, the local board service. The CLI holds no second
copy of the rules: a refusal is the service's, with the same code, details and repair
command.

> **`src/…` paths below are provenance** — the repository file where a set or rule is
> *defined* (`src/core/domain/status.mjs`, `src/core/domain/enums.mjs`,
> `src/server/main.mjs`). This skill ships only `SKILL.md`, `references/` and `scripts/`;
> those paths are pointers for source readers, not files an installed copy has. Every
> command here is `taskctl`.

```bash
taskctl <group> <command> [options]
```

Global form, and the two flags that always work (they never contact a board):

```bash
taskctl --help
taskctl --version
taskctl --version --json   # {"ok":true,"data":{"version":"1.1.0","schema_version":4}}
```

`--version --json` is the **version leg**: it publishes the provider's contract
`schema_version` — the generation of the API/wire contract this board speaks, the same number
the contract snapshot freezes (`docs/contract.md`) — so a caller detecting drift can read the
provider's own declaration instead of hard-coding one. It needs no board, so it works with
the daemon down. The number moves with the snapshot's layout, not with every contract change:
a new route does not move it, so treat it as a coarse generation marker, not a complete drift
detector.

## Starting the board

If no board is running, `taskctl` starts one (`node src/server/main.mjs`, detached, logging
to `<dataDir>/logs/taskd.log`) and waits for its `/health`. Set `TASKD_NO_AUTOSTART=1` to
forbid that — a missing board then becomes a clear error rather than a surprise process.

The service writes a **runtime pointer** (URL, port, data dir and token file — never the
token itself) so any shell in any directory finds the same board.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Print `{"ok":true,"data":…}` on stdout. Failures print `{"ok":false,"error":{code,message,http,details,hint}}` on **stdout** too, so a pipe needs one stream. |
| `--url <url>` | Board to talk to. Wins over the runtime pointer, and never triggers autostart. |
| `--token <token>` | Access token. Priority: `--token` > `$TASKD_TOKEN` > the pointer's token file > none (loopback needs no token). |
| `--if-version <n>` | Optimistic concurrency: the write is refused with `VERSION_CONFLICT` if the task moved on. |
| `--actor-kind <name>` | The platform (`claude`, `codex`, …). This **is** the identity — there is no separate platform flag. `human` is **reserved and refused**; absent ⇒ `human`. |
| `--as-human` | Write as the configured human (`$TASKCTL_HUMAN`). The one write that is not the agent's own. |
| `--session-id <id>` | Agent session identifier. Requires `--actor-kind` — a session with no kind has nothing to attribute it to. |
| `--agent <name>` | Name the actor. |
| `--version` | Print the release version and exit. With `--json`, print `{"version", "schema_version"}` — the contract schema generation beside it. Never contacts a board. |
| `-h`, `--help` | Help for the CLI, a group, or one command. |

**Exit codes:** `0` success · `1` runtime failure (including the delivery gate) · `2` usage
error · `3` `export md --check` found stale cards.

The token never appears in any output — not in `--json`, not in a warning, not in an error
message.

## Commands

### `project`

| Command | Purpose |
|---|---|
| `project create --id <id> --name <n> [--meta k=v]… [--label <l>]… [--readme <text>]` | Create a project. The id becomes the identifier prefix (`demo` → `DEMO-0001`). |
| `project update <id> [--name] [--meta k=v]… [--label]… [--readme]` | Update it. `--meta` **merges**. |
| `project list [--include-archived]` | List projects. |
| `project dir <id>` | Print the local directory work for the project happens in, resolved from `projects.json` (`--projects-json <path>` or `$MEERKAT_TASKPANEL_PROJECTS_JSON` picks another map): the entry's `local_path`, else `run_dir`. An entry that names no directory is reported and still succeeds. Exits non-zero — asking which directory it should be — only when no entry is registered, or the registered path is relative, missing, not a directory, or blank. |
| `project readme <id>` | Print the readme. |
| `project readme <id> --set <text>` / `--file <path\|->` | Set it. |

**A project carries no directory.** TaskPanel does no project-directory management: no
`--workspace-path`, no `context` command, no board-side field naming a project's target
directory. The local directory→project map is the `projects.json` beside this skill — see
[`projects-json.md`](projects-json.md). `project dir` is that map's read side and is local: it
resolves and validates the path, and **stops to ask** rather than guessing — while an entry
that deliberately names no directory is an answer, not a question. The wake glue resolves the
same map to run a woken worker in the directory it names.

### `issue`

> The **status model** — every status, legal transition and guard — is in
> [`status-lifecycle.md`](status-lifecycle.md). This section is the command surface.

| Command | Purpose |
|---|---|
| `issue create --project <id> --title <t> [--acceptance <text>]… [--assignee <text>] [--reporter <text>] …` | Create a task. |
| `issue list [--project] [--status <s>]… [--assignee-id] [--limit] [--include-archived] [--order board\|weight] [--order-debug]` | List tasks. `--order weight` is the **assignee weight order** (below); the default is the board's deterministic order, so nothing changes unless you ask. |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order board\|weight] [--order-debug]` | The poll's read: claimable cards for an assignee — `todo`, **auto-claimable** (not an `epic`, not a `deploy`), every `depends_on` predecessor `done`; a `canceled` predecessor also withholds the card (the test is literally `status !== "done"`). `--stale` adds the **recovery pool**: `in_progress` cards whose heartbeat is past the 30-minute holder window (`stale_same`) or past the six-hour takeover window for anyone (`stale_any`); `--include-unassigned` adds the **public pool** of unassigned claimable cards, for a supervisor whose policy allows them. Read-only — claiming goes through `issue claim` (or `issue move … in_progress` on a `todo` card). `--order weight` refines the order *within* each claimability bucket, which stays the first key. |
| `issue get <id\|identifier>` | One task, plus `report_waivers[]`. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]…` | Patch. `--status` is refused here on purpose. |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--blocked-reason <clarify\|decision\|dependency\|out_of_bounds\|defect\|external\|resource\|unknown>]` | Move, subject to the delivery gate. A `todo → in_progress` move is a **claim**: only the card's assignee, unless `--allow-steal`. A move to `done` is an **acceptance**: the board's policy and the card's scope decide who may perform it — under the default `both`, a **top-level** card is closed by a `human` or the board (`taskd`) and an agent gets `ACCEPTANCE_FORBIDDEN`; a **child** card is closed by a non-human writer. See [`status-lifecycle.md`](status-lifecycle.md#7-acceptance-policy--scope). `--awaiting-reason` is **required** by a move to `awaiting` — see [The `awaiting` state](#the-awaiting-state--asking-a-human-a-question). `--blocked-reason` is **optional** and records *what* a `blocked` card is waiting for — see [The `blocked` state](#the-blocked-state--what-the-card-is-waiting-for). |
| `issue claim <ref> [--allow-steal --reason "<why>"]` | **Claim, re-claim or take over** — the one claim verb. On a `todo` card it behaves like `issue move <ref> in_progress`; on an `in_progress` card it is the only way to recover a stale claim (`in_progress → in_progress` is not a transition). Only `todo` and `in_progress` are accepted. The holder may re-claim once the heartbeat is **older than 10 minutes**; `issue candidates --stale` offers `stale_same` after **30 minutes**; anyone may take over after **6 hours** or with no heartbeat. A fresh claim by another actor is refused with `EXECUTION_ACTIVE`; `--allow-steal --reason` is the audited exception for a `todo` card assigned elsewhere. A rework is not a claim and is not this command. |
| `issue heartbeat <ref>` | **Pulse a claim you hold**, keeping its heartbeat inside the fresh window so the card does not read as abandoned. Takes no flags of its own — the card is the positional, the pulsing actor is you (global attribution flags). It refreshes `heartbeat_at` and **nothing else**: status and claimer are untouched, so it cannot resurrect a card somebody else moved. Only the holder may pulse — anybody else gets `EXECUTION_ACTIVE`; a card that is not `in_progress` gets `INVALID_TRANSITION` ("nothing to pulse"), and an epic has nothing to pulse either. The pulse is a `task_heartbeat` activity, which the board treats as **noise** (it never wakes an SSE client). |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--force-create]` | Assign. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue deliver <ref> --report-file <file\|-> [--no-report --reason "<why>"]` | **Write the report and move to `in_review`, in one transaction.** The two forms are mutually exclusive. The CLI has no `--to`; it always lands in `in_review`. |
| `issue reconcile [--dry-run] [--workflow] [--reviewer <agent>] [--auto-accept-reviews yes\|no] [--review-aging-ms <n>] [--max-actions <n>] [--board-limit <n>]` | **The container backstop, and the loop's workflow plan.** Without `--workflow`, replays the epic rules over every non-terminal container: start a `todo` epic whose child has entered the work, close an epic whose children are all **terminal with at least one `done`**. `--dry-run` reports the plan and writes nothing. Idempotent; the same sweep runs once at `taskd` startup. With `--workflow`, the board first reconciles (unless dry-run), then returns `workflow: {alerts, actions, changes, summary}` — the review outcomes/dispatch the loop executes. See [`status-lifecycle.md`](status-lifecycle.md#11-the-boards-workflow-decisions). |

### The weight order (`--order weight`)

`issue list` and `issue candidates` take an optional `--order weight` — the **assignee weight
order** (contract `C-WEIGHT-1`). It answers "which of my cards should I look at next?" and is
**opt-in**: the default remains the board's `sort_order, created_at, project_id, identifier`
sequence, so nothing moves until you ask.

It ranks in three passes — a hard *tier* (can I move this card at all?), then a weighted
*score*, then a deterministic tie-break ending on the card's number:

- `T0` cards you can start now → `T1` ones you are stalled on (blocked, or waiting on an
  unfinished `depends_on`) → `T2` ones in somebody else's hands (`in_review`, `awaiting`). A
  tier is never traded against a score: a high-scoring card waiting on a reviewer still sits
  behind one you can start.
- Inside a tier the score is a linear sum of priority, time in the current status, time since
  creation, SLA pressure, and how many unfinished cards this one unblocks — each capped at
  its own saturation point, so a card's score never depends on which other cards are in the
  list.
- Equal scores fall through to priority, then the longest wait, then age, then the board's
  column order, then `project`, then the identifier — a total order, so two runs over the
  same board agree.

`--order-debug` adds the arithmetic card by card, so a rank can be reconciled by hand:
`{ id, identifier, order, tier, tier_name, score, factors: { P, W, S, A, B, L } }`, each
factor with its `raw`, `normalised` and `weighted` value. Asking for it selects the weight
order (there is no board-order projection to return).

**What it does not touch.** `activity` and `waiting` keep their own orders (a timeline and a
longest-waiting queue), and `export --md` keeps the board order byte for byte. Inside `issue
candidates` the claimability bucket — `ready` → `unassigned` → recovery — stays the **first**
key, because it says whether a card can be claimed at all; the weight order only refines
within a bucket.

### Claiming: only the assignee may claim

`issue move <ref> in_progress` on a `todo` card **is** a claim: it takes the execution lock
(`claimed_by` / `claimed_at` / `heartbeat_at`). A card has two roles — the **assignee** (who
it is routed to) and its **claimer** (who is doing it now); normally the same person. A
rework (`in_review`/`blocked → in_progress`) is **not** a claim: it keeps the existing
executor and does not re-check the routing lock. Who may claim:

- **Unassigned** cards are an open pool: any actor may claim them.
- An **epic** can never be claimed (`not_claimable`), and neither can `backlog` — only `todo`
  is claimable.
- A **`deploy`** card *can* be claimed — but `issue candidates` never offers one, so it is
  only reachable by an explicit dispatch (see
  [Deployment cards](#deployment-cards-never-auto-claimed)).
- A card routed to somebody else is refused on this **first claim** with `not_assignee` —
  that code appears **only** on this `todo → in_progress` path:

```console
$ taskctl issue move PROJ-0007 in_progress
not_assignee: PROJ-0007: this task is assigned to somebody else; only the assignee may claim it
try: taskctl issue move PROJ-0007 in_progress --allow-steal --reason "<why>"
$ echo $?
1
```

- `--allow-steal --reason "<why>"` is the **audited** override of the routing lock, valid on
  that first claim only: the reason must be at least 8 characters, and the takeover is
  recorded as a `task_claimed` activity **and** a `kind: change` comment naming the original
  assignee, the new claimer and the reason (`comment list <ref>` shows it).
- Re-claiming an `in_progress` card is governed by the heartbeat's age — the boundary is
  `HEARTBEAT_FRESH_MS` (10 minutes):

  | Heartbeat age | The holder | Anyone else |
  |---|---|---|
  | `≤ 10 min` (fresh) | reuses the claim (`reuse`, nothing reset) | refused — `EXECUTION_ACTIVE` |
  | `10 min … 6 h` | re-claims it, resetting the lock | refused — `EXECUTION_ACTIVE` |
  | `> 6 h`, or **no heartbeat at all** | may take it | may take it — an audited takeover |

  While a claim is less than 6 hours old a non-holder is always refused with
  `EXECUTION_ACTIVE` — never `not_assignee`, and `--allow-steal` does **not** override it.
  Past 6 hours (or with no heartbeat) the claim has rotted and **any** actor may take it as
  an audited takeover (the staleness *is* the reason, so no `--reason` is needed). A
  **rework** (`in_review`/`blocked → in_progress`) is *not* a claim: it keeps the existing
  executor and their lock.
- **Keeping the heartbeat fresh is the holder's own job.** `issue heartbeat` resets only the
  clock, and the board runs **no background pulse** — so a claim whose holder goes quiet
  *should* read as abandoned. (Only the holder may send it; it cannot resurrect a card
  somebody else moved.)

**The lock lasts the whole work cycle.** The claim is held while the card is in
`in_progress`, `awaiting`, `in_review` or `blocked` (`CLAIM_HOLDING_STATUSES` in
`src/core/domain/status.mjs`, predicate `holdsClaim`), and released by the **same write**
that moves it to `todo`, `backlog`, `done` or `canceled`. There is no separate unclaim
command, and because status, timestamps and claim go down in one `UPDATE`, no reader ever
sees a stale claim. The three in-between statuses stay inside the cycle because each can
return to `in_progress`, and the card that returns must still be the same executor's.

**That release also closes the `backlog` CHECK.** With the claim released on the way out,
the schema's `CHECK (claimed_by IS NULL OR status <> 'backlog')` is no longer reachable from
the service (it used to trip on `in_progress → todo → backlog` and surface as a raw
constraint error). The three heartbeat windows (10 minutes fresh, 30 minutes `stale_same`,
6 hours for anyone) and the rework-is-not-a-claim rule are in
[`status-lifecycle.md`](status-lifecycle.md#5-claims-and-heartbeats).

### Deployment cards: never auto-claimed

A **deployment card** — work that runs against a live instance rather than in the repository
(rebuilding `dist`, restarting `taskd`, a full `install.sh` run) — is marked with
`--kind deploy`:

```console
$ taskctl issue create --project PROJ --title "Rebuild dist and restart taskd" --kind deploy
```

`issue candidates` **never offers a `deploy` card**, in any of its three pools (assigned,
public pool, stale recovery): the poll's read is what an agent claims from without a human in
the loop, and a deployment card is high-impact and needs the instance in the right state, so
it is dispatched explicitly. The marker uses the same `kind` mechanism as `epic`, but **only
half** of it:

| | `epic` | `deploy` |
|---|---|---|
| In `issue candidates` | never | never |
| Claimable at all | no — `not_claimable` | **yes**, by an explicit dispatch |

So a `deploy` card is claimed exactly like any other — `issue move <ref> in_progress`, by its
assignee (or `--allow-steal`) — it just will not be picked up on its own. When an expected
card is missing from your candidates and you believe it is deployment work, check `issue get
<ref>`: `kind: deploy` is why it is not there.

### Promoting an existing card to an epic

`kind` is patchable, so a card that turns out to be a container is promoted in place — and it
has to be, because the web UI cannot set `kind`: a card filed from the board UI is always a
`task`.

```console
$ taskctl issue update PROJ-0007 --kind epic
```

Three board facts decide the order you split in:

- **Only an `epic` may be a parent.** `relation add PROJ-0007 --type parent --target <child>`
  is refused `VALIDATION_FAILED` (`details.field: kind`) until the card has been promoted.
- **An epic cannot be claimed.** `issue move <epic> in_progress` is refused `not_claimable`,
  and `issue candidates` withholds epics from all three pools. So a card that must end up
  `in_progress` has to be claimed **while it is still a `task`**, and promoted afterwards.
- **An epic's route into review is its own.** `todo → in_review` *is* a transition for an
  `epic` — a container is never claimed, so its `todo` row carries the delivery edge a task's
  lacks, and `issue deliver PROJ-0007 --report-file -` closes it from there. A `task` in
  `todo` still reaches only `backlog`, `in_progress`, `blocked` and `canceled`; the exception
  is scoped to the kind. `done` is reachable only from `in_review` in both. A container
  waiting on something external is still parked with
  `issue move PROJ-0007 blocked --blocked-reason dependency` (visibility only; the SLA
  patrol gives it no due point) — a statement about the container, not a way around the
  state machine.

Linking a child is its own command: `issue create` writes no relation, and its `--parent` flag
fills the **idempotency key's source slot** and nothing else. A child created with `--parent
PROJ-0007` is not linked to PROJ-0007.

```console
$ taskctl issue create --project PROJ --title "…" --target <t> --assignee <owner>   # the child
$ taskctl relation add PROJ-0007 --type parent --target PROJ-0008                   # the edge
```

Give each child its own `--target`. The create guard keys on kind + assignee + source +
target, so a second create repeating all four is read as the **same request retried** and
returns the existing card rather than a sibling — `--allow-dup` is the escape when a target
genuinely does not apply.

The promotion is an ordinary patch: it bumps `version`, writes one `task_updated` activity
naming `kind`, and changes nothing else — `status`, the claim, the heartbeat and
`delivery_round` stay put, and the `idem` key (frozen at create, kind in its first slot) is
**not** rewritten. It leaves no comment, so write the split down yourself (`issue update
--description` for the container's intent, `comment add --kind change` for what you cut it
into). Caveat: `issue update` does not forward `--if-version`, so a promotion cannot be made
race-safe from the CLI; re-read the card if that matters.

Only the **downgrade** is fenced: an epic that still has children cannot go back to `task`
(`VALIDATION_FAILED`, "an epic with children cannot be downgraded"). Remove the `parent` edges
first if you really meant to undo it.

The container **closes itself**: when every child is finished (`done` or `canceled`) and at
least one is `done`, the board writes the rollup report — one acceptance line per child,
carrying the children's own delivery evidence — and moves the epic to `in_review` in the
same transaction. A `canceled` child is terminal and does not block the close; its acceptance
line is `not_applicable`, with the cancellation reason taken from its newest comment. The
delivery gate applies exactly as for a leaf, and the result is still `in_review`: the loop's
independent reviewer (or a human, when none is configured) accepts to `done` — which is also
why a nested container's parent waits for its child container to reach `done`.

A container with **nothing delivered** stays open: every child canceled, or every delivered
child waived under `--no-report` (no evidence to roll up). Close that one by hand (`report
template` → `issue deliver`). `issue reconcile` reports a close-refusal with the children
that caused it — `identifier` and `status` — so a sweep that does nothing still says which
card is holding the container open.

### The delivery gate

A card may not enter `in_review` without a report **for the current delivery round**. Leaving
`in_review` (except to `done`) starts the next round, so last round's report — or waiver —
is history, not evidence.

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
$ echo $?
1
```

The **compliant path is the short one**: `issue deliver` writes the report and performs the
move atomically, and `report template` prints a report `deliver` accepts without editing.

The second line is the **audited waiver** (F-B1). It is not a bypass: the reason must be at
least 8 characters, the waiver is stamped on the task row, and a `report_waived` activity is
recorded — `issue get` shows it in `report_waivers[]`. The round table (which exits bump the
round), the waiver's per-round lifetime and the `blocked → in_review` delivery edge are in
[`status-lifecycle.md`](status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round).

### The `awaiting` state — asking a human a question

A card that needs an answer from a person is **not** `blocked`, and not a chat message: it
moves to `awaiting`, a **first-class status** (M1). The card is still *running* — stopped on
a question — so `awaiting` is **not** terminal, and entering or leaving it **does not start a
delivery round**. It is a pause inside the attempt, not a delivery coming back.

**Entering it — one path, and it must name itself.** `in_progress → awaiting` is the **only**
entry; no other status may reach `awaiting`. The move **requires** the reason flag:

```bash
taskctl issue move PROJ-0007 awaiting --awaiting-reason E3
```

Without it the CLI refuses the move as a **usage error** — exit `2` — before sending anything
to the board:

```console
$ taskctl issue move PROJ-0007 awaiting
CLI_USAGE: issue move: `awaiting` needs --awaiting-reason <E1..E5>
fix: E1 scope · E2 acceptance baseline · E3 design direction · E4 security · E5 architecture
$ echo $?
2
```

The service enforces the same rule behind the CLI: a move reaching it without a usable reason
is refused with `VALIDATION_FAILED` (`details.field` is `awaiting_reason`, `details.allowed`
the vocabulary).

**The vocabulary is `E1..E5`** — the *category* of question, never free text, so the board
can group what waits on the human:

| Code | The question is about |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

Any other value — free text, an empty string, a missing flag — is refused. The set is
`AWAITING_REASONS` in `src/core/domain/enums.mjs`; nothing else defines it.

**Leaving it — one way back, plus cancel.** `awaiting → in_progress` is the only way back
into the work, and it means *a human replied*: a **resume of the same attempt, not a
rework**, so the delivery round is not advanced and the current round's report is untouched.
`awaiting → canceled` is allowed (the human cancels). `awaiting → blocked` and `awaiting →
in_review` / `done` are **forbidden** — the last is a delivery-gate bypass: it would reach
`in_review` without the round's report.

**The reason lives on the card.** Entering `awaiting` stamps `awaiting_reason`; **leaving
clears it** to `null`, in the same write as the status change — so the column is non-null
*exactly* while the card is `awaiting`, and a resumed or canceled card never keeps a stale
category. `--json` carries it on the task object beside `status` (see below).

**Reading it.** `issue list --status awaiting` lists the cards parked on a human. The web
board's **waiting** view is that same set, each row carrying the entry category as a badge
(localized `waiting.reason.E1..E5`). The transition rules — one entrance, two exits, no route
to `in_review`/`done` — are in
[`status-lifecycle.md`](status-lifecycle.md#3-the-guard-on-each-edge).

### The `blocked` state — what the card is waiting for

`blocked` is the *other* stop, and a different statement: the card cannot proceed on its own,
but nobody has been asked a question. The status already said that much; `blocked_reason`
says **what** the card waits for, so an operator scanning the board — or the SLA patrol —
need not open the comment trail and guess.

**Writing it is one optional flag on the move.** `--blocked-reason` may accompany a move whose
destination is `blocked`:

```bash
taskctl issue move PROJ-0007 blocked --blocked-reason dependency
```

Unlike `--awaiting-reason`, it is **not required**: a card blocked for a reason the writer
cannot classify — or did not state — is legal, and the inspector reads an unset value as
`clarify`. The only refusal is a value that is not one of the literals.

**The vocabulary is eight words** — the *class* of the block, never free text:

| Value | The card is waiting on |
|---|---|
| `clarify` | a clarification (the default the inspector assumes when unset) |
| `decision` | a decision that has not been made |
| `dependency` | another card, or another team, to land |
| `out_of_bounds` | something outside this card's remit |
| `defect` | a bug elsewhere that has to be fixed first |
| `external` | a third party (a vendor, an upstream service) |
| `resource` | a machine, an environment, or a budget |
| `unknown` | there *is* a block, and it cannot be classified |

`unknown` is deliberately **not** the spelling of "no reason": it is a writer saying there is
a block they cannot classify, while an absent value says the writer stated none. The set is
`BLOCKED_REASONS` in `src/core/domain/enums.mjs`; nothing else defines it. Any other value —
free text, an empty string — is refused with `VALIDATION_FAILED` (`details.field` is
`blocked_reason`, `details.allowed` the vocabulary). Surrounding whitespace is trimmed and
nothing else: `Dependency` is not `dependency`.

**The reason lives on the card, and only while it is blocked.** Entering `blocked` stamps
`blocked_reason`; **leaving clears it** to `null`, in the same write as the status change —
so the column is non-null *exactly* while the card is `blocked`, and a reworked or canceled
card never keeps a stale class. A flag passed on a move to any other status is simply not
read. `--json` carries it on the task object beside `status`, and the card's own history
keeps the class on the `task_moved` activity, so the trail still says why after the column is
cleared.

The field is documented on the card itself in
[`card-schema.md`](./card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for),
including how a value that is not a literal survives a markdown import. The transition rules
— `in_review → blocked` bumps the delivery round; `blocked → in_review` is a legal delivery
edge — are in [`status-lifecycle.md`](status-lifecycle.md#3-the-guard-on-each-edge).

### `reconcile --workflow` — the board's workflow plan

`issue reconcile --workflow` is the loop/operator channel, not a worker's normal path. It
performs the board's own container reconcile (unless `--dry-run`) and returns the review
decisions the loop applies:

```bash
taskctl issue reconcile --workflow --reviewer jobs --auto-accept-reviews yes \
  --review-aging-ms 3600000 --max-actions 20 --board-limit 500 --json
```

`--json` returns `{dry_run, scanned, actions, workflow}`, where `workflow` is `{alerts,
actions, changes, summary}` in snake_case. `--board-limit` bounds the board snapshot; a
truncated snapshot still applies outcomes but dispatches nothing. The `actions` are decisions
(`create_review`, `approve`, `approve_hold`, `reject_task`, `reject_epic`,
`reject_task_finish`, `close_review`, `cancel_review`); the board writes none of them. The
loop executes them and closes the review card last. Without `--workflow`, the command is the
container backstop only, and the response is unchanged.

The decision rules — dispatch, verdict handling, fail-safe alerts, one review card per
`(original, round)`, and the acceptance matrix — are in
[`status-lifecycle.md`](status-lifecycle.md#11-the-boards-workflow-decisions).

### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | Oldest first. |
| `comment add <ref> --body <text> [--kind discuss\|decision\|confirm\|change\|note\|defect] [--file <path\|->]` | Append. |

Append-only: there is no edit and no delete, by design.

### `relation`

| Command | Purpose |
|---|---|
| `relation add <ref> --type parent\|blocks\|related --target <ref> [--force]` | Add an edge. For `parent`, **the task you name is the parent** and only an `epic` may be one — promote the card first (§Promoting an existing card to an epic). |
| `relation remove <ref> <relation-id>` | Remove it. |
| `relation list <ref>` | Edges, children, ancestors, blockers. |

### `attachment`

| Command | Purpose |
|---|---|
| `attachment add <ref> --file <path> [--name <filename>] [--content-type <type>]` | Upload a file: the metadata row first, then the bytes. |
| `attachment list <ref>` | A card's files — `id`, `filename`, `size`, `type`. Empty reads `no attachments`, not an error. |
| `attachment remove <attachment-id>` | Remove a file **for good**: the row and the bytes together. |

`add` reads the file from **your** disk (`CLI_IO` when it cannot), and refuses one over 8 MiB
(`ATTACHMENT_TOO_LARGE`) before opening a socket. The stored name defaults to the file's
basename and the type to what the extension names; both are overridable, and a type outside
the board's closed set is refused on both sides. **Download has no command** — the bytes are
a plain `GET` of the content URL. The whole story, including the limits, is under
[attachments](#attachments--two-requests-and-a-hard-delete).

### `session`

| Command | Purpose |
|---|---|
| `session set <ref> --seg <seg> --backend <name> [--owner] [--phase] [--pid]` | Register (the id is derived from `task, owner, seg`, so a resume keeps it). |
| `session close <ref> <session-id> [--failed]` | Close it. |
| `session list <ref>` | List them. |

### `actors list`

A read-only dictionary, with `--query <text>` and `--limit <n>`. Every row carries
`display_name` **and** `id`.

There is **no** `actors add`, `actors rm` or `actors rename` — not "unimplemented", but
absent: the dictionary grows when a task names somebody new (`--assignee "<text>"`), and that
is the whole interface.

Names resolve in the same transaction as the task write: an exact or unique prefix match is
reused (the dictionary's spelling wins); several matches are refused with `DICTIONARY_AMBIGUOUS`
and the candidates listed; `--force-create` skips the fuzzy step; `--assignee-id` bypasses
the dictionary entirely.

### `report`

| Command | Purpose |
|---|---|
| `issue meta <ref> --meta <k>=<v>…` | Merge metadata keys into a card, leaving every other key (and its value type) intact. The PATCH route merges `issue update --meta` too; `issue meta` is the read-modify-write form with `--if-version` CAS, used for the loop's own markers. |
| `report list <ref> [--round <n>]` | List a card's delivery reports (round, author, conclusion), newest round last. This is how a reviewer reads the report it audits; `issue get` carries only the task and its waivers. |
| `report template <ref> [--commit <sha>] [--path <p>]… [--command <cmd:exit>]… [--coverage <pct[@scope]>]…` | Print a report to fill in. |

The template is built from the card: `meta.acceptance` (what `--acceptance` writes), then the
imported card's `meta.acceptance_legacy` checkboxes, then an empty list with a warning. Every
item starts **`not_met`** — a ticked box on an imported card is the author's intent, not this
delivery's evidence — and `leftovers` gets a `TODO:` placeholder so the shape is valid.

Evidence anchors are explicit flags first, then a read-only `git rev-parse HEAD`, then the
task's `source_path`, then a placeholder you must replace. It never fails because git is
missing (a container has no `.git`).

### The acceptance list

`meta.acceptance` is the card's acceptance list (`string[]`), written by `issue
create/update --acceptance` and replaced wholesale by `issue update`. Imported cards carry
`meta.acceptance_legacy` instead; `report template` reads both. `meta.acceptance_derived=yes`
is a marker, not policy: it records that an agent derived the list at claim because the card
had none, and `report template` warns when it sees it. A human rewriting the list can set
`acceptance_derived=no`; `issue update --meta` merges keys, so one update can write both the
list and the marker.

### `export`

| Command | Purpose |
|---|---|
| `export md [--out <dir>] [--project <id>] [--check]` | Write one markdown card per identifier. |

`--check` writes nothing and exits **3** when any card is missing or differs — the same
convention `migrate-cli check` uses. `taskctl export --md` is accepted as the same command.

The service renders and the CLI writes: `POST /api/v1/export` returns markdown and never
touches a path the caller named.

### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | Rotate the access token. **Loopback only** (403 `loopback_only` otherwise). |

Prints `td_****` and the token file; `--show` prints the value and says what it just did.

## Editing a card: status, priority, description, attachments, dependencies

A card's detail view offers five edits — `status`, `priority`, the markdown `description`,
attachments (download / upload / remove) and `depends_on` (add / remove). They do **not**
share one shape: two are a single flag, one is a **move**, one is a **two-request upload**,
and one is an indirection through relations.

The two columns below are kept apart on purpose. **Board (HTTP API)** is what the service can
do; **`taskctl`** is what a caller can type. All five are reachable from the CLI; the one
place it is still the narrower client is attachments — the writes have commands, the
**download** does not.

| Capability | Board (HTTP API) | `taskctl` |
|---|---|---|
| **`status`** | **supported** — but the write path is a **move**: `PATCH {status}` is refused (`INVALID_TRANSITION`, "status is not a patchable field — use move or deliver") | **supported** — `issue move <ref> <status>`; `issue update` has no `--status` |
| **`priority`** | **supported** — `PATCH /api/v1/tasks/:ref {"priority": …}` | **supported** — `issue update <ref> --priority <p>` |
| **`description`** (markdown) | **supported** — `PATCH {"description": …}`, stored as opaque text | **supported** — `issue update <ref> --description <md>` |
| **attachments** | **supported** — a row (`POST`/`GET /api/v1/tasks/:ref/attachments`, `DELETE /api/v1/attachments/:id`) beside the bytes (`GET`/`PUT /api/v1/attachments/:id/content`) | **half** — `attachment add` / `list` / `remove`; **download** has no command (read the content URL over HTTP) |
| **`depends_on`** | **half** — carried by a `blocks` relation; the task object has no such field | **half** — `relation add` / `remove` / `list`, with the direction reversed |

**The board's web drawer is a second client of the same API.** It can do nothing the API
does not offer and inherits the API's refusals — which is why the `status` row reads the same
for both. Its attachment area lists the **same `attachments` table** `attachment list` reads
(see [attachments](#attachments--two-requests-and-a-hard-delete) below) — one source of
truth, so drawer and CLI cannot disagree about what a card carries.

### `status` — a move, never a patch

```bash
taskctl issue move PROJ-0007 blocked
taskctl issue move PROJ-0007 in_progress         # todo → in_progress is the claim
taskctl issue deliver PROJ-0007 --report-file -  # report + move to in_review, in one transaction
```

`status` is deliberately **not** a patchable field: the move path carries the state machine,
the delivery gate and the claim lock, so a status write cannot side-step any of them. `issue
update` therefore has no `--status`, which costs a usage error rather than a round trip:

```console
$ taskctl issue update PROJ-0007 --status blocked
CLI_USAGE: issue update: unknown option --status
fix: run `taskctl issue update --help` to see the options it accepts
$ echo $?
2
```

A move can still be refused — always by the service, always in the CLI's one error shape:

- a status that is not a legal transition → `INVALID_TRANSITION`, whose `details.allowed`
  lists the statuses that are;
- `in_review` without a report for the current delivery round → `REPORT_REQUIRED`, and the
  hint prints the exact `issue deliver` command that fixes it (see *The delivery gate*
  above);
- `awaiting` without `--awaiting-reason E1..E5` → refused locally, exit `2` (see *The
  `awaiting` state* above).

`issue create --status <s>` sets the status at creation. A `task` may start in `backlog`,
`todo`, `blocked` or `canceled`; `in_progress` and `awaiting` are `VALIDATION_FAILED`, and
`in_review` / `done` are `REPORT_REQUIRED` (there is no evidence yet). An `epic` may start
only in `backlog` or `todo`. The HTTP form is `POST /api/v1/tasks/:ref/move` with `{"to":
"<status>"}`; the creation table is in
[`status-lifecycle.md`](status-lifecycle.md#8-creating-a-card-in-a-status).

### `priority` — one flag, one closed set

```bash
taskctl issue update PROJ-0007 --priority high
taskctl issue create --project PROJ --title "…" --priority urgent
```

The vocabulary is a closed set — `low`, `medium`, `high`, `urgent` (`PRIORITIES`,
`src/core/domain/enums.mjs`) — matched case-insensitively. Anything else is refused with
`VALIDATION_FAILED` (HTTP 400, `details.field` = `priority`). A card with no priority reads
as `medium`.

There is no gap on either side: `PATCH /api/v1/tasks/:ref` with `{"priority":"high"}`, and
`POST /api/v1/tasks` accepts it at creation.

### `description` — markdown as opaque text

```bash
taskctl issue update PROJ-0007 --description "$(cat findings.md)"
taskctl issue create --project PROJ --title "…" --description "one-line summary"
taskctl issue update PROJ-0007 --description ""   # an empty value clears the field
```

The board stores and returns the string **byte for byte**. It does not parse, validate or
render markdown, so a markdown mistake is never a board error — the *web client* renders
it. An agent is therefore writing markdown for a renderer it cannot see; that, not any
server-side rule, is the real limit of this path. The column has no length cap.

`issue update` takes the text as the flag's value and has no `--file` form, so a long body
goes through the shell as above — or through the markdown card, the same write by another
door:

- `taskctl export md` writes the description as the card's `## Background` section (see
  `references/card-schema.md`);
- importing that card maps `## Background` back to the description, and a re-import patches
  an existing card rather than skipping it;
- `issue update --description` sends exactly `PATCH /api/v1/tasks/:ref`, the HTTP form of the
  same write.

### attachments — two requests, and a hard delete

```bash
taskctl attachment add PROJ-0007 --file ./shot.png       # name and type from the file
taskctl attachment add PROJ-0007 --file ./notes --name notes.txt --content-type text/plain
taskctl attachment list PROJ-0007
taskctl attachment remove 3f1c9a2e-…                     # the id `list` prints
curl -sO http://127.0.0.1:7788/api/v1/attachments/3f1c9a2e-…/content   # download: API only
```

**Upload is two requests, deliberately.** `attachment add` first mints the metadata row
(`POST /api/v1/tasks/:ref/attachments`, returning the id and an `upload_url`), then stores
the bytes (`PUT /api/v1/attachments/:id/content` — the one request on this board that is not
JSON). A one-shot route would need a body that is both JSON and bytes; the seam is instead
**named**: a row whose `PUT` never arrives holds no bytes and answers an honest `404` on
download — its `size` is whatever the create declared (`0` if none) — so nothing is invented.
`attachment add` does both halves in one command, and the board's drawer rolls the row back
when the second half fails.

**Removal is a hard delete, and one act.** `attachment remove` deletes the row **and** the
bytes in a single transaction holding the write lock — so every refusal leaves the board as
it was. An attachment is **not recoverable**; re-uploading is the whole recovery story (the
ruling is recorded in `src/server/routes/attachments.mjs`). The argument is the attachment's
**id**, not the card reference, because one card can carry several files.

**Download is where the CLI stops.** There is no `attachment download`: the bytes are a `GET`
of the content URL, and every response is a download, never a document the board's origin
renders — `content-disposition: attachment` plus `x-content-type-options: nosniff` and
`cache-control: no-store` (so a removed attachment cannot survive in the client's cache)
carry that boundary. A row with no stored bytes is a truthful `404`, not an error.

**The write limits, shared rather than restated.** `src/shared/attachments.mjs` is the one
place they are decided, and both the CLI and the board call it, so the CLI cannot drift from
the board it uploads to:

- a single request body is capped at **8 MiB** (`ATTACHMENT_MAX_BYTES`; over it, `413`
  `ATTACHMENT_TOO_LARGE`) — a *different* cap from the 1 MiB JSON routes. The CLI checks
  before opening a socket, and the board refuses an oversized raw body on its own side;
- `content_type` is a **closed set** (`ATTACHMENT_CONTENT_TYPES` — text, JSON, PDF, archive,
  image and office types). A type outside it is refused with `422`
  `ATTACHMENT_TYPE_UNSUPPORTED` on **both** sides. An extension only *suggests* a type: one
  the board cannot name becomes `application/octet-stream` ("we do not know what this is"),
  always allowed and still served as an inert download;
- an attachment id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; anything else is refused
  before it can become a second path segment;
- `/meta.capabilities.attachments` is `true`, so a client feature-detects this surface
  instead of probing for a `404`.

On the wire an attachment is `{ id, task_id, comment_id, filename, content_type, size, kind,
created_at }`. `kind` is always `attachment` here: the board serves every file as a download,
so no route accepts — or has a use for — `inline`.

**`--meta` is still not a channel into this table.** `--meta <key>=<value>` stores a
**string**: `--meta attachments=[{"filename":"a.png"}]` saves that literal text, not an
array, and nothing on the board reads the key. It is a place to record something *you* will
parse — the file itself has a real write path now, so use it.

### `depends_on` — a `blocks` edge, written the other way round

`depends_on` is **not** a field on the task. "This card depends on X" is a relation of type
`blocks` whose **source is X** (the blocker) and whose target is this card. The task object
carries no `depends_on`, and `PATCH {"depends_on": […]}`
is refused (`400`, "nothing to update") — the write is a relation, not a field. The relation vocabulary is the closed set `parent` |
`blocks` | `related`, and `--type depends_on` is refused as `VALIDATION_FAILED` (`400`,
`unknown relation type`): there is no alias to remember, only a direction.

So **adding a dependency names the blocker first**:

```bash
# "PROJ-0007 depends on PROJ-0003" — the task you name is the blocker.
taskctl relation add PROJ-0003 --type blocks --target PROJ-0007
```

**Listing** is `relation list`; the card's dependencies are its `blocked_by` rows
(`blocked_by` is printed with the *blocker* on the task column):

```bash
taskctl relation list PROJ-0007
```

**Removing** needs the relation's own **id**, carried in the listing's third column — the
card reference is not enough, because a card can have several edges:

```bash
taskctl relation remove PROJ-0007 41   # 41 = the relation's id
```

`<ref>` may be either endpoint; the number selects the edge. There is no `depends_on` sugar
on any command, so this three-step (add / list / remove) *is* the interface.

Round-trip and effect:

- `taskctl export md` writes `depends_on: [PROJ-0003]` into the frontmatter, and importing
  that card re-creates the edge with the same direction (`source` = the blocker) — see
  `references/card-schema.md`;
- an unfinished `depends_on` is what keeps a card out of `issue candidates`, and what `T1`
  ("stalled") means in the `--order weight` tiers.

The HTTP form is `POST /api/v1/tasks/<blocker>/relations` with
`{"type":"blocks","target":"<card>"}` to add, `GET /api/v1/tasks/<card>/relations` to read
`blocked_by[]`, and `DELETE /api/v1/tasks/<card>/relations/<relationId>` to remove; each
relation on the wire carries `{ id, type, source, target, origin, created_at }`.

Guards, and which apply to which type: two are the same for every type — a task may not be
related to itself (`SELF_REFERENCE`), and the same `(type, source, target)` triple cannot be
inserted twice (`ux_relations_triple`). `parent` carries two more: only an `epic` may be a
parent, and a parent edge that would close a cycle is refused (`RELATION_CYCLE`).

`blocks` is not the unguarded one. It has two refusals of its own, both resting on the same
fact — the poll never offers a card whose blockers are unfinished, so an edge leaving a card
waiting on something that can never finish parks it for good:

- **a loop in the dependency graph.** Before migration `0017_block_cycle.sql`, `a blocks b`
  plus `b blocks a` went in, and every card in that loop became permanently unclaimable; now
  the edge is refused with the same `RELATION_CYCLE` the parent direction raises;
- **a card and its own ancestor or descendant, in either direction**: `D depends_on E` where
  `E` is `D`'s parent, and `E depends_on D` where `D` is `E`'s child, both refuse — "an
  ancestor and a descendant cannot depend on each other" (`0021_block_chain.sql`). **Siblings
  are not on one chain**: two children of one epic may depend on each other, and stay legal.
  The rule holds whichever order the edges arrive in: it is re-checked at the **parent**
  insertion point as well (`0022_block_pair_on_parent.sql`), so a `blocks` edge landing
  *before* the parent link — the order an `md` import writes in — is refused just the same.

Both live in the database first (`tr_rel_block_cycle` and `tr_rel_block_chain`,
`src/core/storage/migrations/0017_block_cycle.sql` / `0021_block_chain.sql`; the pair guard
adds `tr_rel_parent_block_pair`, `0022_block_pair_on_parent.sql`).

`--force` skips the app-layer checks of either type, never the database's: the trigger is the
invariant, the service layer only phrases the refusal first.

## `--json`

Wire names are `snake_case` (the card's vocabulary). A task looks like:

```json
{
  "ok": true,
  "data": {
    "task": {
      "id": "…uuid…",
      "identifier": "PROJ-0007",
      "project_id": "proj",
      "title": "…",
      "status": "in_review",
      "awaiting_reason": null,
      "priority": "high",
      "labels": [],
      "version": 4,
      "delivery_round": 1,
      "report_latest_id": 3,
      "report_waiver": null,
      "status_changed_at": "2026-10-09T…Z",
      "assignee": { "id": "…", "display_name": "linus", "kind": "agent" },
      "reporter": { "id": "…", "display_name": "elon", "kind": "human" }
    },
    "report_waivers": [],
    "token_source": "file"
  }
}
```

An actor always carries `display_name` **and** `id`. `token_source` says which of the four
token sources was used (`flag`, `env`, `file`, `none`) and never carries a value.
`awaiting_reason` is the card's entry category (`E1..E5`) while it is `awaiting`, and `null`
at every other moment.

Errors are the domain error verbatim:

```json
{ "ok": false, "error": { "code": "REPORT_REQUIRED", "message": "…", "http": 422,
                          "details": { "round": 1, "existingRounds": [] },
                          "hint": { "command": "taskctl issue deliver PROJ-0007 --report-file -" } } }
```

Bind scripts to `error.code` and `error.hint.command`, never to the prose.

## Notes

- Everything is **local**. The command surface performs no network access beyond loopback to
  your own board.
- Every state-mutating write is safe under concurrent agents — the service owns that
  guarantee (transactions and compare-and-swap), not the CLI.
- Data lives in the board's SQLite file (`<dataDir>/board.sqlite`, default `<repo>/.data`,
  override with `TASKD_DATA_DIR` / `TASKD_DB`).
