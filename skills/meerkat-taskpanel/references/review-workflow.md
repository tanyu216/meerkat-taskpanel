# The review workflow — flow A, flow B, and the verdict contract

> One delivery, one independent review, one verdict. `status-lifecycle.md` is the state
> model; `cli.md` is the command surface. This page is the agent-facing contract: what a
> review card is, how to recognise one, what a reviewer writes, and who may close what.

## 1. Two flows

| Flow | What it is | Who writes the marker |
|---|---|---|
| **A** | An ordinary work card awaiting a delivery verdict. | Nobody — `meta.flow` is absent, and absent means A. |
| **B** | A review card that carries a `VERDICT:` report for a flow-A card. | The loop, when it dispatches: `meta.flow=B`. |

- A flow-A card that reaches `in_review` is dispatched to the configured reviewer as a
  review card.
- A flow-B card is **never dispatched for review again**. A delivery on a review card is the
  end of the chain, not a new review target.
- `meta.flow` is a loop convention, not the review-card predicate: an absent value is A
  (fail-safe — an unknown card is not exempted from review), and detection reads the
  structural marker below.

## 2. The review card's identity

A review card is an ordinary `kind=task` card. Its identity is two **immutable columns**:

| Column | Meaning |
|---|---|
| `review_of_id` | The internal id of the card it audits. |
| `review_round` | The original's `delivery_round` this review audits. |

The board also mirrors them into `meta.review_of` (the original's identifier) and
`meta.review_round` (the integer round) so the loop and the SLA patrol can match on the wire.
The `review` label is a discovery aid; it is **never** the predicate. A card is a review card
when `issue get <ref> --json` carries `review_of_id` (or, for a legacy row, `meta.review_of`).

### Two rounds, deliberately different

- `review_round` — the **original's** round being audited.
- the review card's own `delivery_round` — the round its own report is stamped with. A fresh
  review card starts at `1`, even when it audits the original's round 3.

A re-delivery after a rejection is a **new round of the original**, so it needs a **new review
card**. One review card covers one `(original, delivery round)` pair; the loop's idempotency
key is `loop-review|<original-ref>|r<round>`.

## 3. The reviewer's protocol

### Step 0 — the review is still valid

```bash
taskctl issue get <original> --json --actor-kind <host> --agent <reviewer>
```

If the original is no longer `in_review`, or its `delivery_round` is not the round recorded
on the review card:

1. leave a `note` comment on the review card saying so;
2. stop. Do **not** deliver a verdict — the loop will close the review card.

### Read

- the original's description and every acceptance item (`meta.acceptance` /
  `meta.acceptance_legacy`);
- the current round's delivery report and its evidence anchors;
- the comment trail, looking for unresolved decision / defect entries;
- for an epic: the rollup report and each child's state.

If the original carries `meta.acceptance_derived = "yes"`, its acceptance list was derived by
the worker at claim time. Check that it covers every requirement in the description and
comments; a list that narrows the card is grounds for `VERDICT: REJECT`. For an epic, check
that the children cover the epic's description.

### Deliver

Write the verdict **on the review card**, not on the original:

```bash
taskctl report template <review-ref>
taskctl issue deliver <review-ref> --report-file - <attribution flags>
```

The report's `conclusion` must have **`VERDICT: APPROVE`** or **`VERDICT: REJECT`** as its
**first line**. Everything after that line is carried into the rework comment, together with
the report's `leftovers` — this is where the reviewer writes its findings once.

### Do not move

- Do not claim or heartbeat the original.
- Do not move the original.
- Do not move the review card. The loop applies the verdict and closes the review card.

The board parses the verdict and the loop performs the writes. A reviewer that moves a card
is racing the acceptor.

## 4. Acceptance policy and scope

