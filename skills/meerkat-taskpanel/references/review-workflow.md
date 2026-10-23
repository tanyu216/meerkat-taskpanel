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
  review card **when its `review_required` snapshot is 1**. A card at 0 is not dispatched; the
  loop auto-accepts it (see §6). The snapshot is taken at creation from the project's
  `review_policy` (`required` / `optional` / `off`) and is never re-derived from the project
  later.
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

A review card is always `review_required = 0`: it is flow B and is never reviewed again. The
creation resolver forces it, and a DB trigger refuses an INSERT/UPDATE that would mark a
review card as requiring its own review.

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
taskctl issue get <original> --json --actor-kind <kind> --agent <reviewer>
```

If the original is no longer `in_review`, or its `delivery_round` is not the round recorded
on the review card:

1. leave a `note` comment on the review card saying so;
2. stop. Do **not** deliver a verdict, and never move either card.

What the loop does next depends on why the target moved:

- **The original was canceled** — the loop cancels the review card (`cancel_review`).
- **The original is on a later round** — the verdict is history. With review auto-accept on
  the loop closes the review card; with it off the loop raises `review_stale_round` and
  writes nothing.
- **The original is `done` at the same round** — the loop raises `verdict_unreadable` and
  leaves the review card open. A human must cancel it with the two-hop
  `in_review → in_progress → canceled`.

### Read

- the original's description and every acceptance item — the **frozen snapshot** (`acceptance`
  in `issue get --json`); `meta.acceptance` / `meta.acceptance_legacy` only fill in for a
  grandfathered card whose snapshot was never seeded;
- `.meerkat/<original>/card.md` (the authoritative brief) and `.meerkat/<original>/plan.md`
  (the worker's plan, if it exists), plus the notes, evidence, report drafts and attachments
  in that directory;
- the current round's delivery report and its evidence anchors;
- the comment trail, looking for unresolved decision / defect entries;
- for an epic: the rollup report and each child's state.

An `APPROVE` is checked against **two** baselines before it can close anything: the review
report must cover every item of the original's snapshot and of the review card's own snapshot
(the original's list plus the generic review items). A `REJECT` is never checked for coverage
— `partial` / `not_met` is its normal shape. If the baseline itself is wrong, rework the
original (a new round re-freezes it); a reviewer cannot edit it. The pass/fail rules for an
item, and the omission check's `meta.acceptance_derived` flag, are in
[`status-lifecycle.md` §4a](status-lifecycle.md#4a-the-acceptance-baseline).

For an **epic**, the rollup is the delivery. An `APPROVE` additionally needs the epic's
current-round rollup (`is_rollup = 1`) to still match its children; a missing rollup is
`rollup_unverified`, a stale one is `rollup_stale` (both are log-only alerts — the loop plans
no approval). The repair is a rework of the epic, which starts a new round and a fresh
rollup. The rollup's own shape is in
[`status-lifecycle.md` §6](status-lifecycle.md#6-containers-epic).

The omission check is unconditional: every requirement in the description, comments and plan
must map to an acceptance item and to evidence, or be explicitly deferred with a recorded
decision. A narrowed acceptance list, an unexplained deviation from `plan.md`, or a missing
requirement is grounds for `VERDICT: REJECT`. If `plan.md` does not exist, say so and fall back
to the description and acceptance snapshot; absence alone is not a reject. For an epic, check
that the children cover the epic's description and that no child is omitted from the rollup.

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

**Review policy is not acceptance policy.** `projects.review_policy` says whether a card needs
an independent review; the board's acceptance policy says who may close it. They are
orthogonal. The reviewer for a dispatched card is `project.reviewer ?? the deployment
reviewer` (the loop's `--reviewer` / `MEERKAT_TASKPANEL_REVIEWER` / agent config), and the
review card's assignee records the one actually used.

`done` is the board's acceptance act. The board's **policy** and the card's **scope** decide
who may perform it:

<!-- acceptance-matrix:begin -->
| Scope | `human-only` | `both` (default) | `agent-only` |
|---|---|---|---|
| `top_level` | human only | human or `taskd` | any non-human |
| `review` card | human or `taskd` | human or `taskd` | any non-human |
| `child` (has a parent) | any non-human | any non-human | any non-human |
<!-- acceptance-matrix:end -->

Scope precedence is **`hasParent` > review marker > `top_level`**. In agent terms: a worker
agent cannot close a top-level original under the default `both`; under `human-only` the
loop's `APPROVE` becomes a **hold** — it records the verdict and closes the review card, but
leaves the original in `in_review`, so do not close it yourself. Under `agent-only` a human
cannot close a review card; under `both` / `human-only` a human or `taskd` can.

The policy is enforced by the board; `ACCEPTANCE_FORBIDDEN` carries `policy` and `scope` in
its `details`. What the matrix means for the loop, and the `agent-only` × `--auto-accept-reviews=no`
deadlock (`review_cards_unclosable`), are in
[`status-lifecycle.md` §7](status-lifecycle.md#7-acceptance-policy--scope).

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

When the card's `review_required` is 0, steps 2–5 do not run. The board's plan emits
`auto_accept` instead; the loop writes `meta.accepted_by=loop-auto` and moves the original
`in_review → done`. Under `human-only` a **top-level** card is left for the human
(`auto_accept_skipped`, reason `human_only`); a child card still auto-accepts because a human
never closes a child. The loop's `autoAcceptReviews` flag does not gate this path — it only
controls whether the loop closes a review card.

- **APPROVE** — under `both` / `agent-only` (or a child card) the loop writes
  `meta.accepted_by=loop-review` and moves the original `in_review → done`. Under
  `human-only` + a top-level original it holds.
- **REJECT on a work card** — the loop comments the findings, writes `meta.rework_round` and
  moves the original `in_review → in_progress → todo`. It is re-claimed and re-delivered on
  the new round.
- **REJECT on an epic** — the loop creates and links a **fix child** first, then reopens the
  container to `in_progress`; the open child stops `reconcile` from re-closing the container.

Failure isolation is the loop's: one action failing never stops the rest, and the review card
is closed last, so a crash between the original's move and the card's close is recovered on
the next pass.

## 7. Review-side refusals

A review card can be refused by the same codes as any other card — `REPORT_REQUIRED`,
`REPORT_ROUND_MISMATCH`, `ACCEPTANCE_FORBIDDEN`, `REVIEW_PENDING`, `REVIEW_REQUIRED`,
`REVIEW_CARD_MARKER_INVALID`, `VALIDATION_FAILED` — plus `INVALID_TRANSITION` for a reopen or
a direct `in_review → canceled`. The full table, with when each fires, is in
[`status-lifecycle.md` §9](status-lifecycle.md#9-refusals).

## 8. Boundaries

- A review card is an ordinary card of kind `task`: it is claimable, heartbeat-able, and delivered like any
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
