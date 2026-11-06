# The task lifecycle — statuses, transitions and constraints

> Sections 1–3 and 8. The delivery gate is `delivery.md`; acceptance is `acceptance.md`;
> claims are `claims.md`; containers are `containers.md`; refusals are `refusals.md`; the
> loop's workflow decisions are `workflow.md`.

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

An agent question the **director** can decide never enters `awaiting`: the card stays
`in_progress`, the worker **holds** with `issue wait <ref> --question <id>`, and the director's
**release** (`in_progress → todo`) **interrupts that turn** — a `note` alone is not a settle.
The release leaves the claim cycle, so the next claim is a **fresh session** that reads the card
and comments (ADR 0017); there is no same-round resume across a release. `answered` continues
the same turn; `escalated` / `moved` / `error` park the session, as does `timeout` after one
re-invoke, and the session is resumed by id while the card keeps its claim.

`awaiting` is the **eighth literal but not an eighth column**: an *attention overlay* on an
in-progress card that has stopped to ask a human a question, displayed under `in_progress`.

The question is a **`question` comment**: an agent enters with
`issue move <ref> awaiting --awaiting-reason E2 --question "…"`, and the move and the comment
land in one transaction. The payload the view shows is the newest `question` (falling back to
the newest human comment for a card that predates the kind). **Any human comment** answers
it — whatever its kind — and re-queues the card (`awaiting → todo`) in the same transaction,
because the asking worker is parked. The re-queue leaves the claim cycle: the turn is
**interrupted** and the next claim is a **fresh session** that re-reads the comments (ADR 0017).
The board does not read the text: whether the answer
is a complete decision is judged from its content by the new worker, and an incomplete or
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
in_progress → in_review, blocked, todo, backlog, canceled, awaiting
awaiting    → in_progress, todo, canceled
in_review   → done, in_progress, blocked, canceled
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
- **`in_review → canceled` is one move** (TP-0125). It is terminal, so it does **not** bump the
  delivery round; only the rework exits (`→ in_progress`, `→ blocked`) do (§4).
- **`in_progress → backlog` is one move** (TP-0125): the `todo` hop would re-enter dispatch.
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
| `done` | From `in_review` — **acceptance**, so the delivery gate is not re-consulted — or **directly from `in_progress`** when the card's `acceptance_mode` is `off`. The writer must be allowed by the card's mode (§7); every child must be terminal (`CHILDREN_OPEN`). An `auto` card needs a current-round review card (`REVIEW_REQUIRED`), and a `human` card needs that review **done**; the DB trigger enforces the structural half. A human closing a `human` card also needs the current round's review cards resolved (`REVIEW_PENDING`). A non-empty **acceptance baseline** must be covered by the current round's report (`ACCEPTANCE_UNVERIFIED` / `ACCEPTANCE_INCOMPLETE`, §4a). |
| `canceled` | From `backlog`, `todo`, `in_progress`, `awaiting`, `in_review` or `blocked`. Terminal; from `in_review` it does not bump the round. A claim-cycle exit interrupts the turn; the next claim is fresh (ADR 0017). |

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
8. for `done`: the reviewed card's evidence (`REVIEW_REQUIRED` when there is no
   current-round review), then the human open-review check (`REVIEW_PENDING`);
9. the compare-and-swap write (`VERSION_CONFLICT` on a stale `--if-version`).

Database triggers re-check the hard invariants afterwards; this order is what a `taskctl`
caller sees.

## 8. Creating a card in a status

`issue create` defaults to `todo` and applies an INSERT-shaped gate:

| Initial status | Result |
|---|---|
| `backlog`, `todo`, `blocked`, `canceled` | allowed for a `task` |
| `in_progress` | `VALIDATION_FAILED` — create in `todo`, then claim it |
| `awaiting` | `VALIDATION_FAILED` — a card is not born waiting |
| `in_review`, `done` | `REPORT_REQUIRED` — there is no evidence yet |
| an `epic` in anything but `backlog` / `todo` | `VALIDATION_FAILED` |
