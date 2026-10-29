# The task lifecycle — statuses, transitions and constraints

> One card's state model. `cli.md` is the command surface; `card-schema.md` is the card file.

**Contents:** [1. Vocabulary](#1-the-vocabulary) · [2. Whitelist](#2-the-whitelist) ·
[3. Guards](#3-the-guard-on-each-edge) ·
[4. Delivery gate](#4-the-delivery-gate-and-the-delivery-round) ·
[5. Claims](#5-claims-and-heartbeats) · [6. Containers](#6-containers-epic) ·
[7. Acceptance](#7-acceptance-one-mode-per-card) ·
[8. Creating](#8-creating-a-card-in-a-status) · [9. Refusals](#9-refusals) ·
[10. Enforced vs practice](#10-what-is-enforced-and-what-is-practice) ·
[11. Workflow decisions](#11-the-boards-workflow-decisions)

## 1. The vocabulary

A card has **eight stored status words**, but only **seven are stages** — the board's columns:

| Stage status | Meaning |
|---|---|
| `backlog` | Not released for work; a dispatcher or human moves it to `todo`. |
| `todo` | Released and waiting. The only status a card can be claimed from. |
| `in_progress` | Being worked. Holds the claim; a heartbeat keeps it fresh. |
| `in_review` | Evidence attached, awaiting a verdict. The delivery gate lands here. |
| `blocked` | Cannot proceed on its own; `blocked_reason` says what it waits for. |
| `done` | Accepted. Terminal, with one audited exit: reopen to `todo`. |
| `canceled` | Abandoned. Terminal, with the same one exit. |

`awaiting` is the **eighth literal but not an eighth column**: an *attention overlay* on an
in-progress card that has stopped to ask a human a question, displayed under `in_progress`.

The question is a **`question` comment**: an agent enters with
`issue move <ref> awaiting --awaiting-reason E2 --question "…"`, and the move and the comment
land in one transaction. The payload the view shows is the newest `question` (falling back to
the newest human comment for a card that predates the kind). **Any human comment** answers
it — whatever its kind — and re-queues the card (`awaiting → todo`) in the same transaction,
because the asking subagent has stopped. The board does not read the text: whether the answer
is a complete decision is judged from its content by the resumed worker, and an incomplete or
ambiguous answer sends the card back to `awaiting` for another human comment. A `decision` /
`confirm` / `change` kind remains the explicit I5 record, not the resume gate. An answer is
not a reopen: the delivery round stays where it was.

- **`done` and `canceled` are terminal, but may be reopened to `todo`.** The reopen is audited
  (`issue reopen <ref> --reason "<why>"`, at least 8 characters), starts a **new delivery
  round**, clears the archive and releases the idempotency key. `in_progress` is deliberately
  not a reopen target: a reopened card has no claim holder and must be claimed again.
  Review cards are refused — reopen the card they review, and the loop issues the next round's
  review.
- `kind` changes one thing: an **`epic`** has one extra edge (`todo → in_review`) and is never
  claimable. A `task` follows the ordinary table below.

## 2. The whitelist

Only these moves exist; every other ordered pair is refused — `INVALID_TRANSITION`, or
`TERMINAL_STATE` out of `done`/`canceled`.

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

### 2a. Reopen

`done|canceled → todo` is the only exit from a terminal status, and it is an **audited** move:

- `issue reopen <ref> --reason "<why>"` (the same ≥ 8-character rule as `--allow-steal` and
  `--no-report`); the activity is `task_reopened`, not `task_moved`.
- `issue move <terminal-ref> todo --reason "<why>"` reaches the same edge and enforces the same
  reason. There is no reasonless reopen.
- The card starts a **new delivery round** (`delivery_round + 1`), so the old round's report
  cannot satisfy the gate for the next delivery.
- `archived_at` is cleared (the card returns to the board) and `idem` is released (the finished
  row had already released it; keeping it would re-enter `ux_tasks_idem_active`).
- **Only `todo`.** `in_progress` would be a work state without a claim.
- **Review cards are refused** (`INVALID_TRANSITION`): reopening the original is the action
  that produces the next round's review. `reconcile --workflow` would otherwise close a
  reopened review card on its next tick.
- Raw SQL reaches the edge (the trigger allows it) but does not require a reason — the audit is
  a service rule, exactly like `--allow-steal`.
- Reopening a child does **not** reopen a terminal parent epic; reopen the container itself
  (or run `issue reconcile`) if its roll-up should be reviewed again.

### What is not a transition

- **`x → x` is not a transition.** Recover a stale `in_progress` claim with `issue claim`.
- **An unknown status word is `VALIDATION_FAILED`**, not `INVALID_TRANSITION`.
- **`in_review → canceled` does not exist.** It takes two moves; both exits from `in_review`
  bump the round (§4), even if you cancel immediately.
- **Only an `epic` in `todo` may go to `in_review`** — scoped to `kind`, not to status.

## 3. The guard on each edge

A pair on the whitelist can still be refused; the target decides which guard applies.

| Target | What must be true as well |
|---|---|
| `backlog` | Nothing; leaving the work cycle releases the claim. |
| `todo` | Nothing; the card must be claimed again. From `done`/`canceled` this is a **reopen**: `--reason` of at least 8 characters, review cards refused, and a new delivery round (§2a). |
| `in_progress` | From `todo` this **is a claim**: the assignee, or an audited `--allow-steal --reason` of at least 8 characters; an `epic` is refused (`not_claimable`). From `in_review`/`blocked` it is **rework/unblock** — keeps the executor. From `awaiting` it is a **resume**; the round does not move. |
| `in_review` | The **delivery gate**: a `delivery` report for the current `delivery_round`, or an audited waiver for that round (§4). Every child must be terminal (`CHILDREN_OPEN`). |
| `blocked` | `--blocked-reason` is **optional**. Entering `blocked` does not bump the round; **`in_review → blocked` does**. |
| `awaiting` | Only `in_progress → awaiting`, naming `--awaiting-reason E1`…`E5`. An **agent** must also supply `--question` (or already have an unanswered `question` comment) — `QUESTION_REQUIRED`; a human may park silently. Exits: `→ in_progress` (live worker), `→ todo` (any human comment re-queues the card; releases the claim, no round bump), `→ canceled`. Leaving clears the reason. `awaiting → blocked`/`in_review`/`done` are forbidden. |
| `done` | From `in_review` — **acceptance**, so the delivery gate is not re-consulted — or **directly from `in_progress`** when the card's `acceptance_mode` is `off`. The writer must be allowed by the card's mode (§7); every child must be terminal (`CHILDREN_OPEN`). An `agent` card needs a current-round APPROVE review (`REVIEW_REQUIRED`; the DB trigger checks that a review card reached the reviewer). A human closing an `agent` card also needs the current round's review cards resolved (`REVIEW_PENDING`). A non-empty **acceptance baseline** must be covered by the current round's report (`ACCEPTANCE_UNVERIFIED` / `ACCEPTANCE_INCOMPLETE`, §4a). |
| `canceled` | From `backlog`, `todo`, `in_progress`, `awaiting` or `blocked` — **never directly from `in_review`**. Terminal. |

### The order the guards run

The first refusal wins, so the error you see is stable:

1. waiver shape (`--no-report` only to `in_review`, never with a report, reason ≥ 8 chars);
2. the `awaiting` / `blocked` reason vocabulary;
3. the whitelist (`INVALID_TRANSITION` / `TERMINAL_STATE`);
3a. for a terminal source: the audited reopen reason (≥ 8 characters) and the review-card
   refusal;
4. for `done`: acceptance authority — the card's `acceptance_mode` (`ACCEPTANCE_FORBIDDEN`);
5. for `in_review` and `done`: children terminal (`CHILDREN_OPEN`);
5a. for `done`: acceptance **coverage** (`ACCEPTANCE_UNVERIFIED` when the round has no report,
   `ACCEPTANCE_INCOMPLETE` when an item is missing or blocking) — §4a;
6. for `todo → in_progress`: the claim gate (`not_assignee`, `EXECUTION_ACTIVE`,
   `CLAIM_LOST`, `not_claimable`);
7. for `in_review`: the delivery gate (`REPORT_REQUIRED`), then the artifact contract
   (`DELIVERY_NEEDS_COMMIT`) when the report cites a path but no commit;
8. for `done`: the `agent` card's review evidence (`REVIEW_REQUIRED` when there is no
   current-round review), then the human open-review check (`REVIEW_PENDING`);
9. the compare-and-swap write (`VERSION_CONFLICT` on a stale `--if-version`).

Database triggers re-check the hard invariants afterwards; this order is what a `taskctl`
caller sees.

## 4. The delivery gate and the delivery round

A card may not enter `in_review` without evidence **for the current delivery round** — a
report counts only for the round it was written in.

- A report for the card's current `delivery_round`. Every report counts, whether written live
  or imported as history.
- **A path anchor must name its commit.** If the report's evidence contains a `path` anchor it
  must also contain a `commit` anchor (`DELIVERY_NEEDS_COMMIT`): a path is a claim about the
  working tree, and an uncommitted tree can be stashed or reset before the reviewer reads it.
  The board checks the shape only — the reviewer verifies that the sha resolves and that every
  path exists at it. Review cards and epics are exempt (a reviewer's paths name what it read;
  a container's evidence is its rollup union, whose children passed the same gate). A waiver
  carries no evidence, so the rule does not apply to it.
- The escape hatch is the **audited waiver**: `--no-report --reason "<why>"` on a move to
  `in_review` (or on `issue deliver`). The reason needs at least **8 characters** after
  trimming; the waiver is stamped on the task row, recorded as a `report_waived` activity and
  shown in `issue get` under `report_waivers[]`. It covers only its round.
- `--no-report` and `--report-file` are mutually exclusive; `--no-report` anywhere else is
  `VALIDATION_FAILED`.

| Move | Round |
|---|---|
| create | `1` |
| entering `in_review` | unchanged |
| `in_review → in_progress` | **+1** |
| `in_review → blocked` | **+1** |
| `in_review → done` | unchanged |
| `awaiting → in_progress` | unchanged |
| `awaiting → todo` | unchanged (an answer re-queues; not a reopen) |
| everything else | unchanged |

A rework voids the previous report **and** waiver; the next delivery needs fresh evidence.

The compliant path writes the report and moves atomically:

```bash
taskctl report template <ref>                 # fill the TODO lines
taskctl issue deliver <ref> --report-file -   # lands in in_review
taskctl issue deliver <ref> --report-file - --to done   # an `off` card's direct acceptance
```

A report with an explicit non-current `round` is `REPORT_ROUND_MISMATCH` — a report-write
error, not a move refusal. A refusal names the round and the fixing command; the exact text is
in [`cli.md#the-delivery-gate`](cli.md#the-delivery-gate).

## 4a. The acceptance baseline

Each card carries a frozen acceptance baseline: `tasks.acceptance_json` (`acceptance[]` on the
wire) plus a monotonically increasing `acceptance_revision`. `meta.acceptance` is only the
**seed** — `create` and the first claim copy it (and the imported `acceptance_legacy` texts)
into the snapshot; the gates never read meta.

- **Append only.** `issue update <ref> --acceptance "…"` appends; duplicates (normalized text)
  are ignored. There is no replace. Removing an item is a **human-only audited prune**:
  `--drop-acceptance "…" --reason "<why>"` (≥ 8 characters, recorded as `acceptance_pruned`),
  optionally guarded by `--acceptance-revision <n>` (`ACCEPTANCE_STALE_REVISION` on a stale
  read).
- **Locked once delivered.** `in_review` and the terminal states refuse any snapshot change
  (`ACCEPTANCE_LOCKED`); rework first. A `done`/`canceled` reopen does not change the baseline.
- **The DB enforces the same rules**: any rewrite must bump `acceptance_revision` exactly once
  (`ACCEPTANCE_SNAPSHOT_IMMUTABLE`), and a removed/rewritten old item needs an
  `acceptance_pruned` activity with a reason (`ACCEPTANCE_PRUNE_FORBIDDEN` in the app;
  the trigger raises the same `ACCEPTANCE_SNAPSHOT_IMMUTABLE`).
- **The gate.** Moving to `done` reads the current round's `delivery` report and checks it
  against the snapshot. No report → `ACCEPTANCE_UNVERIFIED` (a `--no-report` waiver excuses
  the delivery gate, not acceptance). Every baseline item must appear; `met` and
  `not_applicable` (with a non-empty note) pass, `partial` / `not_met` block. A report item
  **beyond** the baseline also blocks if it is `partial` / `not_met` — the report itself says
  work is unfinished. Empty baseline → vacuous, allowed: the rule is "once non-empty, it
  cannot be shortened", not "every card must have criteria".
- **A `met` must point at its evidence.** On an `agent` card the gate also reads the report's
  `evidence[]`: each `met` item's note must cite at least one `evidence[n]` that resolves
  within that list, or the item is `unsupported` (`no_anchor` / `dangling_anchor`) and the gate
  refuses with `ACCEPTANCE_INCOMPLETE` (`details.unsupported`). This is structural — it forces
  the pointer, not the truth of the pointer. The judgement behind it is the reviewer's: a
  claim that cannot be reproduced is `not_met`, never `met`, and `partial` does not soften a
  requirement that was not implemented. An `off` or `human` card keeps the lighter contract
  (matching items, statuses and notes). `deliver` applies the same rule before it writes the
  row (`details.source = "delivery"`): a report is bound to its round and cannot be amended, so
  an anchorless `met` is cheaper to refuse at the writer than to discover after a review.
- **Reviews.** An `APPROVE` on a review card is checked against the original's snapshot (and
  the review card's own) before it can close anything, and the review report must carry at
  least one `command` anchor — the reviewer runs the gate itself, so an APPROVE that ran
  nothing is refused (`ACCEPTANCE_INCOMPLETE`, `details.reason = "no_command_evidence"`); see
  [`review-workflow.md`](review-workflow.md).
- **Epics.** A container's own snapshot is informational; its acceptance fact is the current
  round's rollup over its children (§6).

The engine guarantees coverage of the written baseline. It cannot guarantee that the baseline
itself covers everything in the description or the plan — that stays the reviewer's omission
check: every requirement in the description, comments and `.meerkat/<id>/plan.md` must map to
an acceptance item and evidence, or be explicitly deferred. A missing plan is not itself a
failure (fall back to the description and snapshot); an unexplained deviation from an existing
plan is. `meta.acceptance_derived = "yes"` is a flag to audit the list closely, not the only
case that needs the check.

## 5. Claims and heartbeats

- **Only `todo` is claimable.** `todo → in_progress` and `issue claim` are the same path;
  `issue claim` accepts only `todo`/`in_progress`.
- **An `epic` is never claimable** (`not_claimable`), and every `issue candidates` pool
  withholds it.
- **A rework is not a claim.** `in_review → in_progress` and `blocked → in_progress` keep the
  claim and skip the routing lock.
- **Held** in `in_progress`, `awaiting`, `in_review` and `blocked`; the write reaching
  `todo`, `backlog`, `done` or `canceled` releases it. No unclaim command.
- **Heartbeat only in `in_progress`, only from the holder.** It refreshes `heartbeat_at` and
  nothing else.

| Question | Threshold |
|---|---|
| The holder may re-claim with `issue claim` | heartbeat **older than 10 minutes** |
| `issue candidates --stale` offers `stale_same` | heartbeat **older than 30 minutes** |
| Anyone may take over | heartbeat **older than 6 hours**, or none usable |

Another actor's fresh claim is `EXECUTION_ACTIVE`; past six hours any actor may take the
rotted claim as an audited takeover.

**The `depends_on` read rule.** `issue candidates` withholds a card whose `blocks` predecessor
is not `done` — literally `status !== "done"`, so a `canceled` predecessor withholds too.
`issue claim`/`issue move` do not re-check blockers: treat the candidates read as the rule.

## 6. Containers (`epic`)

- **Never claimable.** `issue move <epic> in_progress` is `not_claimable`.
- **The board starts it.** The first child to enter the work moves the container
  `todo → in_progress` (actor kind `taskd`, no claim), with an `epic_auto_start` activity and
  a `kind=note` comment naming the child. A `backlog` epic is not auto-started.
- **The board closes it to `in_review`, never `done`.** When every child is terminal, at least
  one is `done`, and there is evidence to roll up, it writes the **rollup report**
  (`is_rollup = 1`) and moves the epic. Auto-close works from `todo`, `in_progress` and
  `blocked`; acceptance stays separate.
- **An epic is reviewed like any other card.** Its default mode is `agent`, so the workflow
  pass dispatches a review card for it in the same tick that rolls it up (the reconcile runs
  before the snapshot). The reviewer reads the children and the rollup; `APPROVE` closes the
  container (both cards), `REJECT` creates a fix child and reworks the container. An explicit
  `off` epic skips the review and is auto-accepted by the loop.
- **An epic's delivery is a rollup, always.** A report written on an epic is marked as its
  rollup; a `--no-report` waiver cannot deliver a container. The rollup must name **every
  live child** by `ref`: a `done` child is `met`, a `canceled` child is `not_applicable` with
  the reason it was acceptable, and at least one child must be `done`. A mismatch is
  `ROLLUP_STALE`; a missing current-round rollup is `ROLLUP_REQUIRED`.
- **An empty epic cannot be delivered.** No children means no rollup; cancel it or give it
  work.
- **Nothing delivered, nothing to close.** Close by hand with a rollup: `report template
  <epic>` lists the children, then `issue deliver <epic> --report-file -`.
- **The epic's own `acceptance` snapshot is informational.** `done` on an epic checks the
  current-round rollup, not the container's `acceptance_json`.
- **A stale rollup blocks acceptance, not the board.** `issue reconcile` reports an
  `in_review` epic whose rollup no longer matches its children (`rollup_stale`) without
  moving it. Repair it by reworking the epic (`in_review → in_progress`, which starts a new
  round); the sweep then writes a fresh rollup.
- **`todo → in_review` is the epic-only repair edge** for a child attached after the container
  finished; it still passes the delivery gate.
- **No parent closes over an open child.** `CHILDREN_OPEN` guards both `in_review` and `done`.
- **Evidence is the children's, not the container's.** The rollup reads each child's latest
  delivery report; the container's own earlier reports prove nothing, and a child delivered
  under `--no-report` contributes no anchor. With no child evidence the container stays open.
- **A terminal container never rolls up.** The sweep scans non-terminal epics only, so a
  `done`/`canceled` card promoted to an epic will never close over children attached later.
  A delivered card starts a new container instead.
- **Status at promotion.** A `backlog` or `awaiting` epic needs a move to `todo` first, and
  an `in_review` epic that gains a child needs a rework back to `in_progress`.

`issue reconcile` replays the start/close rules over every non-terminal epic and is
idempotent; the ordinary path does not need it.

## 7. Acceptance: one mode per card

`done` is the board's acceptance act, and the card's own `acceptance_mode` names who may
perform it. There is no board-level policy and no scope matrix: a child is closed by whoever
its own mode names, and a review card is the one structural exception. The mode is the
**closer** selector, not a review selector — an `agent` and a `human` card are both reviewed;
only `off` skips the review.

<!-- acceptance-matrix:begin -->
| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), `taskd`, or a human; `in_progress → done` is allowed |
| `agent` | yes — an agent reviewer | `taskd` (after a current-round `APPROVE`) or a human |
| `human` | yes — an agent reviewer | a human only |
| a review card | — | a human or `taskd` — never the reviewer itself |
<!-- acceptance-matrix:end -->

The **project default** (`projects.acceptance`: `auto | off | agent | human`, default
`auto`) is a default at creation only. The creator — in practice the loop — resolves it to
one of the three card modes; a card **never stores `auto`**. An unresolved card — task or
epic — falls back to `agent`: review is the default, and `human` is opt-in. An explicit
`--acceptance-mode` wins over the project value. The structural rules:

- a review card is always `off`;
- **`human` is top-level only.** A card with a parent is never human-accepted: the parent
  edge refuses a `human` child (even with `--force`), and
  `issue update <child> --acceptance-mode human` is `VALIDATION_FAILED`. A person's decision
  on a subtask is an `awaiting` question, not a close. A project-level `human` is a
  top-level default — a child that names no mode under it resolves to `agent`;
- an epic is a card like any other: it is dispatched a review card (against its children and
  rollup) and closed only after an `APPROVE`; `off` remains the one explicit skip.

- A worker agent delivers an `agent`, `human` or review card to `in_review`; a card whose mode
  is `off` may also go **straight to `done`** (`issue deliver --report-file - --to done`).
- A worker that closes an `agent` or `human` card gets `ACCEPTANCE_FORBIDDEN`; `details` carry
  `mode` and `reviewCard`, never a policy or scope.
- `REVIEW_PENDING` applies only to an **`agent`** card whose current-round review card is still
  open, and only to a human closing it; `taskd` is exempt.
- `--actor-kind human` is reserved; a human write uses `--as-human` — in a conversation with
  the human, or when the instruction explicitly came from them (see the board skill's create
  section).
- The mode is board data, readable on the card (`acceptance_mode`) and on the project
  (`acceptance`); there is **no `taskctl` command that reads a policy**. Attempt the move and
  handle `ACCEPTANCE_FORBIDDEN`.
- Changing the mode is the audited `issue update <ref> --acceptance-mode <value> --reason
  "<why>"`: an agent may only tighten (`off → agent|human`), and leaving `agent` needs no open
  current-round review card.

## 8. Creating a card in a status

`issue create` defaults to `todo` and applies an INSERT-shaped gate:

| Initial status | Result |
|---|---|
| `backlog`, `todo`, `blocked`, `canceled` | allowed for a `task` |
| `in_progress` | `VALIDATION_FAILED` — create in `todo`, then claim it |
| `awaiting` | `VALIDATION_FAILED` — a card is not born waiting |
| `in_review`, `done` | `REPORT_REQUIRED` — there is no evidence yet |
| an `epic` in anything but `backlog` / `todo` | `VALIDATION_FAILED` |

## 9. Refusals

| Code | HTTP | When |
|---|---|---|
| `INVALID_TRANSITION` | 409 | The pair is not on the whitelist; `PATCH {status}`; heartbeat on a non-`in_progress` card; `issue claim` on a status other than `todo`. |
| `TERMINAL_STATE` | 409 | The source is `done` or `canceled` and the target is not `todo` (or `deliver` is attempted from it). |
| `REPORT_REQUIRED` | 422 | Entering `in_review` without a current-round report or waiver; creating in `in_review`/`done`. |
| `ACCEPTANCE_FORBIDDEN` | 409 | The writer may not move the card to `done` under the card's `acceptance_mode`. |
| `CHILDREN_OPEN` | 409 | `in_review` or `done` while a child is non-terminal. |
| `REVIEW_PENDING` | 409 | A human closing an `agent` card with current-round review cards still open, or leaving `agent` while one is open. |
| `REVIEW_REQUIRED` | 409 | An `agent` card reaching `done` with no APPROVE verdict for the current round. |
| `REVIEW_CARD_MARKER_INVALID` | 409 | A write tried to give a review card an `agent` mode (flow B is never reviewed again). |
| `VALIDATION_FAILED` | 400 | Unknown status; create in `in_progress`/`awaiting`; an epic's illegal initial status; an unknown `awaiting_reason`/`blocked_reason`; a malformed waiver; a `review_of` whose original is not `in_review`; a `review_of` that names a review card; a `review_round` that is not the original's current `delivery_round`; a review card that is not `kind=task`; a `parent` edge with a review card on either end. |
| `VERSION_CONFLICT` | 409 | `--if-version` does not match the card's version. |
| `EXECUTION_ACTIVE` | 409 | Another actor holds a fresh claim, or a non-holder sends a heartbeat. |
| `CLAIM_LOST` | 409 | The claim's compare-and-swap lost a race. |
| `not_assignee` | 409 | A first claim of somebody else's `todo` card without `--allow-steal`. |
| `not_claimable` | 409 | A claim on an epic. |
| `EXECUTION_STATE_CORRUPT` | 500 | An `in_progress` work card has no holder (an unowned epic is the designed auto-start state). |
| `REPORT_ROUND_MISMATCH` | 409 | A report names a round other than the card's current round, or duplicates `(task, round)`. |

`status` is a **move, never a patch**: `issue update` has no `--status`, and `PATCH {status}`
is refused with `INVALID_TRANSITION`.

## 10. What is enforced, and what is practice

Skill prose is written against this split:

- **Enforced — loud.** The transition whitelist, the delivery gate, the terminal exits, the
  child-before-parent rule, the review-card invariants (no reopen, no parent/child, no review
  of a review), acceptance authority and claim routing are enforced by the domain
  **and** the database triggers. A refused write returns a named code and usually a fixing
  hint, so an agent acts on that instead of pre-checking the rule. Skill pages do not restate
  these.
- **Enforced — silent.** A write can succeed but do something other than its name suggests —
  `canceled` has no child guard, the create idempotency key collapses look-alike cards,
  `--parent` links nothing, and an epic auto-starts and auto-closes only from certain
  statuses. No refusal will teach these at the moment they matter, so the skill states them.
- **Not enforced — practice.** Three rules an agent must honour on its own:

| Rule | Kind |
|---|---|
| “One card at a time” | **practice** — not enforced |
| “Read candidates, then claim” | **practice** — only the claim gate is enforced |
| `depends_on` blocks claiming | **read rule** — candidates filters only |

The working list of silent traps is in [`../SKILL.md`](../SKILL.md); this section is the
classification they belong to.

## 11. The board's workflow decisions

### Flow A and flow B

A **flow-A** card is an ordinary work card — `meta.flow` absent means A (fail-safe, so an
unknown card is not exempted from review). A **flow-B** card is a review card the loop
dispatched: it carries the structural marker (`review_of_id` / `review_round`) and
`meta.flow=B` as a readable label, and a delivery on it is never itself reviewed. The
structural marker is the predicate: `meta.flow` is **not** a policy input, so a stray
`flow=B` on an ordinary card cannot exempt it from dispatch or auto-accept. One review card
covers one `(original, delivery round)` pair, so a re-delivery after a rejection needs a new
one. The identity marker, the two-round model and the reviewer's protocol are in
[`review-workflow.md`](review-workflow.md).

The board decides what happens after a delivery; the loop executes. One command:

```bash
taskctl issue reconcile --workflow [--dry-run]
  [--reviewer <agent>]
  [--review-aging-ms <n>] [--max-actions <n>] [--board-limit <n>]
```

Without `--workflow`, the command only reconciles containers. With it, the board performs the
reconcile (unless `--dry-run`), reads a bounded snapshot, and returns
`{alerts, actions, changes, summary}`.

Actions are decisions, not effects. The **loop** executes `create_review`, `approve`,
`record_verdict`, `reject_task`, `reject_epic`, `reject_task_finish`, `close_review` and
`cancel_review`; the review card closes **last**, so a crash is recovered next pass. The board
never moves a review card.

The fail-safe rules are part of the decision:

- an unreadable verdict, a stale round, a conflicting verdict, or a report not written by the
  configured reviewer produces an **alert and no write**;
- a **truncated** snapshot applies outcomes but **dispatches nothing**;
- the dispatch key is `loop-review|<ref>|r<round>` — one card per pair;
- a delivery on flow B (a review card) is never itself reviewed;
- self-review is refused: the reviewer may not be the card's assignee/holder;
- the card's `acceptance_mode` decides what an `APPROVE` closes: an `agent` original is
  accepted by the loop (`approve`); a `human` original gets the verdict recorded and its
  review card closed (`record_verdict`) and stays in `in_review` for a person; an `off`
  original is only touched by an ad-hoc review card (`close_review`).

`approve` actions carry `acceptedBy: loop-review`. A `reject_task` / `reject_epic` action
carries `mustFix[]` — the reviewer's numbered findings, or one pointer item when the findings
are prose — and the loop appends each item to the original's frozen acceptance after the move
to `in_progress` (the round bump is what unlocks the baseline). An `APPROVE` whose report
fails the board's own checks — a `met` with no resolvable `evidence[n]`, or no `command`
anchor at all — is not planned: the loop raises `verdict_unsupported` and reopens the review
card under the same bound as an incomplete verdict.

A `cancel_review` on a review card that is still `in_review` is a two-hop move
(`in_review → in_progress → canceled`): the whitelist has no direct
`in_review → canceled` edge, and a canceled review is never recorded as `done`.

Only an **open** review card suppresses the original's `acceptance_card_creation`
SLA row. A `done` review turns that row into an acceptance reminder; a `canceled`
one leaves the standard creation action.
