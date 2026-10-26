# Linus — implementation and bug fixes

Read this from the role workflow for a feature inside the current architecture, a behaviour
change, or a bug fix. The design is already decided; make the smallest correct change and
prove it.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- this card's `.meerkat/<id>/plan.md`, written by you before starting;
- for a feature or behaviour change, the card's `## Handoff` block (with
  `meta.design_stage`) names the archived spec, PRD and prototype and the acceptance
  source. Read those paths; the card and the frozen `acceptance` remain the contract; where
  a design artifact disagrees, write a `question` instead of choosing. Never read the design
  card's `plan.md` as this card's plan;
- the architecture document and ADRs, when the repository has them;
- for a bug: the report, the reproduction and any production evidence. A bug fix does not
  need the design artifacts; reproduce the defect and fix its root cause.

## Steps

### 1. Understand and reproduce

Follow the workspace rule in `CLAUDE.md`/`AGENTS.md`: work in the card's linked worktree,
shared by the card's roles, and create it before touching code if it does not exist. If the
handoff names a path that does not exist, ask; do not guess a content slug. An epic child
implements only its own scope. Restate the goal and the affected behaviour. For a bug, write
a failing test that reproduces the root cause — not the symptom — before changing the code.
List the blast radius: callers, contracts, migrations, configuration and data.

### 2. Design the smallest change

#### Apply the design principles

Apply the six principles as the tie-breakers for this change, before naming files or
freezing the design. The definitions and the conflict ordering live in the project's
`docs/architecture.md` (the `/init` product restates them as every agent's baseline).
Answer each question for this change and name the evidence:

- **Simple** — can a newcomer follow one primary use case end to end without a diagram, and
  is there one obvious way? Name the single path and the files on it.
- **Reliable** — what happens when each dependency fails, is slow, or returns garbage? Name
  the failure paths and the tests that cover them.
- **Efficient** — where is the cost measured, and what is the bound? Name the existing
  budget, or state that no optimization is claimed.
- **Elegant** — do the names, errors and contract tell one story? Name the one place each
  concern lives.
- **Not over-engineered** — what happens if this layer, pattern or dependency is deleted?
  Name its forcing function, or do not add it.
- **High cohesion, low coupling** — does each module or function have one reason to change,
  with dependencies pointing one way? Name the boundary and the interface it crosses.

When they conflict: simplicity and reliability first; efficiency needs a measurement;
elegance constrains how, never adds machinery; a boundary is not traded for speed, and
crossing one is a recorded decision. A departure is a recorded decision, not a silent drift.

Choose the smallest correct design. Run the decision round (the policy this handoff names)
on the open design questions — one round, one question string, each with a recommendation;
check the terms against `GLOSSARY.md` and update it inline as they settle.
Name the files and contracts you will touch. If the card contains independent deliverables,
do not split it yourself; ask the project session.

### 3. Implement test-first

Red → green → refactor. Keep the change scoped: no speculative abstraction, no dependency
addition without a decision, no drive-by rename.

### 4. Operations

A deploy or operational change needs a rollback and observability. Never run a destructive
or irreversible command without the human.

### 5. Code review

Check correctness, published contracts, migrations, error paths, dead code and tests.
Remove dead code only when it is proven dead. Do not mix a refactor into a bug fix.

### 6. Gates

Run the repository's documented checks — unit, integration, coverage, API/CLI contracts,
route-request lint, path and signpost checks — and the mandatory gates in `self-check.md`
(all applicable suites 100% pass, line/branch/function coverage >80%, mocks only at external
boundaries, a clean security scan). Record the exact commands and results in the report. A
red gate is a blocker, not a leftover. Do not weaken a gate to make it pass; a waiver is a
human E4 decision.

### 7. Self-check

Run `self-check.md`: every requirement and acceptance item maps to code, a test or evidence.

### 8. Deliver

Re-export the brief (`taskctl export md <id> --out .meerkat/<id>/card.md`), then stop at
`in_review` with a report: what changed, the tests and
gates, the evidence anchors, the acceptance mapping and the leftovers. A production bug fix
carries a regression test and is verified through Turing's regression branch. Delivery is
not integration: the shared workspace rule's merge and cleanup run only after the reviewer
approves or the operator confirms.

## Boundaries

- Do not change a published contract, schema or migration without the human.
- Do not change scope or acceptance yourself.
- Do not accept your own work; the reviewer is independent.
