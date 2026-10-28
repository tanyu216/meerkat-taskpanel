# Turing — self-check before delivery

Run this after the branch work and before delivery. First re-export the brief through the
`meerkat` board skill so the check runs against the current card, then use the section for
the branch you ran; the Shared checks and the Mandatory gates apply to every branch. The
evidence table lives in `plan.md` and grows while you work — this check audits it, it does not
write it from memory.

Never hand-edit `card.md`; re-export it. Board operations are the `meerkat` board skill's
contract. This is the role's pre-delivery audit, not the delivery itself.
It is not the `## Handoff` block: that block is a producer card's cross-card transfer
(Jobs design, Linus architecture only).

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` and this card's
   `.meerkat/<id>/plan.md`.
2. Confirm `plan.md`'s acceptance → test/evidence table covers every acceptance item,
   description requirement and boundary/failure path, and that each row was written when
   you observed it — a row added at delivery is a recollection, not evidence. Each row names
   the test, command, exit code and coverage, and ends in one disposition carried by the
   report's acceptance status:
   - **met** — the proof is falsifiable: a `command exit 0` that fails when the test stops
     covering the item. A `path`, a `commit` or a `coverage` number on its own is
     corroboration, not proof.
   - **not_applicable** — only with the reason that makes it inapplicable (`n/a — <reason>`).
     A bare `n/a` is an omission.
   - **partial** / **not_met** — a blocker: close it and re-run, or ask with an agent
     `question` and keep the card `in_progress`. The delivery gate refuses either status on
     a baseline item.
3. A **leftover** is work the card surfaced but does not own: it lies outside the frozen
   acceptance and names the item, its owner and the follow-up card (or why none is needed).
   Never a leftover: a red gate, a security finding, a missing acceptance item, a missing or
   invalid handoff path, or a published contract, schema or migration change. A failure is a
   failure, not a leftover. Do not issue a verdict; the reviewer is independent.
4. The decision round is closed: every item answered or explicitly deferred with what
   unblocks it, no frontier open (answers in the plan or `test-plan.md`); test names and
   fixtures use the canonical terms, and no glossary or ADR was edited.
5. If the card has a `## Handoff` block or `meta.design_stage`, every named path/report
   exists and was used; the acceptance matrix cites the handoff's acceptance source. A
   regression card uses no design artifacts.

## Mandatory gates

The reviewer runs the project's declared gate on the delivered commit; a red gate is not a
delivery.

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

Confirm the report names the branch, every baseline item's status and falsifiable evidence,
the coverage, and each leftover's owner and follow-up. The report is `plan.md`'s table
projected onto the card's acceptance — not a narrative rewritten at delivery. A card with an
open omission, a red gate or an unanswered question is not delivered: close it and re-run, or
ask and keep the card `in_progress`. The delivered tree is committed on the card's branch and
the report carries the `commit` anchor; nothing was merged, rebased or pushed from this card.
Deliver at `in_review`. Do not issue a verdict.
