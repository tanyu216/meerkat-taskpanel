# Linus — self-check before delivery

Run this after the branch work and before delivery. Refresh the card brief through the
`meerkat` board skill, then audit against the current card. The Shared checks and the Mandatory
gates apply to **every branch**; then run the section for the branch you took. The evidence
table lives in `plan.md` and grows while you work — this check audits it, it does not write it
from memory. A no-card run skips the brief and board state: its evidence lives in the artifacts
it produces.

This is the role's **pre-delivery audit**, not the delivery itself. It is not the `## Handoff` block: that block is a producer card's cross-card transfer (Jobs design, Linus
architecture only).

IDs: `S` shared, `A` architecture, `R` reconstruction/audit, `I` implementation, `F` refactor.

## Shared checks

- **S1.** Re-read the card, its brief, the frozen `acceptance` and this card's `plan.md`.
- **S2.** The mapping covers every description requirement, comment decision, acceptance item
  and touched error/boundary/regression scenario, and each row was written when observed. A row
  added at delivery is a recollection, not evidence.
- **S3.** Every row ends in one disposition, and the report carries it: **met** — a command
  `exit 0` that fails when the item is broken, or a path plus the check that resolves it; a
  path, a commit or a coverage number alone is corroboration, not proof. **not_applicable** —
  with the reason that makes it inapplicable. **partial** / **not_met** — a blocker: close it
  and re-run, or ask through the board; the delivery gate refuses either on a baseline item.
  Reconstruction rows are prefixed `reconstructed — <evidence>`.
- **S4.** A **leftover** is work the card surfaced but does not own: outside the frozen
  acceptance, with the item, its owner and the follow-up card (or why none is needed). Never a leftover: a red gate, a security finding, a missing acceptance item, a missing or invalid
  handoff path, or a published contract, schema or migration change.
- **S5.** Re-run the gates you claim; a red gate is a blocker, not a leftover. The decision
  round is closed: every item answered or explicitly deferred, no frontier open.
- **S6.** If the card has a `## Handoff` block or `meta.design_stage`, every named path exists
  and was used, and the handoff's acceptance source is in the frozen acceptance.

## Mandatory gates

A card that changes code runs these before delivery; a design-only or documentation card
records `n/a` and does not run them.

