# 0003 — A delivery report's `met` claims must name their anchor before it is written

## Status

Accepted — 2026-10-30. Taken on the human's instruction in the session that found the deadlock
recorded under Context; there was no decision round.

## Context

The acceptance gate (`ACCEPTANCE_INCOMPLETE`, `unsupportedClaimsOf`) requires every `met`
acceptance item in a delivery report to cite an evidence anchor — `evidence[1]` in its note —
for a card whose `acceptance_mode` is `agent`. It ran only on the move to `done`.

A report is bound to its delivery round and cannot be amended. So the rule fired *after* a whole
review had been spent on the report, and the only repair was `in_review → in_progress` (a round
bump), a fresh delivery and a fresh review. On 2026-10-30 four finished, already-APPROVEd cards
(TP-0021, TP-0007, TP-0008, TP-0009) were stuck exactly this way, and the loop retried the same
refused approval every pass for a day; nothing else on the board could move behind them.

The reviewer does not catch it either: a review card is `acceptance_mode = off`, so its own
report is judged by the lighter contract, and the audited report's anchors are never part of the
APPROVE.

## Decision

`deliver` refuses a report whose `met` items name no anchor, with the same
`ACCEPTANCE_INCOMPLETE` code the closing gate uses and `details.source = "delivery"`. The check
sits beside `assertDeliveryCommitAnchor` and shares its exemptions: a review card, an epic (its
evidence is the rollup over its children) and any non-`agent` card.

Only `met` is judged. `not_met` and `partial` stay legal — honest progress is not a claim, and a
worker with nothing to point at says so instead of asserting it.

The closing gate is unchanged and still runs: it is the backstop for a report written around the
service (a raw writer, or a row that predates this rule).

## Why

The rule already existed; only its timing was wrong. Moving it to the writer costs one edit at
the moment the worker still has the anchors in hand, and removes a deadlock that no actor in the
system could clear: the worker could not amend, the reviewer could not approve, the loop could
not accept.

## Consequences

- **A delivery is now judged twice** for an `agent` card: anchors at write, coverage and anchors
  at close. The two are the same arithmetic, so they cannot disagree.
- **Test fixtures must carry an anchor.** A report literal that says `status: "met"` with no
  `note` is now a refused delivery; ~40 fixture sites gained one. This is the cost of the rule
  being real, not a wart to be worked around.
- **The refusal is not a waiver path.** `--no-report` still excuses the delivery, never the
  acceptance gate, so a waived card still cannot reach `done` an unanchored report.
