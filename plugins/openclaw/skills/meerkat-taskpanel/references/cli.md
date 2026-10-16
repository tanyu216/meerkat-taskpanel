# `taskctl` CLI reference

> **Status: implemented (M2).** The command surface below is real, and is what
> `taskctl --help` prints. It is aligned with **`task-interface v1`**, grouped by
> the card's own vocabulary.

`taskctl` is an **HTTP client** for `taskd`, the local board service. There is no
second copy of the rules in the CLI: a refusal you see here is the one the service
raised, with the same code, the same details and the same repair command.

> **`src/…` paths below are provenance.** A few places name the file a set or a rule is
> *defined* in (`src/core/domain/status.mjs`, `src/core/domain/enums.mjs`,
> `src/server/main.mjs`). Those are paths in the **taskpanel source repository**; this skill
> ships `SKILL.md`, `references/` and `scripts/` only, so they are pointers for whoever is
> reading the source, not files an installed copy has. Nothing in this page asks you to run
> them — every command here is `taskctl`.

```bash
taskctl <group> <command> [options]
```

Global form, and the two flags that always work (they never contact a board):

```bash
taskctl --help
taskctl --version
taskctl --version --json   # {"ok":true,"data":{"version":"1.0.0","schema_version":4}}
```

`--version --json` is the **version leg**: it publishes the provider's contract
`schema_version` — the generation of the API/wire contract this board speaks, the
same number the contract snapshot freezes (`docs/contract.md`) — so a caller that
has to detect contract drift can read the provider's own declaration instead of
hard-coding one. It needs no board, so the check works even when the daemon is
down. The number moves with the snapshot's own layout, not with every contract
change: a new route does not move it, so treat it as a coarse generation marker,
not a complete drift detector.

## Starting the board

If no board is running, `taskctl` starts one (`node src/server/main.mjs`, detached,
logging to `<dataDir>/logs/taskd.log`) and waits for its `/health`. Set
`TASKD_NO_AUTOSTART=1` to forbid that — then a missing board is a clear error
rather than a surprise process.

The service writes a **runtime pointer** (its URL, port, data dir and token file —
never the token itself) so any shell in any directory finds the same board.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Print `{"ok":true,"data":…}` on stdout. Failures print `{"ok":false,"error":{code,message,http,details,hint}}` on **stdout** too, so a pipe only needs one stream. |
| `--url <url>` | Board to talk to. Wins over the runtime pointer, and never triggers autostart. |
| `--token <token>` | Access token. Priority: `--token` > `$TASKD_TOKEN` > the pointer's token file > none (loopback needs no token). |
| `--if-version <n>` | Optimistic concurrency: the write is refused with `VERSION_CONFLICT` if the task moved on. |
| `--actor-kind <name>` | Who or what is writing: `human`, or the platform (`claude`, `codex`, …). This **is** the identity — there is no separate platform flag. Absent ⇒ `human`. |
| `--as-human` | Write as the configured human (`$TASKCTL_HUMAN`). The one write that is not the agent's own. |
| `--session-id <id>` | Agent session identifier. Requires `--actor-kind` — a session with no kind has nothing to attribute it to. |
| `--agent <name>` | Name the actor. |
| `--version` | Print the release version and exit. With `--json`, print `{"version", "schema_version"}` — the contract schema generation beside it. Never contacts a board. |
| `-h`, `--help` | Help for the CLI, a group, or one command. |

**Exit codes:** `0` success · `1` runtime failure (including the delivery gate) ·
`2` usage error · `3` `export md --check` found stale cards.

The token never appears in any output — not in `--json`, not in a warning, not in
an error message.

## Commands

### `project`

| Command | Purpose |
|---|---|
| `project create --id <id> --name <n> [--meta k=v]… [--label <l>]… [--readme <text>]` | Create a project. The id becomes the identifier prefix (`demo` → `DEMO-0001`). |
| `project update <id> [--name] [--meta k=v]… [--label]… [--readme]` | Update it. `--meta` **merges**. |
| `project list [--include-archived]` | List projects. |
| `project dir <id>` | Print the local directory work for the project happens in, resolved from `projects.json` (`--projects-json <path>` or `$MEERKAT_TASKPANEL_PROJECTS_JSON` picks another map): the entry's `local_path`, else its `run_dir`. Prints that the entry names no directory — and still succeeds — for a project that has none. Exits non-zero, asking which directory it should be, only when no entry is registered or the registered path is relative, missing, not a directory, or blank. |
| `project readme <id>` | Print the readme. |
| `project readme <id> --set <text>` / `--file <path\|->` | Set it. |

