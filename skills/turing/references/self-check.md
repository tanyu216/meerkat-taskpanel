# Turing — self-check before delivery

This pre-delivery audit runs against the current `.meerkat/<id>/card.md` and `plan.md` when a
card is present, and against the handed task, plan or requirement otherwise; it is not the
delivery and not the `## Handoff` block. Run this audit in both modes; a card-only item is
`not_applicable — no card`, and the audit itself is mandatory before the report. Call the
`meerkat` board skill to refresh the brief before you start.

## Every branch

1. Read the card, the frozen acceptance, this card's `plan.md` and the branch artifact.
2. Audit the evidence table: every acceptance item and requirement has a row, written when
   observed, naming the test, command, exit code and coverage. A row added at delivery is a
   recollection, not evidence.
3. Each row ends in one disposition: **met** (a falsifiable `command exit 0` that fails when
   the test stops covering the item), **not_applicable** (`n/a — <reason>`; a bare `n/a` is an
   omission), or **partial/not_met** (a blocker: close it, or ask and hold).
4. A leftover lies outside the frozen acceptance and names the item, its owner and the
   follow-up card; a non-defect leftover outside the board's scope names why no card is needed.
   An out-of-scope defect is filed by its finder in `backlog`, bug-labelled and
   `meta.fixes` = this card, and named here. A blocker, not a leftover: a failure, a red gate,
   a security finding, a missing acceptance item, a handoff gap, or a contract/schema/migration
   change.
5. The decision round is closed; terms are canonical; no glossary or ADR was edited. A card
   with a handoff used every named path and report; a regression card uses no design artifacts.

## Gates

| Gate | Threshold |
|---|---|
| Suites | unit, integration, API and browser: 100% pass |
| Coverage | line, branch and function ≥80% (or the project's stricter floor) |
| Mocks | only at http/websocket/db/redis and comparable external boundaries; internal modules stay real; integration runs without mocks |
| Security scan | dependency audit (default `osv-scanner`), secret scan and SAST run, or `n/a — <reason>`; no unaddressed high/critical |

Branch deltas:
- **test-design**: `test-plan.md` has the matrix, entry/exit criteria and frontier answers;
  every acceptance item has a test; the test-case review is recorded.
- **regression**: the original fails before and passes after; the blast radius is covered; a
  production bug records its observation window and rollback trigger; the fix card's delivered
  round is still current.
- **performance**: metric, load, baseline and threshold are stated; multiple runs report
  variance; bottleneck, noise and soak/leak are checked.

## Delivery

The report names the branch, each acceptance status with falsifiable evidence, the coverage
and every leftover's owner. The tree is committed on the card's branch and the report carries
the `commit` anchor. The review card runs the project's declared gate; this file is only the
pre-delivery audit. The project's integration branch was merged into the lane before delivery,
with any conflicts resolved and the checks re-run; nothing was merged, rebased or pushed from
this card — landing is the loop's. Deliver at `in_review`; the reviewer issues the verdict.
