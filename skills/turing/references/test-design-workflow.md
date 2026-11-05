# Turing — test design

## Steps

1. Plan (adopt and audit)
2. Inventory
3. Write
4. Review the plan
5. Execute
6. Security
7. Regression

Builds or refreshes the test inventory for a feature or change. The implementation is
delivered for review; the supervisor lands it on acceptance, and the red-green cycle belongs
to the implementation card. Board operations are the `meerkat` board skill's contract; the
shared contract in `SKILL.md` (Delivery and Hard boundaries) applies; for a feature or behaviour change,
the `## Handoff` block (or a project epic graph's stage row in `docs/agents/epic-graphs.md`
when `meta.epic_graph` is set) names the archived spec/PRD, the acceptance source and the
**named report** — read that report. Add `docs/tech-spec.md`, the architecture document and
ADRs when they exist.

### 1. Plan (adopt and audit)

Purpose: settle what the tests must prove. Leave behind `plan.md` and `test-plan.md`.
When a plan already exists, extend it; otherwise call the `meerkat` board skill to adopt the
plan `attachments` (a text `plan.md`, or a transcribed `plan.pdf` with its source);
**no plan attached**: write it from the card and its frozen acceptance; with no card, the handed
task, plan or requirement is the plan source. Settle the branch `frontier` in one decision round
and record the answers in `test-plan.md`. **Audit the plan** in the three passes of `SKILL.md`
§Plan audit — logic, blast radius and simplest reliable: every acceptance item maps to a
scenario and its evidence; order, prerequisites, environments and mock boundaries are written;
no scenario widens acceptance. `test-plan.md` carries scope, environments, data, mock policy,
priority, entry/exit, the traceability matrix and the gates.

### 2. Inventory

Purpose: enumerate what must be tested; leave behind requirement → test rows. Requirements
and acceptance items → scenarios, classified unit, integration, API, browser, boundary,
security and regression, with Must and Should. An acceptance item with no scenario is an
omission; a scenario that widens acceptance is a question, not a test.

### 3. Write

Purpose: express each scenario against the landed implementation; leave behind tests and
evidence rows in `plan.md`. Real input → real path → real output; the quality line is that
the test would fail if the behaviour regressed. Cover boundaries (empty, maximum, unicode,
concurrency, failure), API contracts and browser flows. Keep tests deterministic, offline
and isolated; reject coverage padding, constructor-only and mock-only tests.

### 4. Review the plan

Purpose: prove the inventory is complete and honest; leave behind the checked matrix, the
coverage reading and the review findings in `test-plan.md`. Every acceptance item has a
test; a test that still passes when the behaviour regresses is not evidence. Traceability,
test quality, missing branches, data isolation and determinism are reviewed. Resolve a
blocker before the full run.

### 5. Execute

Purpose: validate the tests themselves; leave behind command, exit code, coverage and
evidence rows. Run the unit, integration, API and browser suites. This validates the tests,
not the delivery — the reviewer re-runs the gate.

### 6. Security

Purpose: cover the change's security surface; leave behind findings with severity and the
scan command or `n/a — <reason>`. Cover authorization, input validation, secrets, injection,
path traversal and SSRF, including API authentication; the dependency audit defaults to
`osv-scanner`. A serious finding blocks delivery — raise it as a question, not a leftover.
The manual checklist is the reviewer's; deliver findings, and leave the security verdict to
the reviewer.

### 7. Regression

Purpose: keep the surrounding behaviour intact; leave behind the existing-suite run and the
regression tests the change needs. Confirm no published contract, schema or migration broke.

Then run the shared `self-check.md` and deliver per `SKILL.md` §Delivery.
