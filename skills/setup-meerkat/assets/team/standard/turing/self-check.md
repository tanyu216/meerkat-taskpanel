# Turing — self-check before delivery

Run this after the branch work and before delivery. First re-export the brief so the check
runs against the current card, then use the section for the branch you ran; the shared
checks apply to all.

Never hand-edit `card.md`; re-export it. This is the role's pre-delivery audit. It is not
the `## Handoff` block: that block is a producer card's cross-card transfer (Jobs design,
Linus architecture only).

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` and this card's
   `.meerkat/<id>/plan.md`.
2. Build an acceptance → test/evidence table in `plan.md` for every acceptance item,
   description requirement and boundary/failure path. Each row names the test, command,
   exit code and coverage. A row with no proof is an **omission**: add the test, ask with an
   agent `question`, or record a deliberate leftover.
3. A failure is a failure, not a leftover. Do not issue a verdict; the reviewer is
   independent.
4. The decision round is closed: every item answered or explicitly deferred, no frontier
   open (answers in the plan or `test-plan.md`); test names and fixtures use the canonical
   terms, and no glossary or ADR was edited.
5. If the card has a `## Handoff` block or `meta.design_stage`, every named path/report
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

6. `.meerkat/<id>/test-plan.md` carries the traceability matrix, entry/exit criteria and the
   decision-round answers, with canonical terms.
7. Every acceptance item has at least one test; API and browser flows are covered where the
   change exposes them; none is covered only by a mock or a constructor; the test-case review
   is recorded.
8. The hard rules hold: 100% pass, coverage >80%, mocks only at the http/websocket/db/redis
   external boundaries and never internal, no mocks in integration.
9. The security review records findings with severity; a serious finding blocks. Commands and
   results are reproducible and offline.

## Regression branch

6. The original case failed before the fix and passes after it; both outputs are recorded.
7. The blast radius is covered: targeted, surrounding and contract/schema; for a production
   bug, the observation window and rollback trigger are recorded.
8. The regression test is committed, no unrelated change slipped in, and the fix card is
   still in the verified delivery round.

## Performance branch

6. The metric, load, baseline and threshold are stated; the environment and workload are
   reproducible, and multiple runs are reported with variance.
7. The bottleneck analysis separates a regression from noise, checks soak/leak behaviour, and
   compares against the threshold.

## Delivery

Confirm the report names the branch, commands and results, coverage, evidence anchors and
leftovers. Deliver at `in_review`. Do not issue a verdict.
