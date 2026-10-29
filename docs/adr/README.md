# Architecture decision records

One file per durable decision, `NNNN-<slug>.md`, numbered in the order they were recorded and
never renumbered. The record is the decision; [`docs/architecture.md`](../architecture.md) is the
system that resulted from the recorded decisions, and [`docs/tech-spec.md`](../tech-spec.md) is
what a change must comply with.

## Status vocabulary

| Status | Means |
|---|---|
| `Proposed` | Written, not yet decided |
| `Accepted` | The human accepted it (E5); a change binds to it |
| `Accepted (reconstructed) — E5 pending` | Read back from the tree after the fact. It binds today's behaviour, but a human has not yet accepted it, so it cannot be cited as approval for a further change |
| `Superseded by ADR-NNNN` | Replaced; kept for history, never edited |

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-architecture-style.md) | Layered modulith; DDD rejected | Accepted (reconstructed) — E5 pending |
| [0002](0002-stack-bundle.md) | Node 22 + `node:sqlite`, zero runtime dependencies; Vue built offline | Accepted (reconstructed) — E5 pending |

## Writing one

Keep it short: Context (1–3 sentences), Decision, Why. Add Status, Considered Options and
Consequences when they help. A decision that changes a rule in the standard names the rule it
replaces and why. Do not edit an accepted ADR to reverse it — write a new one and mark the old
`Superseded`.
