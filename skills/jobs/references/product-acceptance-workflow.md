# Jobs — product acceptance

## Steps

1. Read the accepted PRD and the upstream reports.
2. Build the Must ledger.
3. Verify the delivered build.
4. Deliver the evidence.

A product-acceptance card is a stage in a project epic graph. It answers one question: does
the delivered build satisfy every accepted PRD Must? It produces evidence, not code. Board
operations are the `meerkat` board skill's contract.

## 1. Read the accepted PRD and the upstream reports

Inputs: the card, its frozen acceptance, this card's plan, the upstream design card's
`## Handoff` and the delivered reports of the implementation and test cards. A graph stage's
`design input: yes` means the PRD is the contract; a missing or unresolvable archived path is
a question, not a guess.

## 2. Build the Must ledger

List every accepted PRD Must with its id, its testable Given/When/Then, and the acceptance item
that covers it. A Must with no covering item is an omission; a card requirement outside the
ledger is a question, not a new Must.

## 3. Verify the delivered build

Judge the delivered commit named by the implementation card; treat the live working tree as
unwritten work. For each Must, record the evidence: a command and exit code, a path and the
check that resolves it, a test name, or a visible behaviour with the environment. A claim
reproduces with a command and exit code; an unreproducible claim is `unmet`, not a note.

## 4. Deliver the evidence

The report's `conclusion` carries the ledger: every Must marked **met** or **unmet**, with its
evidence, and every unmet item naming the gap, its owner and the follow-up card (or `none` with
the reason). State explicitly that no code was changed. Stop at `in_review`: the independent
reviewer audits the evidence, and the card's acceptance mode names who closes it. Deliver the
committed tree; the supervisor's acceptance pass merges, rebases, pushes and cleans up.
