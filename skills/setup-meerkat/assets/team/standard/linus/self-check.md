# Linus — self-check before delivery

Run this after the branch work and before delivery. First re-export the brief through the
`meerkat` board skill so the check runs against the current card, then run the section for
the branch you took; the Shared checks and the Mandatory gates apply to every branch. The
evidence table lives in `plan.md` and grows while you work — this check audits it, it does not
write it from memory.

Never hand-edit `card.md`; re-export it. Board operations are the `meerkat` board skill's
contract. This is the role's pre-delivery audit, not the delivery itself.
It is not the `## Handoff` block: that block is a producer card's cross-card transfer
(Jobs design, Linus architecture only).

## Shared

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` and this card's
   `.meerkat/<id>/plan.md`.
2. Confirm `plan.md`'s requirement/acceptance → code/test/evidence table covers every
   description requirement, comment decision, acceptance item and touched error/boundary/
   regression scenario, and that each row was written when you observed it — a row added at
   delivery is a recollection, not evidence. A missing row is an omission: do the work, then
   add the row.
3. Every row ends in one disposition, and the report's acceptance status carries it:
   - **met** — the proof is falsifiable. For code, a `command exit 0` whose command fails
     when the item is broken; for an artifact, a `path` plus the check that resolves it. A
     `path`, a `commit` or a `coverage` number on its own is corroboration, not proof.
   - **not_applicable** — only with the reason that makes it inapplicable (`n/a — <reason>`).
     A bare `n/a` is an omission.
   - **partial** / **not_met** — a blocker: close it and re-run, or ask with an agent
     `question` and keep the card `in_progress`. The delivery gate refuses either status on
     a baseline item, so neither is a way to deliver.
4. A **leftover** is work the card surfaced but does not own: it lies outside the frozen
   acceptance and names the item, its owner and the follow-up card (or why none is needed).
   Never a leftover: a red gate, a security finding, a missing acceptance item, a missing or
   invalid handoff path, or a published contract, schema or migration change. Do not soften
   a missing acceptance item into a leftover.
5. Re-run the gates you claim; a red gate is a blocker, not a leftover. The decision round
   is closed: every item answered or explicitly deferred with what unblocks it, no frontier
   open (answers in `plan.md` or an ADR).
6. If the card has a `## Handoff` block or `meta.design_stage`, every named path exists and
   was used, and the handoff's acceptance source is in the frozen acceptance. A missing or
   invalid handoff is a `question`, not a silent fallback.

## Mandatory gates (a card that changes code)

Run these before delivery. They are the worker's own bars; the reviewer runs the project's
declared gate (or the same bars when none is declared) on the delivered commit.