| Gate | Threshold |
|---|---|
| Test suites | unit, integration, **API** and **browser**-based (where applicable): **100%** pass; any failure is a failure |
| Coverage | line, branch and function all **≥80%** (or the project's stricter floor) |
| Mocks | only at http / websocket / db / redis and comparable external boundaries; never an internal module or function |
| Security scan | the project's documented scan — dependency audit (default `osv-scanner`), secret scan, SAST — each arm with the command the standard records or its recorded `n/a — <reason>`; no unaddressed high/critical |

## Architecture branch

- **A1.** Every quality attribute and constraint maps to the architecture document or an ADR;
  every ADR has alternatives, consequences and a status.
- **A2.** The `## Tech stack` table in `docs/tech-spec.md` has its four core layers, pinned
  versions, and a container base image that matches the backend runtime. No row says `TBD`; a
  choice outside the recommended baseline carries the human's E5.
- **A3.** The skeleton builds, the smoke test passes, the documented local run works, and the
  container build file builds when the runtime form is a container.
- **A4.** The project's gate path exists and fires on a scratch change, and it is idempotent. No
  secret, no host-absolute path, no generated file is committed.
- **A5.** The E5 architecture decision is recorded before implementation starts.
- **A6.** The root `GLOSSARY.md` carries the `## Product language` pointer (or says product
  terms are not recorded) and does not copy product terms; ADRs live at `docs/adr/NNNN-<slug>.md`.
- **A7.** The **design stance** is evidenced: the simplest reliable option was chosen, every
  abstraction and dependency names its forcing function, no layer exists only for symmetry, and
  each module has one reason to change with dependencies pointing one way.
- **A8.** The **architecture style** is recorded and justified — DDD with its bounded contexts
  and aggregates, or a named simpler style with DDD's rejection and cost — and the boundaries
  and tree instantiate it.
- **A9.** When the system exposes an **external contract** over HTTP, the envelope, error
  codes, validation and pagination are recorded, one helper implements the envelope, and the
  canonical contract matches the handlers; otherwise the `n/a — <reason>` is recorded.
- **A10.** The **configuration surface** is recorded: `.env.example` names every key the
  application reads, the loader fails loudly on a missing required key, and the reload policy
  lists reloadable and restart-required keys; otherwise the `n/a` is recorded.
- **A11.** The **directory tree** is planned and scaffolded exactly, and the
  **agent-instruction baseline** (`CLAUDE.md` or `AGENTS.md`) exists as the file every role
  reads, carrying the entry points and non-obvious top-level directories plus a pointer to the
  full tree — not a copy. Every command and pointer **resolves**.
- **A12.** `docs/tech-spec.md` is complete: every section filled, the stack table there and
  nowhere else, every rule naming its **enforcement point**.
- **A13.** The **design principles** bind **every agent** — simple, reliable, efficient,
  elegant, not over-engineered, high cohesion and low coupling, with the conflict ordering.
- **A14.** The **logging** contract holds: one logger module, key flows emit an `info` line,
  every caught exception emits one `error` line with its code and correlation id, and no secret
  or personal data is logged; otherwise the recorded `n/a`.
- **A15.** The release and deploy paths are recorded separately, each with its `n/a` when
  absent; a published version is immutable (fix forward), and every deploy has a healthcheck, a
  post-deploy check and a recorded rollback, with the data-recovery step when the release
  changes stored data.
- **A16.** The baseline states the **working agreement**, the **change and integration policy**
  and the **operational invariants**.
- **A17.** The baseline names where a card **starts from** and **lands into**, the protected
  line, the isolation for parallel work and the **commit rule** that makes a delivery
  verifiable.
- **A18.** **Constants and enumerations** have one home each: a deployment-dependent value is a
  configuration key, not a literal; each enum has one definition with a wire form and an
  unknown-value policy, and the database constraint, the contract and the label map agree;
  otherwise the recorded `n/a`.
- **A19.** The **security toolchain** is complete: every arm names a free tool, its version
  floor, one local command, one CI command, the report it writes and who may waive a finding;
  a `.vue` or Svelte component is named as uncovered, not assumed scanned.
- **A20.** The document set is complete and single-sourced: `README.md`, `GLOSSARY.md`,
  `CONTRIBUTING.md` and `CHANGELOG.md` exist; the community group exists or the standard
  records `n/a — not a community open-source project`; the changelog has one empty unreleased
  section between releases; the baseline points at `CONTRIBUTING.md` instead of restating the
  change policy; and no two documents own the same rule.

## Reconstruction and audit

- **R1.** Every derived fact carries its disposition (`inherited — <path>`,
  `reconstructed — <evidence>`, `not recorded — review question`, `n/a — <reason>`), and a
  reconstruction names the E5 it awaits.
- **R2.** Step 4 was observed, not re-scaffolded: each recorded row maps to an artifact that
  resolves, or to `missing — <reason>` with its follow-up.
- **R3.** Gate honesty: every gate names the real entry point and a failure probe; a
  placeholder or liveness-only service is `not a gate — <reason>`; an unexecuted gate is
  `not run — <reason>`, never by a claimed pass.
- **R4.** A release that changes stored data records its backup, recovery, startup-apply
  behaviour and the older-store upgrade path; a squashed baseline records its pre-baseline
  disposition.
- **R5.** Every exposure-widening default is recorded with its blast radius; an audit records it
  rather than changing it.
- **R6.** Verifiability: the coverage floor names every runtime subsystem or its `n/a`; every
  parity check enumerates its enforcement sites; a prose-only boundary is review-only.

On an audit, items A3, A4 and A5 are satisfied by `observed — <file:line>` or
`not run — <reason>`, never by a claimed pass.

## Implementation branch

- **I1.** A bug has a failing test that reproduces the root cause, committed with the fix.
- **I2.** No published contract, schema or migration changed without the human's decision; no
  destructive operation was run; the change is scoped.
- **I3.** A production bug fix carries a committed regression test; Turing's regression
  verification is a follow-up card, not delivery evidence.
- **I4.** Delivery stopped at `in_review`; integration and cleanup stayed with the project
  session.
- **I5.** The gates were re-run against the delivered tree; the change uses the recorded stack
  (a new dependency or engine is a recorded decision).
- **I6.** The change applies the **six design principles**: it is the smallest correct change,
  each module or function has **one reason to change**, dependencies point one way, and every
  new abstraction or dependency names its forcing function.

## Refactor branch

- **F1.** The behaviour-pinning tests fail when the behaviour changes and are green before and
  after.
- **F2.** The observable behaviour, the published contract, the schema and the migrations are
  unchanged.
- **F3.** Each step was green on its own; no feature or bug fix rode along.
- **F4.** The candidate list, the rejected candidates and their reasons are in the plan; the
  chosen interface names what sits behind its seam and what it makes testable.
- **F5.** **Step 0** held: every foundation input resolved, or the gap was resolved by the
  architecture card before the refactor began; this card recorded no foundation.

## Delivery

Confirm the report gives every baseline item its status and falsifiable evidence, and gives each
leftover its owner and follow-up. The report is `plan.md`'s table projected onto the card's
acceptance — not a narrative rewritten at delivery. A card with an open omission, a red gate or
an unanswered question is not delivered: close it and re-run, or ask and keep the card open.
The delivered tree is committed on the card's branch and the report carries the `commit` anchor; nothing was merged, rebased or pushed from this card. Deliver at `in_review` through the
`meerkat` board skill. Do not accept your own work.

A no-card run stops here: it records `E5 pending` and writes no board state.
