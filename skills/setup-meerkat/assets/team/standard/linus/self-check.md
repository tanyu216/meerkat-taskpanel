# Linus — self-check before delivery

Run this after the branch work and before `issue deliver`. First re-export the brief so the
check runs against the current card, then use the section for the branch you ran; the
shared checks apply to both.

```bash
taskctl export md <id> --out .meerkat/<id>/card.md
```

Never hand-edit `card.md`; re-export it. This is the role's pre-delivery audit. It is not
the `## Handoff` block: that block is a producer card's cross-card transfer (Jobs design,
Linus architecture only).

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` and this card's
   `.meerkat/<id>/plan.md`.
2. Build a requirement/acceptance → code/test/evidence table in `plan.md` for every
   description requirement, comment decision, acceptance item and touched error/boundary/
   regression scenario. Evidence is a command with its exit code, a path, a commit or a
   coverage number.
3. Any row with no proof is an **omission**: add the code/test, ask with an agent
   `question`, or record a deliberate leftover.
4. Re-run the gates you claim; a red gate is a blocker, not a leftover. The decision round
   is closed (answers in `plan.md` or an ADR).
5. If the card has a `## Handoff` block or `meta.design_stage`, every named path exists and
   was used, and the handoff's acceptance source is in the frozen acceptance. A missing or
   invalid handoff is a `question`, not a silent fallback.

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

6. Every quality attribute and constraint maps to the architecture document or an ADR; every
   ADR has alternatives, consequences and a status.
7. The `## Tech stack` table exists, its four core layers are complete, versions are pinned
   and the container base image matches the backend runtime. No row says `TBD`; the
   frontend, persistence and container rows name the choices the table requires; a choice
   outside the recommended baseline carries the human's E5 approval.
8. The skeleton builds, the smoke test passes, the documented local run works, and the
   scaffold instantiates the recorded stack (the Dockerfile builds when the runtime form is
   a container).
9. `.githooks/pre-commit`, `pre-push` and `pre-tag` exist, are wired through
   `core.hooksPath`, fire on a scratch commit/push/tag, and are idempotent. No secret, no
   host-absolute path, no generated file committed.
10. The E5 architecture decision is recorded before implementation starts. The agent
    instructions name the build/test/run commands and the worktree rule; `.worktrees/` is
    gitignored and the integration branch is recorded.
11. The root `GLOSSARY.md` carries the `## Product language` pointer (or says product terms
    are not recorded) and does not copy product terms; ADRs live at
    `docs/adr/NNNN-<slug>.md`.

## Implementation branch

6. A bug has a failing test that reproduces the root cause, committed with the fix.
7. No published contract, schema or migration changed without the human's decision; no
   destructive operation was run; the change is scoped.
8. A production bug fix carries a regression test and Turing's required regression evidence.
9. Work happened in a linked worktree with the primary checkout on `dev`; merge and cleanup
   ran only after reviewer approval or operator confirmation, `worktree remove` before
   `branch -d`, and never `-D`.
10. The gates were re-run on the integration result; the change uses the recorded stack (a
    new dependency or engine is a recorded decision).

## Delivery

Confirm the report names the branch, the commands and results, the evidence anchors, the
acceptance mapping and the leftovers. Only then deliver at `in_review`. Do not accept your
own work.
