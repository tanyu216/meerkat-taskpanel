# Linus — implementation and bug fixes

A feature inside the recorded architecture, a behaviour change, or a bug fix. The design is
decided; make the smallest correct change and prove it.

Board operations are the `meerkat` board skill's contract; decisions follow the loop's
`decision-policy.md`. **Linus recommends, the director decides; E1–E5 belongs to the human.**

## Steps at a glance

1. Understand and reproduce.
2. Design the smallest change.
3. Implement test-first.
4. Review your change.
5. Verify the gates.
6. Run the self-check.
7. Deliver.

## Decision frontier

The round settles the smallest design, files and contracts, test selection and any dependency.
Record the answers in `plan.md`; Linus recommends, the director decides.

This card's plan is the one **written or adopted by you** and audited before starting.
**A bug fix does not need the design artifacts**: use the report, the reproduction and any
production evidence; for a feature or behaviour change, the `## Handoff` block names the
archived spec, PRD and prototype and the acceptance source. A design artifact that disagrees
with the card is a question, not a choice. Read `docs/tech-spec.md`, the architecture document
and the ADRs when present; a missing handoff path is a question, not a guessed slug.

### 1. Understand and reproduce

**Purpose.** State the goal, affected behaviour and blast radius before changing code.

**Watch for.** A bug gets a failing test that reproduces the root cause, not the symptom. List
the callers, contracts, migrations, configuration and data the change can touch. An epic child
implements only its scope.

**Essentials.** The restated goal; the failing test and reproduction for a bug; the blast radius
in `plan.md`.

### 2. Design the smallest change

**Purpose.** Choose the smallest correct design and name its evidence.

**Watch for.** Apply the six principles with evidence for this change: **simple** — one obvious
path; **reliable** — the failure paths and their tests; **efficient** — the measured budget or no
claim; **elegant** — one place per concern; **not over-engineered** — every abstraction names its
forcing function; **high cohesion, low coupling** — each module or function has **one reason to change**, dependencies point one way. Simplicity and reliability first; efficiency needs a
measurement; elegance constrains how, never adds machinery. A departure is a **recorded
decision**, never silent drift. Definitions live in `docs/architecture.md`; `docs/tech-spec.md`
carries the enforceable rules.

**Essentials.** The files and contracts; the decision answers; terms checked in `GLOSSARY.md`;
the test plan; an independent deliverable is not split by you — the card's layers are `not the layers of one change`, so ask the director.

### 3. Implement test-first

**Purpose.** Make the behaviour change with the test that proves it.

**Watch for.** Test-first is the default; a bug is reproduced by a failing test at the root cause
before the fix. Keep the change scoped: no speculative abstraction, dependency without a
decision, or drive-by rename.

**Essentials.** The red → green → refactor cycle; a test that fails without the change; the
scoped diff.

### 4. Review your change

**Purpose.** Catch the gaps the tests leave before the gates.

**Watch for.** Correctness, public contracts, migrations, error paths, dead code, logging and
tests. A new key flow emits its `info` line and a new failure path one `error` line with its
code; keep secrets out of logs. Remove dead code only when proven dead; keep a refactor out
of this diff.

**Essentials.** The findings and fixes; the logging evidence.

### 5. Verify the gates

**Purpose.** Produce the evidence the delivery rests on.

**Watch for.** Run every applicable suite and the mandatory gates in `self-check.md`: unit,
integration, API and browser-based suites **100%** pass; line/branch/function coverage **≥80%**;
mocks only at http, websocket, db, redis and comparable external boundaries; internal modules
stay real. The security scan (dependency audit default `osv-scanner`, secret scan,
SAST) has no unaddressed high/critical. A red gate is a blocker; a waiver is a human E4 decision.

**Essentials.** The commands, exit codes and coverage recorded; a red gate is not delivered.

### 6. Self-check

**Purpose.** Audit the evidence before delivery.

**Watch for.** `self-check.md` (Implementation branch) is the authoritative checklist; every
requirement and acceptance item maps to code, a test or evidence.

**Essentials.** The requirement/acceptance → code/test/evidence table in `plan.md`, one
disposition per row.

### 7. Deliver

**Purpose.** Make the change reviewable and auditable.

**Watch for.** The tree is committed and the report carries the `commit` anchor; the board's delivery gate (`DELIVERY_NEEDS_COMMIT`) refuses a report that does not. Deliver the committed tree; the supervisor's acceptance pass merges, rebases, pushes and cleans up. A production bug fix
carries a committed regression test. Turing's verification is a downstream follow-up card:
outside a project epic graph a card without a verification card sets
`meta.stage_handoff=required` and names the verification scope; inside a graph the verification
stage already exists and the report names it. A defect follow-up filed in `backlog` stands on
its own.

**Essentials.** Commit the delivered tree; call the `meerkat` board skill to deliver at
`in_review` with what changed, the tests and gates, the evidence anchors, the acceptance
mapping, the `## Handoff` when the card has one, and the leftovers.

## Boundaries

- No restructuring here; a refactor card runs `refactor-workflow.md`.
- A published contract, schema or migration change needs the human.
- A scope or acceptance change is a question.
- Stop at `in_review`; the reviewer is independent.
