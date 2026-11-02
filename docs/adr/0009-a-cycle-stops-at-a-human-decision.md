# 0009 — A cycle stops at a human decision

## Status

Proposed.

## Context

The supervisor's counters bounded *attempts* but not *cycles*. `delivery_round` had no cap,
so a card could be rejected, reworked and rejected again forever; the doctor reported
`delivery_round >= 4` and did nothing. Review exhaustion raised an alert and left the
original with no decision path. Admission deferrals alerted once and were retried every
pass. A failed dispatch left the board claim `in_progress` until the stale recovery. A
session that could neither resume nor replay re-threw every thirty minutes. In each case the
loop named the problem and then kept doing it.

Two facts constrain the answer. `awaiting` is reachable **only** from `in_progress`
(`tr_tasks_transition`), while a looping card is normally `todo` or `in_review`; and `blocked`
is reachable from every active status and is already watched by the SLA's
`blocked_clarification` row (120/1440 minutes).

## Decision

- **A loop is parked, never cancelled and never closed.** The board's workflow plan emits
  `hold_card`; the loop executes it. The card becomes `blocked` with
  `blocked_reason=decision` (a decision loop) or `resource`/`external` (an execution fault),
  plus a `question` comment naming the cycle and the E-code (E2 for the acceptance baseline).
  The E-code lives in the question and `meta.loop_hold_e_code`, never in a dishonest status
  reason.
- **The counters stay on the card, the hold is an epoch.** The board decides from
  `delivery_round − meta.loop_hold_round` (default bound 4, `--rework-max-rounds`); a hold
  writes `meta.loop_hold_round` at the round it happened. A marker at the same round
  re-emits the action as `held: true`, so a crash between the meta write and the move is
  recovered without duplicating the question. A human who moves the card back starts a fresh
  bounded epoch — never an unbounded one.
- **Execution faults the board cannot see are held by the loop.** Admission failures back
  off exponentially from the third consecutive failure and park at the fifth
  (`blocked/external`); a dispatch failure hands the claim back to `todo` immediately and
  parks at the third (`blocked/resource`); a worker session that cannot be restored parks at
  once; a crash-replay row is failed after three recoveries and its card parked.
- **No auto-resume from `blocked`.** Auto-resume would reproduce the cycle with no new
  information; the explicit human move is the audit point.
- **The doctor reports; the workflow pass now also acts.** The replaced rule was "the doctor
  reports the loop thresholds and never acts on them" (`doctor.mjs:66-72`). `loop doctor`
  still only reports, but a card at the bound is now parked by the plan.

## Why

- `blocked(decision)` is the only dishonest-free state reachable from every active status.
  A two-hop `in_review → in_progress → awaiting` would fabricate a claim with no owner.
- The board owns the counters (`delivery_round`, `meta.review_retry`) and already produces
  the workflow plan; a loop-side re-derivation would be a second decision source.
- Parking is reversible and auditable: the question is the record, the SLA is the timer, and
  the doctor is the queue.

## Considered options

- **Escalate to `awaiting` from every status.** Rejected: the state machine forbids it, and
  widening it would let a card await with no attempt in flight.
- **Auto-cancel after N rounds.** Rejected: it destroys the work and the evidence, and it is
  the one outcome the loop must never choose for a human.
- **Keep alert-only exhaustion.** Rejected: it is the failure this ADR exists to close.

## Consequences

- A new workflow action (`hold_card`) and its frozen shape; the CLI gains
  `--rework-max-rounds` on `loop run` and `issue reconcile`, and `--recover-wedged` on the
  loop. The contract snapshots, `skills/meerkat/references/cli.md` and `.env.example` change
  together.
- `loop doctor` lists held cards, awaiting cards, director rows that exhausted their bound,
  unowned `todo` cards past the route window, and processing rows whose agent child
  outlived the turn bound; the SLA carries decision holds through
  `blocked_clarification`, while execution holds are visibility-only.
- A route turn is verified against the board (assigned, or no longer `todo`); one that never
  assigns is retried twice, then its card is parked the same way.
- The resilience baseline's seven legs are enforced by `npm test` (the crash guard landed
  first; `poolStatus` verdicts and orphan-aware recovery finished the set).
