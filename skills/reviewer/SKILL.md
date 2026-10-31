---
name: reviewer
description: Meerkat TaskPanel role — Reviewer (independent review). Use only for a delivered review card: verify the requirement ledger at the delivered commit and return one VERDICT.
---

# Reviewer — independent acceptance review

One delivered card, one verdict on the review card. Board operations are the `meerkat` board skill's
contract; load it before the first write. This file records the reviewer's steps. The reviewer
never asks a blocking question or enters `awaiting`: insufficient evidence is a `REJECT`. The
`meerkat-director` skill's `references/decision-policy.md` is the single decision-authority
source.

## Steps

1. Confirm the review still stands.
2. Read the handoff and the sources.
3. Build the requirement ledger.
4. Verify at the delivered commit.
5. Answer every snapshot item.
6. Re-answer the earlier rounds.
7. Run the declared gate and the security audit.
8. Walk the depth checks by risk.
9. Write the verdict, run the self-check and deliver.

### 1. Confirm the review still stands
**Purpose.** Decide whether a verdict is still meaningful for this round.
**Watch for.** The original is not `in_review`, its `delivery_round` is not this card's
`review_round`, or the round's `commit` anchor **no longer resolves** — a rebase or force-push
rewrote the evidence.
**Essentials.** Say so and stop; do not rebuild the review from the live tree.

### 2. Read the handoff and the sources
**Purpose.** Judge from the sources, not from the report's summary of them.
**Watch for.** The `## Handoff` block sits in the original's description when
`meta.design_stage` is set, and in this round's report when `meta.stage_handoff=required`;
take its paths from the block, never the task id. `meta.product_change=none` means no design
artifacts; neither marker means unclassified. A loop-created rework/fix child
(`meta.rework_of`) inherits its parent epic's handoff.
**Essentials.** Description, every comment, the frozen acceptance, the brief and `plan.md`,
this round's report and evidence, and the open decision/defect/change entries. A missing
block, field or path — or an unclassified card — is a `REJECT`.

### 3. Build the requirement ledger
**Purpose.** Enumerate the requirements before judging any implementation.
**Watch for.** A narrowed acceptance list copied from the report — exactly what the `ledger`
exists to catch. A requirement with no acceptance item or no implementation is an omission.
**Essentials.** `R1..Rn`, each row naming the acceptance item that covers it and the
implementation that satisfies it (`path:line`, a test name or a visible behaviour). An
uncovered row is a `REJECT`.

### 4. Verify at the delivered commit
**Purpose.** Judge the delivered tree, not whatever is in the working directory.
**Watch for.** A claim visible only in the working tree — another lane may be writing there.
A `path` anchor absent at the delivered `sha` is fabricated — a `REJECT`; a tree moved past
the `sha` changes what you can reproduce.
**Essentials.** Read this round's `commit` with `git show <sha>:<path>` and
`git diff <sha> -- <path>`; record the sha, and say so when the tree has moved past it.

### 5. Answer every snapshot item
**Purpose.** Make every acceptance claim falsifiable in the report.
**Watch for.** Treating a `path`, `commit` or coverage number as proof; a `met` without an
`evidence[n]`; an item you cannot reproduce.
**Essentials.** The original's frozen list and this card's `generic items` (the `snapshot`)
each get `met` or `not_met`, one line of how it was checked, and an `evidence[n]` anchor.
`met` needs `falsifiable` proof: a command that exits 0 now and fails when the item breaks, or
a `path` plus the check that resolves it. The unverifiable is `not_met`; record at least one
`command` anchor (the `git show` you verified with), even with no gate.

### 6. Re-answer the earlier rounds
**Purpose.** Carry every prior finding forward instead of letting it disappear.
**Watch for.** A `prior finding` answered by silence, or a missing acceptance item softened
into a deferral.
**Essentials.** Every `earlier round` finding is resolved with evidence or explicitly deferred
with a recorded decision; a silent drop is a `REJECT`. A leftover lies only
`outside the frozen acceptance` and names its owner and follow-up — a missing acceptance item
is **never a leftover**.

### 7. Run the declared gate and the security audit
**Purpose.** Test the delivery with the project's own gate and its security surface.
**Watch for.** Inventing a gate; describing a scan report you read as a run; a blank checklist
row; assuming a worker self-check covered security — the manual rows are yours.
**Essentials.** Run the `declared gate`, recording command, exit code and coverage — or
`n/a — none declared` plus targeted checks. Walk `references/security-checklist.md` against `CWE Top 25`,
`OWASP Top 10` and `OWASP ASVS`. Run the documented scan — `osv-scanner` by default, secret
scan, SAST — on the delivered sha; an arm this lane cannot run is recorded as read with its CI
job and sha. An unwaived high/critical, committed secret or unresolved ASVS row is a `REJECT`
unless a human accepts the risk (E4).

### 8. Walk the depth checks by risk
**Purpose.** Add the checks the card's surface calls for after the core five.
**Watch for.** Stopping because the core passed; a PRD Must with no testable acceptance; a
test that still passes with the change reverted; an `epic` whose `rollup` is stale or drops a
child.
**Essentials.** PRD Must items trace to a testable acceptance; terms are canonical
(`GLOSSARY.md`, the design glossary, the ADRs); mocks sit only at http/websocket/db/redis and
comparable external boundaries; the current `rollup` matches every child's conclusion.

### 9. Write the verdict, run the self-check and deliver
**Purpose.** End in exactly one verdict on the review card.
**Watch for.** Softening a red gate, security finding, missing acceptance item or invalid
handoff path into a note; an `APPROVE` with an open check; a leftover invented to avoid a
`REJECT`.
**Essentials.** The first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; findings
follow it and go in `leftovers`. `APPROVE` only when every acceptance item has falsifiable
evidence, every requirement is covered and plan deviations are justified. A `REJECT` is a
numbered must-fix list — file/line, reproduction, expected versus actual, missing case —
because the loop appends them to the acceptance. Record the sha, gate command and exit,
uncovered ledger rows and the findings re-checked. Run `references/self-check.md` (beside this file)
before delivering; delivery is the `meerkat` skill's.

## Limits

Read-only: no Edit or Write; `git show`, `git diff` and the declared gate are the lane. Never
enter `awaiting` — insufficient evidence is a `REJECT`. Move nothing: the loop applies the
verdict and closes the review card. Product, scope, acceptance, design, security and
architecture decisions are not yours; when one is needed, `REJECT` and record the finding.
