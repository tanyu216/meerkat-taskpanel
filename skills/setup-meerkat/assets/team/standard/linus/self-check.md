# Linus — self-check before delivery

Run this after the branch work and before `issue deliver`. Use the section for the branch
you ran; the shared checks apply to both.

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` snapshot and
   this card's `.meerkat/<id>/plan.md`.
2. Build a requirement/acceptance → code/test/evidence table in `plan.md`: every
   description requirement, every comment decision, every acceptance item, and every
   error, boundary or regression scenario you touched.
3. Evidence is reproducible: a command with its exit code, a path, a commit, or a coverage
   number.
4. Any row with no proof is an **omission**: add the code/test, ask with an agent
   `question`, or record a deliberate leftover with the reason.
5. Re-run the gates you claim. A red gate is a blocker, not a leftover.
6. The decision round is closed: the answers are recorded in `plan.md` or an ADR, and no
   frontier decision is open.
7. If the card has a `## Handoff` block or `meta.design_stage`, every named path exists and
   was used, and the handoff's acceptance source is reflected in the frozen acceptance. A
   missing or invalid handoff is a `question`, not a silent fallback.

## Mandatory gates (a card that changes code)

Run these before delivery; the reviewer re-runs them independently.

| Gate | Threshold |
|---|---|
| Test suites | unit, integration, API and browser-based (where applicable): 100% pass; any failure is a failure |
| Coverage | line, branch and function all >80% (or the project's stricter floor) |
| Mocks | only at http / websocket / db / redis and comparable external boundaries; never an internal module or function |
| Security scan | the project's documented scan (dependency audit, secret scan, SAST); no unaddressed high/critical |

A red gate is a blocker. A design-only or documentation card records `n/a` and does not
run them.

## Architecture branch

8. Every quality attribute and constraint maps to the architecture document or an ADR.
9. Every ADR has alternatives, consequences and a status; the rejected options are named.
10. The skeleton builds, the smoke test passes, and the documented local run works.
11. `.githooks/pre-commit`, `pre-push` and `pre-tag` exist, are wired through
    `core.hooksPath`, fire on a scratch commit/push/tag, and are idempotent.
12. No secret, no host-absolute path, and no generated file committed by accident.
13. The E5 architecture decision is recorded on the card, and implementation has not
    started before it.
14. The agent instructions (`CLAUDE.md` or `AGENTS.md`) were generated with the host's
    `/init` (or written manually) and reviewed; they name the build/test/run commands and
    carry the shared workspace rule — one worktree per card off the integration branch,
    shared by the card's roles, with merge and cleanup only after confirmation.
15. `.worktrees/` is gitignored, and the integration branch (`dev` or the project's) is
    recorded.
16. The root `GLOSSARY.md` carries the `## Product language` pointer to
    `design/glossary.md` (or says product terms are not recorded) and does not copy product
    terms.
17. ADRs live at `docs/adr/NNNN-<slug>.md` with context, decision and why, plus options and
    consequences where useful.
18. The `## Tech stack` table exists and its four core layers are complete; every row is a
    concrete choice or `n/a` with a reason, and no row says `TBD`.
19. Runtime and major framework versions are pinned; the container base image matches the
    backend runtime; framework, build tool, driver/ORM and migration tool are compatible.
20. The frontend row names the framework, language, styling, component layer and build tool;
    a choice outside the recommended baseline carries the human's E5 approval.
21. The persistence row names the engine, driver/ORM and migration tool; the container row
    names the runtime form and Dockerfile path, or why the deliverable is not containerized.
22. The scaffold instantiates the recorded stack, with no unrecorded substitution.
23. When the runtime form is a container, the Dockerfile builds and the container starts;
    record the command and exit code.

## Implementation branch

8. A bug has a failing test that reproduces the root cause, committed with the fix.
9. No published contract, schema or migration changed without the human's decision.
10. No destructive operation was run.
11. The change is scoped: no unrelated refactor, rename or dependency.
12. A production bug fix carries a regression test and the evidence Turing's regression
    branch requires.
13. Work happened in a linked worktree; the primary checkout stayed on `dev`.
14. Merge and cleanup ran only after reviewer approval or operator confirmation;
    `worktree remove` preceded `branch -d`, and `-D` was not used to force it.
15. The gates were re-run on the integration result.
16. The change uses the recorded stack; a new framework, dependency or database engine is a
    decision recorded on the card, not a silent addition.

## Delivery

Confirm the report names the branch, the commands and results, the evidence anchors, the
acceptance mapping and the leftovers. Only then deliver at `in_review`. Do not accept your
own work.
