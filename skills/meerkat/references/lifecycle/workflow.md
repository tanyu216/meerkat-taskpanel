# The board's workflow decisions

> Section 11. The review protocol is `../review-protocol.md`.

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
[`review-protocol.md`](../review-protocol.md).

The board decides what happens after a delivery; the loop executes. One command:

```bash
taskctl issue reconcile --workflow [--dry-run]
  [--assignee <agent>]
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
  review card's assignee produces an **alert and no write**;
- a **truncated** snapshot applies outcomes but **dispatches nothing**;
- the dispatch key is `loop-review|<ref>|r<round>` — one card per pair;
- a delivery on flow B (a review card) is never itself reviewed;
- self-review is refused: the reviewer may not be the card's assignee/holder;
- the card's `acceptance_mode` decides what an `APPROVE` closes: an `auto` original is
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

A `cancel_review` on a review card that is still `in_review` is a **one-hop** move
(`in_review → canceled`, TP-0125); it writes an interrupt request so the pool stops a reviewer
turn that is still running. A canceled review is never recorded as `done`.

Only an **open** review card suppresses the original's `acceptance_card_creation`
SLA row. A `done` review turns that row into an acceptance reminder; a `canceled`
one leaves the standard creation action.