**A project carries no directory.** TaskPanel does no project-directory management:
there is no `--workspace-path`, no `context` command, and no board-side field that
names a project's target directory. The local map from a directory to a board
project is the `projects.json` kept beside this skill — see
[`projects-json.md`](projects-json.md). `project dir` is that map's read side, and it
is local: it resolves and validates the path, and **stops to ask** rather than
guessing one — while an entry that deliberately names no directory is an answer, not a
question. The wake glue resolves the same map to run a woken worker in the directory
the map names.

### `issue`

| Command | Purpose |
|---|---|
| `issue create --project <id> --title <t> [--acceptance <text>]… [--assignee <text>] [--reporter <text>] …` | Create a task. |
| `issue list [--project] [--status <s>]… [--assignee-id] [--limit] [--include-archived] [--order board\|weight] [--order-debug]` | List tasks. `--order weight` is the **assignee weight order** (below); the default is the board's own deterministic order, so nothing changes unless you ask. |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order board\|weight] [--order-debug]` | The poll's read: claimable cards for an assignee (`todo`, **auto-claimable** — not an `epic`, not a `deploy` —, every `depends_on` done; `--stale` adds `in_progress` cards whose heartbeat expired; `--include-unassigned` adds the **public pool** — unassigned claimable cards — for a supervisor whose policy allows them). Read-only — claiming still goes through `issue move`/claim semantics. `--order weight` refines the order *within* each claimability bucket, which stays the first key. |
| `issue get <id\|identifier>` | One task, plus `report_waivers[]`. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]…` | Patch. `--status` is refused here on purpose. |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--blocked-reason <clarify\|decision\|dependency\|out_of_bounds\|defect\|external\|resource\|unknown>]` | Move, subject to the delivery gate. A `todo → in_progress` move is a **claim**: only the card's assignee, unless `--allow-steal`. `--awaiting-reason` is **required** by a move to `awaiting` — see [The `awaiting` state](#the-awaiting-state--asking-a-human-a-question). `--blocked-reason` is **optional** and records *what* a `blocked` card is waiting for — see [The `blocked` state](#the-blocked-state--what-the-card-is-waiting-for). |
| `issue heartbeat <ref>` | **Pulse a claim you hold**, so its heartbeat stays inside the fresh window and the card does not read as abandoned. Takes no flags of its own — the card is the positional and the pulsing actor is you (the global attribution flags). It refreshes `heartbeat_at` and **nothing else**: the status and the claimer are untouched, so it cannot resurrect a card somebody else moved. Only the holder may pulse — anybody else gets `EXECUTION_ACTIVE`; a card that is not `in_progress` gets `INVALID_TRANSITION` ("nothing to pulse"). The pulse is recorded as a `task_heartbeat` activity, which the board treats as **noise** (it never wakes an SSE client). |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--force-create]` | Assign. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue deliver <ref> --report-file <file\|->` | **Write the report and move to `in_review`, in one transaction.** |

### The weight order (`--order weight`)

`issue list` and `issue candidates` take an optional `--order weight` — the
**assignee weight order** (contract `C-WEIGHT-1`). It answers "which of my cards
should I look at next?", and it is **opt-in**: the default is still the board's
own `sort_order, created_at, project_id, identifier` sequence, so nothing moves
until you ask.

It ranks in three passes — a hard *tier* (can I move this card at all?), then a
weighted *score*, then a deterministic tie-break ending on the card's number:

- `T0` cards you can start now → `T1` ones you are stalled on (blocked, or
  waiting on an unfinished `depends_on`) → `T2` ones in somebody else's hands
  (`in_review`, `awaiting`). A tier is never traded against a score: a
  high-scoring card waiting on a reviewer still sits behind one you can start.
- Inside a tier the score is a linear sum of priority, time in the current
  status, time since creation, SLA pressure, and how many unfinished cards this
  one unblocks — each capped at its own saturation point, so a card's score never
  depends on which other cards happen to be in the list.
- Equal scores fall through to priority, then the longest wait, then age, then
  the board's column order, then `project`, then the identifier — a total order,
  so two runs over the same board agree.

`--order-debug` adds the arithmetic, card by card, so a rank can be reconciled by
hand: `{ id, identifier, order, tier, tier_name, score, factors: { P, W, S, A, B,
L } }`, each factor with its `raw` value, its `normalised` value and its
`weighted` contribution. Asking for it selects the weight order (there is no
board-order projection to return).

**What it does not touch.** `activity` and `waiting` keep their own orders (a
timeline and a longest-waiting queue), and `export --md` keeps the board order
byte for byte. Inside `issue candidates` the claimability bucket —
`ready` → `unassigned` → recovery — stays the **first** key, because it says
whether a card can be claimed at all; the weight order only refines within a
bucket.

### Claiming: only the assignee may claim

