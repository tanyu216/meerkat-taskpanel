# Decision policy — the shared core

This is the director skill's decision authority. It is the shared core: the four decision
files named below and `rounds.md` are part of the same policy, and this file is its entry. A
role skill routes work by its `shapes`; this policy outranks it. A project may refine
only the E1–E5 map, through its own `docs/agents/decision-policy.md`, under the rules in
`escalation.md`; this file with its four decision files is the complete refinement surface.
The policy is guidance; the board enforces the one invariant that matters — only a
human-authored comment resumes an `awaiting` card. The worker judges whether an answer is
complete from its content.

Read exactly the file the decision names — one branch, plus this core:

- a human submitted a description → this file + `intake.md`
- a worker needs a choice → this file + `question.md`
- a card has no accountable role → this file + `route.md`
- an accepted card carries a required handoff → this file + `triage.md`
- an E1–E5 or reserved matter → this file + `escalation.md`
- asking or answering a round → `rounds.md`

## The ladder

```text
worker  →  director  →  human
```

A worker answers the questions the card authorizes; a question beyond them goes to the ladder.
It asks one question for the round and waits for the answer. The director decides what it can
and records the decision, then releases the card; the release concludes the question, and a note
records the answer. Only the
director may move a card to `awaiting`, and only for an E1–E5 decision reserved to the human.
Only a human-authored comment resumes it — the release leaves the claim cycle, so the next claim
is a **new worker** that re-reads the comments (ADR 0017).

## The director decides

- Which role/agent handles a card; one accountable role per work shape. The routing detail is
  `route.md`.
- Re-running a failed check within the bounds already set; choosing the verification command.
- Splitting an epic into children that are each a **deliverable** — one that can land on the
  base branch alone and leave the tree coherent; one change's layers are its scope, not
  separate children; a scope expansion is E1.
- A mechanical acceptance derivation the handoff pre-authorized (changing an existing
  acceptance item is E2).
- Splitting a human's submitted description into deliverable cards, and recording whether
  cards were filed or the description named no work. The card's reporter is the submitter,
  and one accountable role owns each card. The routing detail is `intake.md`.
- Creating a downstream card from a required handoff. An out-of-scope defect's disposition
  defaults to a `backlog` follow-up the finder files: bug label, `meta.fixes` = the source
  identifier, acceptance seeded from the defect, and the card continues. The director decides
  the fix on the current card (reported, acceptance unchanged); a defect that would change
  scope, acceptance, design, security or architecture follows the decision map — the human
  decides it unless the project delegates that entry.
- Closing a required handoff: the delivery's open items — the handoff's proposed work and
  open questions, the report's `leftovers`, the review's observations — each get one
  disposition: a card, a recorded decline with its reason, or an escalation. The round marker
  follows the completed ledger.

Ordering belongs to the board; concurrency, timeouts and other configuration belong to the
human; the project directory is a registered map the human maintains; scope, the acceptance
baseline, design direction, security posture and architecture direction belong to the human —
unless a project's `docs/agents/decision-policy.md` explicitly delegates that entry (see
`escalation.md`). The out-of-scope-defect disposition above keeps the acceptance baseline
unchanged (E2) and keeps the card within that defect (E1). The director records its answer and
releases the card; a human decision is recorded in the human's name. The exact commands are the
`meerkat` board skill's single procedure.

## The reviewer

The reviewer answers within the review card and ends in exactly one `VERDICT: APPROVE` or
`VERDICT: REJECT`; a question the evidence leaves open becomes a REJECT with findings, and the
card returns to the ladder through its producer. A rejection that only needs the same card fixed is applied without a director
decision; one that needs a scope, acceptance, design, security or architecture change is a
question and follows the ladder.

## Recording

- Worker question: one question for the round; the worker waits for the answer.
- Director decision: record the decision and release the card.
- Human escalation: move the card to `awaiting` with the E-code and the question.
- Human answer: a human-authored comment of any kind; the body is the human's own words, and
  the decision is recorded in the human's name.

The exact commands and flags are the `meerkat` board skill's contract.
