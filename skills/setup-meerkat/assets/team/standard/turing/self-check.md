# Turing — self-check before delivery

Run this after the branch work and before `issue deliver`. Use the section for the branch
you ran; the shared checks apply to all.

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` snapshot and
   this card's `.meerkat/<id>/plan.md`.
2. Build an acceptance → test/evidence table in `plan.md`: every acceptance item, every
   requirement in the description and comments, and every boundary or failure path.
3. Each row names the test, the command, the exit code and the coverage.
4. Any row with no proof is an **omission**: add the test, ask with an agent `question`, or
   record a deliberate leftover with the reason.
5. A failure is a failure, not a leftover. Do not issue a verdict; the reviewer is
   independent.
6. The decision round is closed and its answers are recorded in the plan or `test-plan.md`.
7. Test names and fixtures use the canonical terms; any term conflict is recorded, and no
   glossary or ADR was edited.
8. If the card has a `## Handoff` block or `meta.design_stage`, every named path/report
   exists and was used; the acceptance matrix cites the handoff's acceptance source. A
   regression card uses no design artifacts.

## Mandatory gates

The reviewer re-runs them independently; a red gate is not a delivery.

| Gate | Threshold |
|---|---|
| Test suites | unit, integration, API and browser-based (where applicable): 100% pass; any failure is a failure |
| Coverage | line, branch and function all >80% (or the project's stricter floor) |
| Mocks | only at http / websocket / db / redis and comparable external boundaries; never an internal module or function |
| Security scan | the project's documented scan (dependency audit, secret scan, SAST); no unaddressed high/critical |

## Test-design branch

9. `.meerkat/<id>/test-plan.md` carries the traceability matrix and the entry/exit criteria.
10. Every acceptance item has at least one test; API and browser-based flows are covered
    where the change exposes them; no acceptance item is covered only by a mock or a
    constructor.
11. The test-case review is recorded with findings and dispositions.
12. The hard rules hold: 100% pass, line/branch/function coverage >80%, mocks only at the
    http/websocket/db/redis external boundaries and never an internal module or function,
    no mocks in integration.
13. The security review records findings with severity; a serious finding blocks.
14. `.meerkat/<id>/test-plan.md` records the decision round's answers, and the scenarios use
    the canonical terms.
15. The commands and results are reproducible and offline.

## Regression branch

9. The original case failed before the fix and passes after it; both outputs are recorded.
10. The blast radius is covered: targeted, surrounding and contract/schema.
11. For a production bug: the observation window and rollback trigger are recorded, and the
    mitigation does not hide a new error signature.
12. The regression test is committed and no unrelated change slipped into the fix.
13. The fix card is still in the delivery round that was verified.

## Performance branch

9. The metric, load, baseline and threshold are stated.
10. The environment and workload are recorded and reproducible.
11. Multiple runs are reported with variance, not a single sample.
12. The bottleneck analysis separates a regression from noise, and soak/leak behaviour is
    checked.
13. The conclusion compares against the threshold and states whether it blocks.

## Delivery

Confirm the report names the branch, the commands and results, the coverage, the evidence
anchors and the leftovers. Deliver at `in_review`. Do not issue a verdict.
