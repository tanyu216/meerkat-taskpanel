# The task lifecycle — statuses, transitions and constraints

> One card's state model. `cli.md` is the command surface; `card-schema.md` is the card file.

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

- **`done` and `canceled` are terminal, but may be reopened to `todo`.** The reopen is audited
  (`issue reopen <ref> --reason "<why>"`, at least 8 characters), starts a **new delivery
  round**, clears the archive and releases the idempotency key. `in_progress` is deliberately
  not a reopen target: a reopened card has no claim holder and must be claimed again.
  Review cards are refused — reopen the card they review, and the loop issues the next round's
  review.
- `kind` changes one thing: an **`epic`** has one extra edge (`todo → in_review`) and is never
  claimable. A **`deploy`** card follows the ordinary `task` table — claimable, but never
  offered by `issue candidates`.

## 2. The whitelist

Only these moves exist; every other ordered pair is refused — `INVALID_TRANSITION`, or
`TERMINAL_STATE` out of `done`/`canceled`.

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
| `awaiting` | Only `in_progress → awaiting`, naming `--awaiting-reason E1`…`E5`. Leaving clears the reason. `awaiting → blocked`/`in_review`/`done` are forbidden. |
| `done` | Only from `in_review` — **acceptance**, so the delivery gate is not re-consulted. The writer must be allowed by policy and scope (§7); every child must be terminal (`CHILDREN_OPEN`). A card whose `review_required` is 1 needs a current-round APPROVE review (`REVIEW_REQUIRED`; the DB trigger checks that a review card reached the reviewer). A human closing a top-level card also needs the current round's review cards resolved (`REVIEW_PENDING`). |
| `canceled` | From `backlog`, `todo`, `in_progress`, `awaiting` or `blocked` — **never directly from `in_review`**. Terminal. |

### The order the guards run

The first refusal wins, so the error you see is stable:

1. waiver shape (`--no-report` only to `in_review`, never with a report, reason ≥ 8 chars);
2. the `awaiting` / `blocked` reason vocabulary;
3. the whitelist (`INVALID_TRANSITION` / `TERMINAL_STATE`);
3a. for a terminal source: the audited reopen reason (≥ 8 characters) and the review-card
   refusal;
4. for `done`: acceptance authority (`ACCEPTANCE_FORBIDDEN`);
5. for `in_review` and `done`: children terminal (`CHILDREN_OPEN`);
6. for `todo → in_progress`: the claim gate (`not_assignee`, `EXECUTION_ACTIVE`,
   `CLAIM_LOST`, `not_claimable`);
7. for `in_review`: the delivery gate (`REPORT_REQUIRED`);
8. for `done`: the card's own `review_required` evidence check (`REVIEW_REQUIRED` when there is
   no current-round review, `REVIEW_PENDING` when one is still open), then the human/top-level
   open-review check (`REVIEW_PENDING`);
9. the compare-and-swap write (`VERSION_CONFLICT` on a stale `--if-version`).

Database triggers re-check the hard invariants afterwards; this order is what a `taskctl`
caller sees.

## 4. The delivery gate and the delivery round

A card may not enter `in_review` without evidence **for the current delivery round** — a
report counts only for the round it was written in.

- A report with `origin: "delivery"` for the card's current `delivery_round`. Imported reports
  (`origin: "import"`) are history; they never open the gate.
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
| everything else | unchanged |

A rework voids the previous report **and** waiver; the next delivery needs fresh evidence.

The compliant path writes the report and moves atomically:

```bash
taskctl report template <ref>                 # fill the TODO lines
taskctl issue deliver <ref> --report-file -   # always lands in in_review; no --to
```

A report with an explicit non-current `round` is `REPORT_ROUND_MISMATCH` — a report-write
error, not a move refusal. A refusal names the round and the fixing command:

```console
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
```

## 5. Claims and heartbeats

- **Only `todo` is claimable.** `todo → in_progress` and `issue claim` are the same path;
  `issue claim` accepts only `todo`/`in_progress`.
- **An `epic` is never claimable** (`not_claimable`). A **`deploy`** card is claimable but
  withheld from every `issue candidates` pool.
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
  one is `done`, and there is evidence to roll up, it writes the rollup report and moves the
  epic. Auto-close works from `todo`, `in_progress` and `blocked`; acceptance stays separate.
- **Nothing delivered, nothing to close.** Close by hand: `report template`, then
  `issue deliver`.
- **`todo → in_review` is the epic-only repair edge** for a child attached after the container
  finished; it still passes the delivery gate.