`issue move <ref> in_progress` on a `todo` card **is** a claim: it takes the
execution lock (`claimed_by` / `claimed_at` / `heartbeat_at`). A card has two
roles — the **assignee** (who it is routed to) and its **claimer** (who is doing
it now); normally they are the same person. Who may claim:

- **Unassigned** cards are an open pool: any actor may claim them.
- An **epic** can never be claimed (`not_claimable`), and neither can `backlog`
  — only `todo` is claimable.
- A **`deploy`** card *can* be claimed — but `issue candidates` never offers one,
  so it is only reachable by an explicit dispatch (see
  [Deployment cards](#deployment-cards-never-auto-claimed)).
- A card routed to somebody else is refused on this **first claim** with
  `not_assignee` — that code appears **only** on this `todo → in_progress`
  path:

```console
$ taskctl issue move PROJ-0007 in_progress
not_assignee: PROJ-0007: this task is assigned to somebody else; only the assignee may claim it
try: taskctl issue move PROJ-0007 in_progress --allow-steal --reason "<why>"
$ echo $?
1
```

- `--allow-steal --reason "<why>"` is the **audited** override of the routing
  lock, valid on that first claim only: the reason must be at least 8
  characters, and the takeover is recorded as a `task_claimed` activity **and** a
  `kind: change` comment naming the original assignee, the new claimer and the
  reason (`comment list <ref>` shows it).
- Re-claiming an `in_progress` card is governed by the age of its heartbeat —
  the boundary is `HEARTBEAT_FRESH_MS` (10 minutes):

  | Heartbeat age | The holder | Anyone else |
  |---|---|---|
  | `≤ 10 min` (fresh) | reuses the claim (`reuse`, nothing reset) | refused — `EXECUTION_ACTIVE` |
  | `10 min … 6 h` | re-claims it, resetting the lock | refused — `EXECUTION_ACTIVE` |
  | `> 6 h`, or **no heartbeat at all** | may take it | may take it — an audited takeover |

  While a claim is less than 6 hours old a non-holder is always refused with
  `EXECUTION_ACTIVE` — never `not_assignee`, and `--allow-steal` does **not**
  override it. Past 6 hours (or with no heartbeat at all) the claim has rotted
  and **any** actor may take it, recorded as an audited takeover (the staleness
  *is* the reason, so no `--reason` is needed). A **rework**
  (`in_review`/`blocked → in_progress`) is *not* a claim: it keeps the existing
  executor and their lock.
- **Keeping the heartbeat fresh is the holder's own job, and it has its own
  command.** `issue heartbeat <ref>` resets the clock and changes nothing else —
  not the status, not the claimer, not the delivery round — so it is the honest
  way to say "still working" and it can never resurrect a card somebody else has
  moved. Only the holder may send it. The board runs **no background pulse**:
  nothing but the holder knows the work is still going, so a claim whose holder
  goes quiet *should* read as abandoned.

**The lock lasts the whole work cycle.** The claim is held while the card is in
any of `in_progress`, `awaiting`, `in_review` or `blocked` — the set is
`CLAIM_HOLDING_STATUSES` in `src/core/domain/status.mjs`, and `holdsClaim` is the
predicate — and it is released by the **same write** that takes the card out of
that cycle: a move to `todo`, `backlog`, `done` or `canceled`. There is no
separate unclaim command, and because `status`, its timestamps and the claim go
down in one `UPDATE`, no reader ever sees a card still holding a claim it no
longer owns. `awaiting` (a pause inside the attempt), `in_review` and `blocked`
stay *inside* the cycle because each of them can return to `in_progress` — and
the card that comes back must still be the same executor's.

**That release is what closes the `backlog` CHECK.** The schema's
`CHECK (claimed_by IS NULL OR status <> 'backlog')` used to be reachable from the
service: `in_progress → todo` left `claimed_by` behind, and the legal
`todo → backlog` then tripped it — surfacing to the board as a raw
`CHECK constraint failed: …`. Releasing the claim on the way out of the work
cycle makes that path unreachable.

### Deployment cards: never auto-claimed

A **deployment card** — work that runs against a live instance rather than in the
repository (rebuilding `dist`, restarting `taskd`, a full `install.sh` run) — is
marked with `--kind deploy`:

```console
$ taskctl issue create --project PROJ --title "Rebuild dist and restart taskd" --kind deploy
```

`issue candidates` **never offers a `deploy` card**, in any of its three pools
(assigned, public pool, stale recovery): the poll's read is what an agent claims
from without a human in the loop, and a deployment card is high-impact and needs
the instance to be in the right state, so it is dispatched explicitly instead.
The marker is the same mechanism `epic` uses (`kind`), but **only half** of it:

| | `epic` | `deploy` |
|---|---|---|
| In `issue candidates` | never | never |
| Claimable at all | no — `not_claimable` | **yes**, by an explicit dispatch |

So a `deploy` card is claimed exactly like any other card — `issue move <ref>
in_progress`, by its assignee (or `--allow-steal`) — it just will not be picked
up on its own. When a card you expected is missing from your candidates and you
believe it is deployment work, check `issue get <ref>`: a `kind: deploy` card is
the reason it is not there.

### Promoting an existing card to an epic

`kind` is a patchable field, so a card that turns out to be a container is promoted in place —
and it has to be, because the web UI cannot set `kind`: a card filed from the board UI is always
a `task`.

```console
$ taskctl issue update PROJ-0007 --kind epic
```

Three board facts decide the order you split in:

- **Only an `epic` may be a parent.** `relation add PROJ-0007 --type parent --target <child>` is
  refused `VALIDATION_FAILED` (`details.field: kind`) until the card has been promoted.
- **An epic cannot be claimed.** `issue move <epic> in_progress` is refused `not_claimable`, and
  `issue candidates` withholds epics from all three pools. So a card that must end up
  `in_progress` has to be claimed **while it is still a `task`**, and promoted afterwards.
- **`todo → in_review` is not a transition.** `todo` reaches only `backlog`, `in_progress`,
  `blocked` and `canceled`, and `done` is reachable only from `in_review` — so a promoted card
  left in `todo` cannot be delivered. `todo → blocked → in_review` is its one claim-free route
  out, which is why a container is parked with
  `issue move PROJ-0007 blocked --blocked-reason dependency` until its children land. That block
  class is **visibility only** — the SLA patrol gives it no due point.

Linking a child is its own command: `issue create` writes no relation, and its `--parent` flag
fills the **idempotency key's source slot** and nothing else. A child created with
`--parent PROJ-0007` is not linked to PROJ-0007.

```console
$ taskctl issue create --project PROJ --title "…" --target <t> --assignee <owner>   # the child
$ taskctl relation add PROJ-0007 --type parent --target PROJ-0008                   # the edge
```

Give each child a `--target` of its own. The create guard keys on
kind + assignee + source + target, so a second create repeating all four is read as the **same
request retried** and returns the existing card rather than a sibling — `--allow-dup` is the
escape when a target genuinely does not apply.

The promotion itself is an ordinary patch: it bumps `version`, writes one `task_updated`
activity naming `kind`, and changes nothing else — `status`, the execution claim, the heartbeat
and `delivery_round` all stay put, and the `idem` key (frozen at create, with the card's kind in
its first slot) is **not** rewritten. It therefore leaves no comment: write the split down
yourself (`issue update --description` for the container's intent, `comment add --kind change`
for what you cut it into). One caveat — `issue update` does not forward `--if-version`, so a
promotion cannot be made race-safe from the CLI; re-read the card if that matters.

Only the **downgrade** is fenced: an epic that still has children cannot go back to `task`
(`VALIDATION_FAILED`, "an epic with children cannot be downgraded"). Remove the `parent` edges
first if you really meant to undo it.

The container is closed exactly like a leaf — `report template` → `issue deliver <ref>
--report-file -`, with a report that rolls the children up, one line each. The delivery gate
applies to an epic as it does to a task, and it is still `in_review`: a human accepts to `done`.

### The delivery gate

A card may not enter `in_review` without a report **for the current delivery
round**. Leaving `in_review` (except to `done`) starts the next round, so last
round's report — or waiver — is history, not evidence.

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
$ echo $?
1
```

The **compliant path is the short one**: `issue deliver` writes the report and
performs the move atomically, and `report template` prints a report that `deliver`
accepts without editing.

The second line is the **audited waiver** (F-B1). It is not a bypass: the reason
must be at least 8 characters, the waiver is stamped on the task row, and a
`report_waived` activity is recorded — `issue get` shows it in `report_waivers[]`.

### The `awaiting` state — asking a human a question

A card that needs an answer from a person is **not** `blocked`, and not a chat
message: it moves to `awaiting`, a **first-class status** (M1). The card is still
*running* — it has stopped on a question — so `awaiting` is **not** terminal, and
entering or leaving it **does not start a delivery round**. It is a pause inside
the attempt, not a delivery coming back.

**Entering it — one path, and it must name itself.** `in_progress → awaiting` is
the **only** entry; no other status may reach `awaiting`. The move **requires**
the reason flag:

```bash
taskctl issue move PROJ-0007 awaiting --awaiting-reason E3
```

Without it the CLI refuses the move as a **usage error** — exit `2` — before it
sends anything to the board:

```console
$ taskctl issue move PROJ-0007 awaiting
CLI_USAGE: issue move: `awaiting` needs --awaiting-reason <E1..E5>
fix: E1 scope · E2 acceptance baseline · E3 design direction · E4 security · E5 architecture
$ echo $?
2
```

The service enforces the same rule behind the CLI: a move that reaches it without
a usable reason is refused with `VALIDATION_FAILED` (`details.field` is
`awaiting_reason`, `details.allowed` the vocabulary).

**The vocabulary is `E1..E5`** — the *category* of question, never free text, so a
board can group what is waiting on the human:

| Code | The question is about |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

Any other value — free text, an empty string, a missing flag — is refused. The set
is `AWAITING_REASONS` in `src/core/domain/enums.mjs`, and nothing else defines it.

**Leaving it — one way back, plus cancel.** `awaiting → in_progress` is the only
way back into the work, and it means *a human replied*: it is a **resume of the
same attempt, not a rework**, so the delivery round is not advanced and the report
already written for the current round is untouched. `awaiting → canceled` is
allowed (the human cancels). `awaiting → blocked` and `awaiting → in_review` /
`done` are **forbidden** — the last is a delivery-gate bypass: it would reach
`in_review` without the round's report.

**The reason lives on the card.** Entering `awaiting` stamps `awaiting_reason`;
**leaving clears it**, to `null`, in the same write as the status change — so the
column is non-null *exactly* while the card is `awaiting`, and a resumed or
canceled card never keeps a stale category. `--json` carries it on the task object
beside `status` (see below).

**Reading it.** `issue list --status awaiting` lists the cards parked on a human.
The web board's **waiting** view is that same set, and each row carries the entry
category as a badge (localized `waiting.reason.E1..E5`).

### The `blocked` state — what the card is waiting for

`blocked` is the *other* stop, and it is a different statement: the card cannot
proceed on its own, but nobody has been asked a question. The status already said
that much; `blocked_reason` says **what** the card is waiting for, so an operator
scanning the board — or the SLA patrol — does not have to open the comment trail
and guess.

**Writing it is one optional flag on the move.** `--blocked-reason` may accompany
a move whose destination is `blocked`:

```bash
taskctl issue move PROJ-0007 blocked --blocked-reason dependency
```

Unlike `--awaiting-reason`, it is **not required**: a card blocked for a reason
the writer cannot classify — or one they simply did not state — is legal, and the
inspector reads an unset value as `clarify`. The only refusal is a value that is
not one of the literals.

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

`unknown` is deliberately **not** the spelling of "no reason": it is a writer
saying there is a block they cannot classify, while an absent value says the
writer stated none. The set is `BLOCKED_REASONS` in `src/core/domain/enums.mjs`,
and nothing else defines it. Any other value — free text, an empty string — is
refused with `VALIDATION_FAILED` (`details.field` is `blocked_reason`,
`details.allowed` the vocabulary). Surrounding whitespace is trimmed and nothing
else is: `Dependency` is not `dependency`.

**The reason lives on the card, and only while it is blocked.** Entering `blocked`
stamps `blocked_reason`; **leaving clears it**, to `null`, in the same write as the
status change — so the column is non-null *exactly* while the card is `blocked`,
and a reworked or canceled card never keeps a stale class. A flag passed on a move
to any other status is simply not read. `--json` carries it on the task object
beside `status` as `blocked_reason` (see below), and the card's own history keeps
the class on the `task_moved` activity, so the trail still says why after the
column is cleared.

The field is documented on the card itself in
[`card-schema.md`](./card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for),
including how a value that is not a literal survives a markdown import.

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

`add` reads the file from **your** disk (`CLI_IO` when it cannot), and refuses one
over 8 MiB (`ATTACHMENT_TOO_LARGE`) before it opens a socket. The stored name
defaults to the file's basename and the type to what the extension names; both are
overridable, and a type outside the board's closed set is refused on both sides.
**Download has no command** — the bytes are a plain `GET` of the content URL. The
whole story, including the limits, is under
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

There is **no** `actors add`, `actors rm` or `actors rename` — not
"unimplemented", but absent: the dictionary grows when a task names somebody new
(`--assignee "<text>"`), and that is the whole interface.

Names are resolved in the same transaction as the task write: an exact or unique
prefix match is reused (the dictionary's spelling wins); several matches are
refused with `DICTIONARY_AMBIGUOUS` and the candidates listed; `--force-create`
skips the fuzzy step; `--assignee-id` bypasses the dictionary entirely.

### `report`

| Command | Purpose |
|---|---|
| `report template <ref> [--commit <sha>] [--path <p>]… [--command <cmd:exit>]… [--coverage <pct[@scope]>]…` | Print a report to fill in. |

The template is built from the card: `meta.acceptance` (what `--acceptance`
writes), then the imported card's `meta.acceptance_legacy` checkboxes, then an
empty list with a warning. Every item starts **`not_met`** — a ticked box on an
imported card is the author's intent, not this delivery's evidence — and
`leftovers` gets a `TODO:` placeholder so the shape is valid.

Evidence anchors are explicit flags first, then a read-only `git rev-parse HEAD`,
then the task's `source_path`, then a placeholder you must replace. It never fails
because git is missing (a container has no `.git`).

### `export`

| Command | Purpose |
|---|---|
| `export md [--out <dir>] [--project <id>] [--check]` | Write one markdown card per identifier. |

`--check` writes nothing and exits **3** when any card is missing or differs —
the same convention `migrate-cli check` uses. `taskctl export --md` is accepted
as the same command.

The service renders and the CLI writes: `POST /api/v1/export` returns markdown
and never touches a path the caller named.

### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | Rotate the access token. **Loopback only** (403 `loopback_only` otherwise). |

Prints `td_****` and the token file; `--show` prints the value and says what it
just did.

## Editing a card: status, priority, description, attachments, dependencies

A card's detail view offers five edits — `status`, `priority`, the markdown
`description`, attachments (download / upload / remove) and `depends_on`
(add / remove). They do **not** share one shape: two are a single flag, one is a
**move**, one is a **two-request upload**, and one is an indirection through
relations.

The two columns below are kept apart on purpose, because they answer different
questions. **Board (HTTP API)** is what the service can do; **`taskctl`** is what
a caller can actually type. All five are reachable from the CLI now — the one
place it is still the narrower client is the attachments row, and it is the row to
read carefully: the writes have commands, the **download** does not.

| Capability | Board (HTTP API) | `taskctl` |
|---|---|---|
| **`status`** | **supported** — but the write path is a **move**: `PATCH {status}` is refused (`INVALID_TRANSITION`, "status is not a patchable field — use move or deliver") | **supported** — `issue move <ref> <status>`; `issue update` has no `--status` |
| **`priority`** | **supported** — `PATCH /api/v1/tasks/:ref {"priority": …}` | **supported** — `issue update <ref> --priority <p>` |
| **`description`** (markdown) | **supported** — `PATCH {"description": …}`, stored as opaque text | **supported** — `issue update <ref> --description <md>` |
| **attachments** | **supported** — a row (`POST`/`GET /api/v1/tasks/:ref/attachments`, `DELETE /api/v1/attachments/:id`) beside the bytes (`GET`/`PUT /api/v1/attachments/:id/content`) | **half** — `attachment add` / `list` / `remove`; **download** has no command (read the content URL over HTTP) |
| **`depends_on`** | **half** — carried by a `blocks` relation; the task object has no such field | **half** — `relation add` / `remove` / `list`, with the direction reversed |

**The board's web drawer is a second client of the same API.** It can do nothing
the API does not offer, and it inherits the API's refusals — which is why the
`status` row reads the same for both. Its attachment area lists the **same
`attachments` table** that `attachment list` reads (see
[attachments](#attachments--two-requests-and-a-hard-delete) below) — one source of
truth, so the drawer and the CLI cannot disagree about what a card carries.

### `status` — a move, never a patch

```bash
taskctl issue move PROJ-0007 blocked
taskctl issue move PROJ-0007 in_progress         # todo → in_progress is the claim
taskctl issue deliver PROJ-0007 --report-file -  # report + move to in_review, in one transaction
```

`status` is deliberately **not** a patchable field: the move path is what carries
the state machine, the delivery gate and the claim lock, so a status write cannot
side-step any of them. `issue update` therefore has no `--status`, and that costs
a usage error rather than a round trip:

```console
$ taskctl issue update PROJ-0007 --status blocked
CLI_USAGE: issue update: unknown option --status
fix: run `taskctl issue update --help` to see the options it accepts
$ echo $?
2
```

A move can still be refused — always by the service, always in the CLI's one
error shape:

- a status that is not a legal transition → `INVALID_TRANSITION`, whose
  `details.allowed` lists the statuses that are;
- `in_review` without a report for the current delivery round →
  `REPORT_REQUIRED`, and the hint prints the exact `issue deliver` command that
  fixes it (see *The delivery gate* above);
- `awaiting` without `--awaiting-reason E1..E5` → refused locally, exit `2`
  (see *The `awaiting` state* above).

`issue create --status <s>` sets the status at creation, and `in_review` / `done`
are refused there by the same gate. The HTTP form is
`POST /api/v1/tasks/:ref/move` with `{"to": "<status>"}`.

### `priority` — one flag, one closed set

```bash
taskctl issue update PROJ-0007 --priority high
taskctl issue create --project PROJ --title "…" --priority urgent
```

The vocabulary is a closed set — `low`, `medium`, `high`, `urgent`
(`PRIORITIES`, `src/core/domain/enums.mjs`) — matched case-insensitively.
Anything else is refused with `VALIDATION_FAILED` (HTTP 400, `details.field` =
`priority`). A card that carries no priority reads as `medium`.

There is no gap on either side, so there is no fallback to document:
`PATCH /api/v1/tasks/:ref` with `{"priority":"high"}`, and `POST /api/v1/tasks`
accepts it at creation.

### `description` — markdown as opaque text

```bash
taskctl issue update PROJ-0007 --description "$(cat findings.md)"
taskctl issue create --project PROJ --title "…" --description "one-line summary"
taskctl issue update PROJ-0007 --description ""   # an empty value clears the field
```

The board stores and returns the string **byte for byte**. It does not parse,
validate or render markdown, so a markdown mistake is never a board error — it is
the *web client* that renders it. An agent is therefore writing markdown for a
renderer it cannot see; that, and not any server-side rule, is the real limit of
this path. The column has no length cap.

`issue update` takes the text as the flag's value and has no `--file` form, so a
long body goes through the shell as above — or through the markdown card, which is
the same write by another door:

- `taskctl export md` writes the description as the card's `## Background`
  section (see `references/card-schema.md`);
- importing that card maps `## Background` back to the description, and a
  re-import patches a card that already exists rather than skipping it;
- `issue update --description` sends exactly `PATCH /api/v1/tasks/:ref`, which is
  the HTTP form of the same write.

### attachments — two requests, and a hard delete

```bash
taskctl attachment add PROJ-0007 --file ./shot.png       # name and type from the file
taskctl attachment add PROJ-0007 --file ./notes --name notes.txt --content-type text/plain
taskctl attachment list PROJ-0007
taskctl attachment remove 3f1c9a2e-…                     # the id `list` prints
curl -sO http://127.0.0.1:7788/api/v1/attachments/3f1c9a2e-…/content   # download: API only
```

**Upload is two requests, deliberately.** `attachment add` first mints the
metadata row (`POST /api/v1/tasks/:ref/attachments`, which returns the id and an
`upload_url`) and then stores the bytes (`PUT /api/v1/attachments/:id/content` —
the one request on this board that is not JSON). A one-shot route would need a
body that is both JSON and bytes; the seam is instead **named**: a row whose `PUT`
never arrives holds no bytes and answers an honest `404` on download — its `size`
is whatever the create declared (`0` for a caller that declared none) — so nothing
is invented. `attachment add` does both halves in one command and a caller never
sees the seam; the board's own drawer rolls the row back when the second half
fails.

**Removal is a hard delete, and it is one act.** `attachment remove` deletes the
row **and** the bytes, in a single transaction that holds the write lock — so
every way the removal can be refused leaves the board as it was. An attachment is
**not recoverable** and re-uploading is the whole recovery story; the ruling is
recorded where it is implemented (`src/server/routes/attachments.mjs`). The
argument you pass is the attachment's **id**, not the card reference, because one
card can carry several files.

**Download is where the CLI stops.** There is no `attachment download`: the bytes
are a `GET` of the content URL, and every response is a download, never a document
the board's origin renders — `content-disposition: attachment` plus
`x-content-type-options: nosniff` and `cache-control: no-store` (so a removed
attachment cannot survive in the client's cache) carry that boundary. A row with
no stored bytes is a truthful `404`, not an error.

**The write limits, shared rather than restated.** `src/shared/attachments.mjs`
is the one place they are decided, and both the CLI and the board call it, so the
CLI cannot drift from the board it uploads to:

- a single request body is capped at **8 MiB** (`ATTACHMENT_MAX_BYTES`; over it,
  `413` `ATTACHMENT_TOO_LARGE`) — a *different* cap from the 1 MiB JSON routes.
  The CLI checks it before it opens a socket, and the board refuses an oversized
  raw body on its own side;
- `content_type` is a **closed set** (`ATTACHMENT_CONTENT_TYPES` — the text, JSON,
  PDF, archive, image and office types). A type outside it is refused with `422`
  `ATTACHMENT_TYPE_UNSUPPORTED` on **both** sides. An extension is only a
  *suggestion* of a type: one the board cannot name becomes
  `application/octet-stream` ("we do not know what this is"), which is always
  allowed and is still served as an inert download;
- an attachment id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, and anything
  else is refused before it can become a second path segment;
- `/meta.capabilities.attachments` is `true`, so a client feature-detects this
  surface instead of probing for a `404`.

On the wire an attachment is
`{ id, task_id, comment_id, filename, content_type, size, kind, created_at }`.
`kind` is always `attachment` on this surface: the board serves every file as a
download, so no route accepts — or has a use for — `inline`.

**`--meta` is still not a channel into this table.** `--meta <key>=<value>` stores
a **string**: `--meta attachments=[{"filename":"a.png"}]` saves that literal text,
not an array, and nothing on the board reads the key. It is a place to record
something *you* will parse — the file itself has a real write path now, so use it.

### `depends_on` — a `blocks` edge, written the other way round

`depends_on` is **not** a field on the task. "This card depends on X" is stored as
a relation of type `blocks` whose **source is X** (the blocker) and whose target is
this card. The task object carries no `depends_on`, and `PATCH {"depends_on": […]}`
is refused (`400`, "nothing to update"). The relation vocabulary is the closed set
`parent` | `blocks` | `related`, and `--type depends_on` is refused as
`VALIDATION_FAILED` (`400`, `unknown relation type`): there is no alias to
remember, only a direction.

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

**Removing** needs the relation's own **id**, which that listing carries in its
third column — the card reference is not enough, because a card can have several
edges:

```bash
taskctl relation remove PROJ-0007 41   # 41 = the relation's id
```

`<ref>` may be either endpoint of the edge; the number is what selects it. There
is no `depends_on` sugar on any command, so this three-step
(add / list / remove) *is* the interface.

Round-trip and effect:

- `taskctl export md` writes `depends_on: [PROJ-0003]` into the card's
  frontmatter, and importing that card re-creates the edge with the same
  direction (`source` = the blocker) — see `references/card-schema.md`;
- an unfinished `depends_on` is what keeps a card out of `issue candidates`, and
  it is what `T1` ("stalled") means in the `--order weight` tiers.

The HTTP form is `POST /api/v1/tasks/<blocker>/relations` with
`{"type":"blocks","target":"<card>"}` to add, `GET /api/v1/tasks/<card>/relations`
to read `blocked_by[]`, and `DELETE /api/v1/tasks/<card>/relations/<relationId>`
to remove; each relation on the wire carries
`{ id, type, source, target, origin, created_at }`.

Guards, and which of them apply to which type: two are the same for every type —
a task may not be related to itself (`SELF_REFERENCE`), and the same
`(type, source, target)` triple cannot be inserted twice (`ux_relations_triple`).
`parent` carries two more: only an `epic` may be a parent, and a parent edge that
would close a cycle is refused (`RELATION_CYCLE`).

`blocks` is not the unguarded one. It has two refusals of its own, and both rest
on the same fact — the poll never offers a card whose blockers are unfinished, so
an edge that leaves a card waiting on something that can never finish parks it for
good:

- **a loop in the dependency graph.** Before migration `0017_block_cycle.sql`,
  `a blocks b` plus `b blocks a` went in, and every card in that loop became
  permanently unclaimable; now the edge is refused with the same `RELATION_CYCLE`
  the parent direction raises;
- **a card and its own ancestor or descendant**, in either direction: `D
  depends_on E` where `E` is `D`'s parent, and `E depends_on D` where `D` is `E`'s
  child, both refuse — "an ancestor and a descendant cannot depend on each other"
  (`0021_block_chain.sql`). **Siblings are not on one chain**: two children of one
  epic depend on each other all the time, and stay legal. The rule holds whichever
  order the two edges arrive in: it is re-checked at the **parent** insertion point
  as well (`0022_block_pair_on_parent.sql`), so a `blocks` edge that lands *before*
  the parent link — the order an `md` import writes in — is refused just the same.

Both live in the database first (`tr_rel_block_cycle` and `tr_rel_block_chain`,
`src/core/storage/migrations/0017_block_cycle.sql` / `0021_block_chain.sql`; the
pair guard adds `tr_rel_parent_block_pair`, `0022_block_pair_on_parent.sql`).

`--force` skips the app-layer checks of either type, never the database's: the
trigger is the invariant, the service layer only phrases the refusal first.

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

An actor always carries `display_name` **and** `id`. `token_source` says which of
the four token sources was used (`flag`, `env`, `file`, `none`) and never carries
a value. `awaiting_reason` is the card's entry category (`E1..E5`) while it is
`awaiting`, and `null` at every other moment.

Errors are the domain error verbatim:

```json
{ "ok": false, "error": { "code": "REPORT_REQUIRED", "message": "…", "http": 422,
                          "details": { "round": 1, "existingRounds": [] },
                          "hint": { "command": "taskctl issue deliver PROJ-0007 --report-file -" } } }
```

Bind scripts to `error.code` and `error.hint.command`, never to the prose.

## Notes

- Everything is **local**. The command surface performs no network access beyond
  loopback to your own board.
- Every write that mutates state is safe under concurrent agents — the service
  owns that guarantee (transactions and compare-and-swap), not the CLI.
- Data lives in the board's SQLite file (`<dataDir>/board.sqlite`, default
  `<repo>/.data`, override with `TASKD_DATA_DIR` / `TASKD_DB`).
