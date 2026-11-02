# Accepting a delivered card (`in_review → done`)

Acceptance is the board's act of closing delivered work. It is not a status read and not a
kindness: it says the current round's evidence covers the frozen contract. The card's own
`acceptance_mode` names who may perform it.

The one home of the matrix and the gate is
[`../../meerkat/references/lifecycle/acceptance.md`](../../meerkat/references/lifecycle/acceptance.md)
§7; the rules below are what chat needs to decide whether to offer the close.

## Who may close

| Card mode | Review card | Who may move it to `done` |
|---|---|---|
| `off` | none | the deliverer (any actor kind), or a human; `in_progress → done` is allowed |
| `auto` | yes — an agent reviewer | the loop after a current-round `APPROVE`; anyone but the reviewer; a human may always |
| `human` | yes — an agent reviewer | a human only, after the current-round review is finished |
| a review card | — | a human, or any actor but its reviewer — never the one who wrote the verdict |

Consequences for chat:

- A `human` card is the human's to close, after its current-round review is finished. Offer it;
  do not close it for them without the close being shown and confirmed.
- An `auto` card normally reaches `done` on the loop's write after an `APPROVE`. A human may
  still close it as a fallback, but only after saying so and after the verdict is on the board.
- A review card is closed by a human or another actor — **never** the one who wrote the verdict.
- `canceled` is abandonment, never a way to close a card. It has no child guard and leaves work
  orphaned.

## The evidence to read first

```bash
taskctl issue get <ref> --json --include comments --include reports
```

Read:

- `acceptance_mode` — the closer selector;
- `delivery_round` — the round the gate is watching;
- `acceptance[]` — the frozen baseline (never `meta.acceptance`);
- `reports[]` — find the report whose `round` is the current `delivery_round`;
- `comments[]` — the delivery note, a waiver, or a reviewer's finding.

A report counts only for the round it was written in. A rework (`in_review → in_progress`,
`in_review → blocked`) bumps the round and voids the old report and waiver; the next delivery
needs fresh evidence. A waiver (`--no-report --reason`) excuses the delivery gate for one round,
**not** acceptance.

## The coverage test

For the current-round report, every `acceptance[]` item must appear by its text:

- `met` or `not_applicable` (with a non-empty note) passes;
- `partial` or `not_met` blocks;
- an item beyond the baseline also blocks if it is `partial`/`not_met` — the report itself says
  work is unfinished;
- an empty baseline is vacuous and allowed;
- on an `auto` or `human` card, each `met` must cite an `evidence[n]` that resolves within the report
  (`ACCEPTANCE_INCOMPLETE`, `details.unsupported`).

Show the human the arithmetic, not a verdict: "4/4 items covered; item 3 is `partial` and
blocks". A report that covers the baseline is necessary, not sufficient — the reviewer judges
whether the baseline covers the description and the plan.

## Review cards

A card is a review card when the one identity reader says so (`review_of_id` / `review_round`
on the wire; `role: review` in `issue get --json`). The `review` label is a discovery aid, not
the predicate.

- The review report's first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.
- `review_round` is the **original's** audited round; the review card's own `delivery_round` is a
  different number. Find the review card for the current original round:
  `taskctl issue list --review-of <ref> --json`, then filter `review_round`.
- An `APPROVE` on an `auto` card lets the loop close it. A human may close it too, but the
  verdict must be present.
- A `human` card can only be closed after its current-round review is **finished**;
  `REVIEW_PENDING` applies to a person closing it while that review is still open. An `auto`
  card's human fallback is allowed once the current-round `APPROVE` exists.

## The close

```bash
taskctl --as-human issue move <ref> done
```

Before running it, show the human:

- the card, its mode and current round;
- the report summary and the coverage arithmetic;
- the review verdict, if any;
- the exact command.

After it, **re-read** the card and report `status: done` and the new `version`. If the move was
refused, do not retry it until the missing fact is supplied.

## Refusals and what they mean

| Code | Meaning | Next act |
|---|---|---|
| `ACCEPTANCE_FORBIDDEN` | the caller is not the closer the mode names (details carry `mode` / `reviewCard`) | hand it to the human, or leave it to the loop |
| `ACCEPTANCE_UNVERIFIED` | no current-round report (a waiver does not excuse acceptance) | ask for a re-delivery, or the human's explicit override path — never SQL |
| `ACCEPTANCE_INCOMPLETE` | the report exists but does not cover every item | show the missing/losing items; the work needs a rework or evidence |
| `REVIEW_PENDING` | a `human` card still has an open current-round review | wait for the verdict, or close only when the board permits |
| `ROLLUP_REQUIRED` / `ROLLUP_STALE` | an epic needs a current rollup that names every live child | re-deliver the rollup; do not close the epic by canceling it |
| `INVALID_TRANSITION` / `TERMINAL_STATE` | the card is not in `in_review` (or the move is not an edge) | read the card; do not force |
| `VERSION_CONFLICT` | the card changed since the read | re-read once and retry with the fresh `--if-version` |

Never edit the database, never use `--force` to bypass an acceptance refusal, and never close a
card whose current-round evidence you have not read.