- **No parent closes over an open child.** `CHILDREN_OPEN` guards both `in_review` and `done`.
- **Evidence is the children's, not the container's.** The rollup reads each child's latest
  delivery report; the container's own earlier reports prove nothing, and a child delivered
  under `--no-report` contributes no anchor. With no child evidence the container stays open.
- **A terminal container never rolls up.** The sweep scans non-terminal epics only, so a
  `done`/`canceled` card promoted to an epic will never close over children attached later.
  A delivered card starts a new container instead.
- **Status at promotion.** The board starts a container only from `todo` and closes it from
  `todo`, `in_progress` or `blocked`; `backlog` and `awaiting` need a move first, and an
  `in_review` epic that gains a child needs a rework back to `in_progress`.

`issue reconcile` replays the start/close rules over every non-terminal epic and is
idempotent; the ordinary path does not need it.

## 7. Acceptance: policy × scope

`done` is the board's acceptance act; who may perform it depends on the policy and the card's
scope.

| Scope | `human-only` | `both` (default) | `agent-only` |
|---|---|---|---|
| `top_level` | human only | human or `taskd` | any non-human |
| `review` card | human or `taskd` | human or `taskd` | any non-human |
| `child` (has a parent) | any non-human | any non-human | any non-human |

Scope precedence is **`hasParent` > review marker > `top_level`**.

**Review policy is a separate axis.** `review_required=1` adds a precondition (a current-round
APPROVE review) but does not change who may close the card. `projects.review_policy`
(`required` / `optional` / `off`, default `optional`) sets the snapshot at creation; a later
project change does not rewrite it. A card at `review_required=0` skips the review card and is
auto-accepted by the loop when `taskd` may accept its scope; under `human-only` a top-level
card still waits for a human, while a child still auto-accepts. The loop's
`--auto-accept-reviews` flag only controls closing review cards, not this path.

- A worker agent delivers to `in_review` and **does not close a top-level card** under the
  default policy (`ACCEPTANCE_FORBIDDEN`).
- A **child** card is the opposite: only a non-human writer may close it.
- `REVIEW_PENDING` applies only when a **human** closes a **top-level** card, and only to the
  **current round's** review cards; `taskd` is exempt.
- `--actor-kind human` is reserved; a human write uses `--as-human`.
- The policy comes from `TASKD_ACCEPTANCE_POLICY` / the environment / the install-root `.env`,
  defaulting to `both`.
- The board enforces the policy; there is **no `taskctl` command that reads it**. Attempt the
  move and handle `ACCEPTANCE_FORBIDDEN` — its `details` carry `policy` and `scope`. The loop's
  `--acceptance` is an advisory local copy, never authoritative.
- Under `human-only`, a top-level `APPROVE` is **held**: the loop records
  `meta.review_verdict=approve` / `review_verdict_round`, closes the review card, and leaves
  the original `in_review`; the human accepts it with `issue move <original> done`.
- Under `agent-only`, a **human cannot close a review card** (the review scope allows only a
  non-human writer), even though review cards are human-closable under `both` / `human-only`.
  Paired with `--auto-accept-reviews=no` nobody closes them: the board raises
  `review_cards_unclosable` for each open card and the loop warns at startup.

## 8. Creating a card in a status

`issue create` defaults to `todo` and applies an INSERT-shaped gate:

| Initial status | Result |
|---|---|
| `backlog`, `todo`, `blocked`, `canceled` | allowed for a `task` |
| `in_progress` | `VALIDATION_FAILED` — create in `todo`, then claim it |
| `awaiting` | `VALIDATION_FAILED` — a card is not born waiting |
| `in_review`, `done` | `REPORT_REQUIRED` — there is no evidence yet |
| an `epic` in anything but `backlog` / `todo` | `VALIDATION_FAILED` |

The markdown importer is the exception: it writes history directly, importing
`in_review`/`done` cards. Imported reports never satisfy a later delivery gate.

## 9. Refusals

| Code | HTTP | When |
|---|---|---|
| `INVALID_TRANSITION` | 409 | The pair is not on the whitelist; `PATCH {status}`; heartbeat on a non-`in_progress` card; `issue claim` on a status other than `todo`. |
| `TERMINAL_STATE` | 409 | The source is `done` or `canceled` and the target is not `todo` (or `deliver` is attempted from it). |
| `REPORT_REQUIRED` | 422 | Entering `in_review` without a current-round report or waiver; creating in `in_review`/`done`. |
| `ACCEPTANCE_FORBIDDEN` | 409 | The writer may not move the card to `done` under the policy/scope matrix. |
| `CHILDREN_OPEN` | 409 | `in_review` or `done` while a child is non-terminal. |
| `REVIEW_PENDING` | 409 | A human closing a top-level card with current-round review cards still open; or a `review_required` card whose current-round review has no APPROVE verdict yet. |
| `REVIEW_REQUIRED` | 409 | A `review_required` card reaching `done` with no current-round review card. A human may waive it with `issue update <ref> --review no --reason "<why>"`. |
| `REVIEW_CARD_MARKER_INVALID` | 409 | A write tried to set `review_required = 1` on a review card (flow B). |
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

