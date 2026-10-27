# Linus — self-check before delivery

Run this after the branch work and before delivery. First re-export the brief so the check
runs against the current card, then use the section for the branch you ran; the shared
checks apply to both.

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
   is closed: every item answered or explicitly deferred, no frontier open (answers in
   `plan.md` or an ADR).
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
   scaffold instantiates the recorded stack and the planned directory tree (the container
   build file builds when the runtime form is a container).
9. The project's gate path exists and fires on a scratch change, and it is idempotent. No
   secret, no host-absolute path, no generated file is committed.
10. The E5 architecture decision is recorded before implementation starts, and the
    agent-instruction baseline names the build/test/run commands and the design principles.
11. The root `GLOSSARY.md` carries the `## Product language` pointer (or says product terms
    are not recorded) and does not copy product terms; ADRs live at
    `docs/adr/NNNN-<slug>.md`.
12. The design stance is evidenced: the simplest reliable option was chosen, every
    abstraction and dependency names its forcing function, no layer exists only for
    symmetry, modules have one reason to change and dependencies point one way.
13. The architecture style is recorded and justified — DDD with its bounded contexts and
    aggregates, or a named simpler style with DDD's rejection and cost — and the boundaries
    and tree instantiate it.
14. When the system exposes an external contract over HTTP, the envelope, error codes,
    validation and pagination are recorded, one helper implements the envelope, and the
    canonical contract matches the handlers. Otherwise the `n/a — <reason>` is recorded.
15. The configuration surface is recorded: `.env.example` names every key the application
    reads, the loader fails loudly on a missing required key, and the reload policy lists
    reloadable and restart-required keys. Otherwise the `n/a` is recorded.
16. The directory tree is planned and scaffolded exactly, and the agent-instruction baseline
    (`CLAUDE.md` or `AGENTS.md`) exists as the file every role reads, carrying the entry
    points and the non-obvious top-level directories, plus a pointer to the full tree in
    `docs/architecture.md` — not a copy of it.
17. The agent-instruction baseline carries the design principles as binding requirements
    every agent follows — simple, reliable, efficient, elegant, not over-engineered, high
    cohesion and low coupling, with the conflict ordering — rather than leaving them in the
    architecture document only.
18. The logging contract holds: one logger module, key flows emit an `info` line, every
    caught exception emits one `error` line with its code and correlation id, and no secret
    or personal data is logged. Otherwise the recorded `n/a` is present.
19. The release and deploy paths are recorded separately, each with its `n/a` when absent:
    the release publishes the artifact CI passed and treats a published version as
    immutable (fix forward), and every deploy has a healthcheck, a post-deploy check and a
    recorded rollback, with the data-recovery step when the release changes stored data.

## Implementation branch

6. A bug has a failing test that reproduces the root cause, committed with the fix.
7. No published contract, schema or migration changed without the human's decision; no
   destructive operation was run; the change is scoped.
8. A production bug fix carries a regression test and Turing's required regression evidence.
9. Delivery stopped at `in_review`; integration and cleanup stayed with the project session.
10. The gates were re-run against the delivered tree; the change uses the recorded stack (a
    new dependency or engine is a recorded decision).
11. The change applies the six design principles from Step 2 of the branch workflow: it is
    the smallest correct change, each module or function has one reason to change,
    dependencies point one way, and every new abstraction or dependency names its forcing
    function. A departure is a recorded decision.

## Delivery

Confirm the report names the workflow run, the evidence, the acceptance mapping and the
leftovers. Only then deliver at `in_review`. Do not accept your own work.