`done` is the board's acceptance act. The board's **policy** and the card's **scope** decide
who may perform it; the full matrix is in
[`status-lifecycle.md §7`](status-lifecycle.md#7-acceptance-policy--scope). In agent terms:

- **Top-level original, `human-only`** — a human accepts. The loop's `APPROVE` becomes a
  **hold**: it records the verdict and closes the review card, but leaves the original in
  `in_review`. Do not close it yourself.
- **Top-level original, `both` (default)** — a human or the board (`taskd`, i.e. the loop)
  accepts. A worker agent cannot.
- **Top-level original, `agent-only`** — any non-human writer accepts.
- **Review card** — a human or `taskd` closes it under `both` and `human-only`; under
  `agent-only` only a non-human writer can. (A human cannot close a review card on an
  `agent-only` board.)
- **Child card (has a parent)** — only a non-human writer accepts, under every policy. Scope
  precedence is **`hasParent` > review marker > `top_level`**.

The policy is enforced by the board. There is no `taskctl` command that reads it: attempt the
move and handle `ACCEPTANCE_FORBIDDEN` — its `details` carry `policy` and `scope`. The loop's
`--acceptance` flag is an **advisory local copy** for diagnostics; it never overrides the
board.

## 5. The human's side

- **`REVIEW_PENDING`** — a human closing a top-level original while a **current-round** review
  card is still open. Let the review finish (or cancel an abandoned review card) first.
- **A held approval** — under `human-only`, an `APPROVE` leaves the original in `in_review`
  with `meta.review_verdict=approve` / `review_verdict_round`. Accept it with
  `taskctl issue move <original> done`.
- **Cancel an abandoned review card** — a review card in `in_review` cannot go directly to
  `canceled`; the move is two hops: `in_review → in_progress → canceled`.
- **Reopen the original, never the review card.** A review card is a loop artefact and cannot
  be reopened; reopening the original produces the next round's review.

## 6. What happens after a delivery

```text
worker delivers            original in_review (round N)
board dispatches           review card created, review_round = N
reviewer wakes             claims the review card, reads, delivers VERDICT
loop applies               APPROVE → accept / hold; REJECT → rework round N+1
loop closes last           review card → done (or canceled if the original was canceled)
```

- **APPROVE** — under `both` / `agent-only` (or a child card) the loop writes
  `meta.accepted_by=loop-review` and moves the original `in_review → done`. Under
  `human-only` + a top-level original it holds.
- **REJECT on a task** — the loop comments the findings, writes `meta.rework_round` and moves
  the original `in_review → in_progress → todo`. It is re-claimed and re-delivered on the new
  round.
- **REJECT on an epic** — the loop creates and links a **fix child** first, then reopens the
  container to `in_progress`; the open child stops `reconcile` from re-closing the container.
- **One action failing never stops the rest**, and the review card is closed last, so a crash
  between the original's move and the card's close is recovered on the next pass.

## 7. Review-side refusals

| Code | When |
|---|---|
| `REPORT_REQUIRED` | A move to `in_review` without a delivery report for the current round (or the audited waiver). Creating a card in `in_review` / `done`. |
| `REPORT_ROUND_MISMATCH` | A report names a round other than the card's current one, or duplicates `(task, round)`. |
| `ACCEPTANCE_FORBIDDEN` | The writer may not accept under the policy × scope matrix. |
| `REVIEW_PENDING` | A human closes a top-level original with a current-round review card still open. |
| `VALIDATION_FAILED` | `review_of` names a card that is not `in_review`; `review_of` names another review card; `review_round` is not the original's current `delivery_round`; the review card is not `kind=task`; a malformed round. |
| `INVALID_TRANSITION` | A review card cannot be reopened; `in_review → canceled` does not exist (use the two-hop cancel). |

## 8. Boundaries

- A review card is a normal task: it is claimable, heartbeat-able, and delivered like any
  other card. It is special only in what its report must contain and in who may close it.
- Do not promote a review card to an epic, and do not derive an acceptance list on one.
- A `parent` edge is refused when either end is a review card (`VALIDATION_FAILED`,
  `details.field = source|target`, `details.type = parent`), even with `--force`. Attach the
  edge to the original work card instead. Existing edges are not repaired; raw repository
  writes remain a bypass.
- The original must be `in_review` at review-card creation (`VALIDATION_FAILED` otherwise).
  Deliver first: `taskctl issue deliver <original> --report-file -`; then create the review
  card for the original's current round. The reviewer's Step 0 still guards a target that
  moved between dispatch and wake.