| Rule | Enforced by |
|---|---|
| Transition whitelist | domain `ALLOWED_TRANSITIONS` + DB trigger |
| Delivery gate | domain + DB trigger |
| Terminal statuses leave only for `todo` | domain + DB trigger (the reason is service-only) |
| Children terminal before a parent closes | service + DB trigger |
| Acceptance authority | **service only** — the actor is not a column |
| Claim routing and freshness | service + compare-and-swap |
| “One card at a time” | **practice** — not enforced |
| “Read candidates, then claim” | **practice** — only the claim gate is enforced |
| `deploy` cards never auto-offered | **read rule** — explicit dispatch may claim one |
| `depends_on` blocks claiming | **read rule** — candidates filters only |

## 11. The board's workflow decisions

### Flow A and flow B

A **flow-A** card is an ordinary work card; `meta.flow` absent means A (fail-safe — an
unknown card is not exempted from review). A **flow-B** card is a review card the loop
dispatched; it carries `meta.flow=B`, and a delivery on a flow-B card is never itself
reviewed. The review-card predicate is the structural `review_of_id` (with `meta.review_of`
as the legacy fallback), never the `review` label and never `meta.flow`.

The review card audits a **specific delivery round**: `review_round` is the original's round,
while the review card's own `delivery_round` is the round its verdict report is stamped with
(a fresh review card starts at 1). A re-delivery after a rejection is a new round and needs a
new review card; one review card covers one `(original, delivery round)` pair.

The board decides what happens after a delivery; the loop executes. One command:

```bash
taskctl issue reconcile --workflow [--dry-run]
  [--reviewer <agent>] [--auto-accept-reviews yes|no]
  [--review-aging-ms <n>] [--max-actions <n>] [--board-limit <n>]
```

Without `--workflow`, the command only reconciles containers. With it, the board performs the
reconcile (unless `--dry-run`), reads a bounded snapshot, and returns
`{alerts, actions, changes, summary}`.

Actions are decisions, not effects. The **loop** executes `create_review`, `approve`,
`approve_hold`, `reject_task`, `reject_epic`, `reject_task_finish`, `close_review` and
`cancel_review`; the review card closes **last**, so a crash is recovered next pass. The board
never moves a review card.

The fail-safe rules are part of the decision:

- an unreadable verdict, a stale round, a conflicting verdict, or a report not written by the
  configured reviewer produces an **alert and no write**;
- a **truncated** snapshot applies outcomes but **dispatches nothing**;
- **one review card per `(original, delivery round)`**, keyed `loop-review|<ref>|r<round>`;
- a delivery on flow B (a review card) is never itself reviewed;
- self-review is refused: the reviewer may not be the card's assignee/holder;
- `autoAcceptReviews = no` only withholds the review card's close; the verdict on the
  original is still applied;
- the board's acceptance policy decides `approve` vs `approve_hold`.

`approve` actions carry `acceptedBy: loop-review`; `approve_hold` actions carry `held`.

A `cancel_review` on a review card that is still `in_review` is a two-hop move
(`in_review → in_progress → canceled`): the whitelist has no direct
`in_review → canceled` edge, and a canceled review is never recorded as `done`.

Only an **open** review card suppresses the original's `acceptance_card_creation`
SLA row. A `done` review turns that row into an acceptance reminder; a `canceled`
one leaves the standard creation action.

## 12. Choosing a status

- Not released → `backlog`. Released, not started → `todo`. Working → `in_progress` (a claim).
- Stopped to ask a human a question → `awaiting` with `E1`–`E5`; put the question in a comment.
- Stopped on anything else → `blocked`, with an optional `--blocked-reason`.
- Evidence attached, awaiting a verdict → `in_review` (`issue deliver`).
- Accepted → `done`, by whoever the policy/scope matrix allows.
- Abandoned → `canceled`; from `in_review` that is two hops.
- “Reopen” → `done`/`canceled` → `todo`, with `issue reopen <ref> --reason "<why>"` (audited;
  starts a new round). Review cards cannot be reopened — reopen the original.

`blocked` is the card's own declaration that it cannot proceed; `awaiting` is a question
addressed to a human. `blocked_reason` is optional and cleared on exit; `blocked_at` is kept
because it dates the last blockage. See
[`card-schema.md`](card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).