| Gate | Threshold |
|---|---|
| Test suites | unit, integration, API and browser-based (where applicable): 100% pass; any failure is a failure |
| Coverage | line, branch and function all >80% (or the project's stricter floor) |
| Mocks | only at http / websocket / db / redis and comparable external boundaries; never an internal module or function |
| Security scan | the project's documented scan — dependency audit (default `osv-scanner`), secret scan, SAST — each arm run with the command the standard records, or its recorded `n/a — <reason>`; no unaddressed high/critical |

A red gate is a blocker. A design-only or documentation card records `n/a` and does not
run them.

## Architecture branch

6. Every quality attribute and constraint maps to the architecture document or an ADR; every
   ADR has alternatives, consequences and a status.
7. The `## Tech stack` table exists in `docs/tech-spec.md`, its four core layers are
   complete, versions are pinned and the container base image matches the backend runtime.
   No row says `TBD`; the frontend, persistence and container rows name the choices the
   table requires; a choice outside the recommended baseline carries the human's E5
   approval.
8. The skeleton builds, the smoke test passes, the documented local run works, and the
   scaffold instantiates the recorded stack and the planned directory tree (the container
   build file builds when the runtime form is a container).
9. The project's gate path exists and fires on a scratch change, and it is idempotent. No
   secret, no host-absolute path, no generated file is committed.
10. The E5 architecture decision is recorded before implementation starts, and the
    agent-instruction baseline names the build/test/run commands, the design principles, the
    working agreement, the change and integration policy and the operational invariants.
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
    `docs/architecture.md` — not a copy of it. Every command and pointer in it resolves; no
    guessed example, no host-absolute path.
17. The standard at `docs/tech-spec.md` is complete: every section is filled, the stack
    table lives there and nowhere else, every rule names its enforcement point (a test, a
    lint rule, a gate or `review`), and the agent-instruction baseline points at it rather
    than restating it.
18. The agent-instruction baseline carries the design principles as binding requirements
    every agent follows — simple, reliable, efficient, elegant, not over-engineered, high
    cohesion and low coupling, with the conflict ordering — rather than leaving them in the
    architecture document only.
19. The logging contract holds: one logger module, key flows emit an `info` line, every
    caught exception emits one `error` line with its code and correlation id, and no secret
    or personal data is logged. Otherwise the recorded `n/a` is present.
20. The release and deploy paths are recorded separately, each with its `n/a` when absent:
    the release publishes the artifact CI passed and treats a published version as
    immutable (fix forward), and every deploy has a healthcheck, a post-deploy check and a
    recorded rollback, with the data-recovery step when the release changes stored data.
21. The baseline states its operating rules: decompose and test-first where the stack has a
    test; verification through the project's gate; confirmation before an irreversible
    integration; the ref a card starts from and the ref acceptance lands into; the protected
    line, the isolation for parallel work and the cleanup order; the commit rule that makes
    a delivery verifiable; one writer per surface, the identity and configuration roots, and
    the generated artifacts that are never hand-edited.
22. Every path and command the baseline names resolves against the tree and the manifest; on
    an existing project the file was improved in place, not regenerated.
23. Constants and enumerations have one home each: a deployment-dependent value is a
    configuration key, never a literal; a literal a second module needs is a named constant;
    each enum is one definition with a recorded wire form and unknown-value policy, and the
    database constraint, the contract and the UI label map agree. Otherwise the recorded
    `n/a` is present.
24. The standard's security toolchain is complete: every arm names a free tool, its version
    floor, one local command, one CI command, the report it writes and who may waive a
    finding; an arm the project does not run records `n/a — <reason>`. A `.vue` or Svelte
    single-file component is named as uncovered rather than assumed scanned.
25. The document set is complete and single-sourced: `README.md`, `GLOSSARY.md`,
    `CONTRIBUTING.md` and `CHANGELOG.md` exist; when the card records a community
    open-source project, `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
    `.github/CODEOWNERS` and the issue/PR templates exist too, and otherwise the standard
    records `n/a — not a community open-source project`. The changelog has one empty
    unreleased section between releases; the baseline points at `CONTRIBUTING.md` instead of
    restating the change policy; and no two documents own the same rule. The root glossary
    is item 11's finding, not repeated here.

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

## Refactor branch

6. The behaviour-pinning tests fail when the behaviour changes and are green before and after.
7. The observable behaviour, the published contract, the schema and the migrations are
   unchanged.
8. Each step was green on its own; no feature or bug fix rode along.
9. The candidate list, the rejected candidates and their reasons are in the plan; the chosen
   interface names what sits behind its seam and what it makes testable.

## Delivery

Confirm the report gives every baseline item its status and falsifiable evidence, and gives
each leftover its owner and follow-up. The report is `plan.md`'s table projected onto the
card's acceptance — not a narrative rewritten at delivery. A card with an open omission, a
red gate or an unanswered question is not delivered: close it and re-run, or ask and keep
the card `in_progress`. The delivered tree is committed on the card's branch and the report
carries the `commit` anchor; nothing was merged, rebased or pushed from this card. Only then
deliver at `in_review`. Do not accept your own work.
