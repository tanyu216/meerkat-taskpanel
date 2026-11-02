# Decision policy — the shared core

This is the director skill's decision authority. It is the shared core: the four decision
files named below and `rounds.md` are part of the same policy, and this file is its entry. A
role skill routes work by its `shapes`; it cannot override this policy. A project may refine
only the E1–E5 map, through its own `docs/agents/decision-policy.md`, under the rules in
`escalation.md`; nothing else can. The policy is guidance, not a board gate: the board
enforces the one invariant that matters — only a human-authored comment resumes an `awaiting`
card. Whether an answer is complete is judged from its content by the worker, not by the
board.

Read exactly the file the decision names — one branch, plus this core:

- a worker needs a choice → this file + `question.md`
- a card has no accountable role → this file + `route.md`
- an accepted card carries a required handoff → this file + `triage.md`
- an E1–E5 or reserved matter → this file + `escalation.md`
- asking or answering a round → `rounds.md`

## The ladder

```text
worker  →  director  →  human
```

A worker does not decide an unauthorized question. It asks one question for the round and
waits for the answer. The director decides what it can and records the decision, then releases
the card; the release concludes the question, and a note alone does not. Only the director may
move a card to `awaiting`, and only for an E1–E5 decision it cannot make. Only a human-authored
comment resumes it.

## The director decides

- Which role/agent handles a card; one accountable role per work shape. The routing detail is
  `route.md`.
- Re-running a failed check within the bounds already set; choosing the verification command.
- Splitting an epic into children that are each a **deliverable** — one that can land on the
  base branch alone and leave the tree coherent; one change's layers are its scope, not
  separate children; a scope expansion is E1.
- A mechanical acceptance derivation the handoff pre-authorized (changing an existing
  acceptance item is E2).
- Creating a downstream card from a required handoff, or a fix card from a question that
  names an out-of-scope defect.

The director does **not** decide ordering (the board's), concurrency, timeouts or other
configuration (the human's), the project directory (a registered map the human maintains),
scope, the acceptance baseline, design direction, security posture or architecture direction —
unless a project's `docs/agents/decision-policy.md` explicitly delegates that entry (see
`escalation.md`). The director records its answer and releases the card; it never records a
human decision as its own. The exact commands are the `meerkat` board skill's, never a second
procedure.

## The reviewer

The reviewer never asks a blocking question and never enters `awaiting`. It answers the review
card's acceptance and ends in exactly one `VERDICT: APPROVE` or `VERDICT: REJECT`; if the
evidence is insufficient or the requirements are ambiguous, it REJECTs and records the
findings. A rejection that only needs the same card fixed is applied without a director
decision; one that needs a scope, acceptance, design, security or architecture change is a
question and follows the ladder.

## Recording

- Worker question: one question for the round; the worker waits for the answer.
- Director decision: record the decision and release the card.
- Human escalation: move the card to `awaiting` with the E-code and the question.
- Human answer: a human-authored comment of any kind; the body is the human's own words. The
  director never records a human decision as its own.

The exact commands and flags are the `meerkat` board skill's contract.
