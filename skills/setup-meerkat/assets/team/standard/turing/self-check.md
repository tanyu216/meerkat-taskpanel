# Turing — self-check before delivery

This pre-delivery audit runs against the current `.meerkat/<id>/card.md` and `plan.md`; it is
not the delivery and not the `## Handoff` block.
Refresh the brief through the `meerkat` board skill before you start.

## Every branch

1. Read the card, the frozen acceptance, this card's `plan.md` and the branch artifact.
2. Audit the evidence table: every acceptance item and requirement has a row, written when
   observed, naming the test, command, exit code and coverage. A row added at delivery is a
   recollection, not evidence.
3. Each row ends in one disposition: **met** (a falsifiable `command exit 0` that fails when
   the test stops covering the item), **not_applicable** (`n/a — <reason>`; a bare `n/a` is an
   omission), or **partial/not_met** (a blocker: close it, or ask and stop).
4. A leftover lies outside the frozen acceptance and names the item, its owner and the
   follow-up card, or why none is needed. A failure is never a leftover — nor is a red gate, a
   security finding, a missing acceptance item, a handoff gap, or a contract/schema/migration
   change.
5. The decision round is closed; terms are canonical; no glossary or ADR was edited. A card
   with a handoff used every named path and report; a regression card uses no design artifacts.

## Gates

| Gate | Threshold |
|---|---|
| Suites | unit, integration, API and browser: 100% pass |
| Coverage | line, branch and function >80% (or the project's stricter floor) |
| Mocks | only at http/websocket/db/redis and comparable external boundaries; never internal; none in integration |
| Security scan | dependency audit (default `osv-scanner`), secret scan and SAST run, or `n/a — <reason>`; no unaddressed high/critical |

Branch deltas:
- **test-design**: `test-plan.md` has the matrix, entry/exit criteria and frontier answers;
  every acceptance item has a test; the test-case review is recorded.
- **regression**: the original fails before and passes after; the blast radius is covered; a
  production bug records its observation window and rollback trigger; the fix card is still in
  the verified round.
- **performance**: metric, load, baseline and threshold are stated; multiple runs report
  variance; bottleneck, noise and soak/leak are checked.

## Delivery

The report names the branch, each acceptance status with falsifiable evidence, the coverage
and every leftover's owner. The tree is committed on the card's branch and the report carries
the `commit` anchor. The review card runs the project's declared gate; this file is only the
pre-delivery audit. Nothing was merged, rebased or pushed. Deliver at `in_review`; do not
issue a verdict.
