# Architecture decision records

One file per durable decision, `NNNN-<slug>.md`, numbered in the order they were recorded and
never renumbered. The record is the decision; [`docs/architecture.md`](../architecture.md) is the
system that resulted from the recorded decisions, and [`docs/tech-spec.md`](../tech-spec.md) is
what a change must comply with.

## Status vocabulary

| Status | Means |
|---|---|
| `Proposed` | Written, not yet decided |
| `Accepted` | The human accepted it (E5); a change binds to it. A decision read back from the tree says so on its own line and keeps the reading's provenance |
| `Accepted (reconstructed)` | Read back from the tree after the fact and accepted on that basis; it binds, and the ADR names the tree state it was read from |
| `Accepted — E5 pending` | Read back from the tree but **not yet accepted**: it describes today's behaviour, and it cannot be cited as approval for a further change |
| `Superseded by ADR-NNNN` | Replaced; kept for history, never edited |

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-architecture-style.md) | Layered modulith; DDD rejected | Accepted (reconstructed) |
| [0002](0002-stack-bundle.md) | Node 22 + `node:sqlite`, zero runtime dependencies; Vue built offline | Accepted (reconstructed) |
| [0003](0003-delivery-report-anchors-at-write.md) | A `met` claim needs its evidence anchor at delivery, not only at close | Accepted |
| [0004](0004-actor-kind-system.md) | The board writes as `system`; acceptance is decided by evidence, not by actor kind | Superseded by ADR 0018 (identity half only) |
| [0005](0005-the-loop-ships-with-the-board.md) | The loop ships in the board's package, so the board-interface gate is removed | Accepted |
| [0006](0006-first-class-worker-sessions.md) | A worker is its own pooled session, resumed by id in the same round; replay when the native session is gone | Accepted |
| [0007](0007-roles-are-skills-and-the-director-decides.md) | Roles are standalone skills; installation location routes the platform; `meerkat-director` decides and the control turn is gone | Accepted |
| [0008](0008-a-worker-holds-for-the-ladder.md) | A worker holds with a bounded `issue wait`; the director settles by releasing the card; escalation parks and resumes by id | Accepted |
| [0009](0009-a-cycle-stops-at-a-human-decision.md) | A card that keeps coming back is parked as `blocked(decision)`, never auto-cancelled; the board decides, the loop executes | Accepted |
| [0010](0010-director-consumes-the-required-handoff.md) | An accepted card's required handoff is a director triage decision: create/seed/link the downstream cards or record that none is needed | Accepted |
| [0011](0011-card-acceptance-is-one-word.md) | A card carries one acceptance word (`off` · `auto` · `human`); projects carry no default; `human` may close after the review finishes | Proposed |
| [0012](0012-role-kind-order-comes-from-the-install.md) | The install-time `--target` order is the role kind preference; a kind the order omits is appended, never excluded | Accepted |
| [0013](0013-the-role-catalog-is-a-local-taskctl-file.md) | The discovered role set is published as a local `roles.json`; the scan set is the discovered worker roles; the scan-set key is removed | Accepted |
| [0014](0014-a-review-is-a-third-kind.md) | A review is a third card `kind`; the marker stays its identity and the database ties them together | Proposed |
| [0015](0015-stale-claim-recovery-keeps-the-assignee.md) | Stale-claim recovery keeps the assignee's role; a non-assignee takeover needs the audited override; Worker is a formal, commented fallback | Accepted |
| [0016](0016-turn-timeouts-are-transient.md) | A turn timeout has its own counter and backoff and returns the card to `todo`, never `blocked`; the loop pulses the claim and the deadline includes the opener | Accepted |
| [0017](0017-a-claim-cycle-exit-interrupts-the-turn.md) | Leaving the claim cycle interrupts the turn, records `interrupted`, and discards the session; the next claim is fresh | Proposed |
| [0018](0018-board-is-the-one-automation-identity.md) | The board has one automation identity, `Board` (kind `system`); `system` and `Orchestrator` stop being actor ids | Accepted |
| [0019](0019-the-reviewer-may-spawn-one-review-subagent.md) | The reviewer may spawn one fresh-context, read-only, one-shot review subagent; no ledger returns | Superseded by ADR 0020 (tool-surface claims; the one-shot child stands) |
| [0020](0020-full-tool-access-by-default.md) | Every dispatched session runs with the full tool set; the reviewer's write tools are denied; the `--allow-all-tools` opt-in is retired | Accepted (director-lane claim superseded by ADR 0023) |
| [0023](0023-the-director-stays-read-only.md) | The director and reviewer lanes are read-only; the worker keeps the full tool set; a fix is a card, never a control-lane edit | Accepted |

## Writing one

Keep it short: Context (1–3 sentences), Decision, Why. Add Status, Considered Options and
Consequences when they help. A decision that changes a rule in the standard names the rule it
replaces and why. Do not edit an accepted ADR to reverse it — write a new one and mark the old
`Superseded`.
