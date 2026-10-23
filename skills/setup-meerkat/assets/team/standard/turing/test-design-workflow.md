# Turing — test design and acceptance

Read this from the role workflow when the card builds or refreshes the test inventory for a
feature or change. It covers planning, writing, review, execution, security and regression.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- this card's `.meerkat/<id>/plan.md` and `.meerkat/<id>/test-plan.md`;
- for a feature or behaviour change, the card's `## Handoff` block (`meta.design_stage`)
  when it had a design stage: it names the archived spec/PRD, the acceptance source and the
  implementation/fix card or report. Read `taskctl report list <ref> --json` for a named
  report; do not assume it lives under this card's id;
- the architecture document and ADRs, when the repository has them.

A card with `meta.product_change=none` is a small change or bug: build the inventory from
the card, its acceptance and (for a bug) the defect surface; it does not read design
artifacts.

## Steps

### 1. Inventory

Enumerate the requirements and acceptance items, then the scenarios each one needs.
The PRD's Must items seed the inventory; the frozen acceptance remains the verdict.
Classify them: unit, integration, API, browser/UI, boundary, security, regression. Mark
Must and Should.
Use the canonical terms from `GLOSSARY.md`, `design/glossary.md` and the spec's
`## Terminology` section. An acceptance item with no scenario is an omission.

### 2. Plan

Before finalizing, run the decision round (role workflow) on the open test questions and
record the answers in the test plan. Write `.meerkat/<id>/test-plan.md`: scope and
out-of-scope, environments, data and fixtures, the mock policy, risk-based priority, entry
and exit criteria, a requirement → test traceability matrix, and the mandatory gates
(100% pass, >80% coverage, mock boundary, security scan). The test plan is what the review
reads; `plan.md` is the card's execution plan.

### 3. Write

Test-first where possible. A test uses real input → real path → real expected output. Cover
the boundary cases the change implies: empty, maximum, unicode, concurrency and failure
paths. Exercise real API endpoints and contracts, and real user flows in a browser for a
UI change. Keep tests deterministic and offline. Reject coverage padding, mock-only tests
and constructor-only tests.

### 4. Self-check

Every acceptance item has at least one test. API and browser-based flows are covered where
the change exposes them. A test must fail for the right reason before it passes. No flaky
sleep, no network dependency, no shared mutable state between tests. The coverage floor is
met.

### 5. Test-case review

The project session or a designated peer reviews the plan: traceability, test quality,
missing branches, data isolation and determinism. Record the findings and their disposition
on the card. Do not start the full run with an unhandled blocker.

### 6. Execute your tests

Run the unit, integration, API and browser-based suites you wrote to prove they fail for
the right reason and pass with the change; record the command, exit code and coverage.
This validates the tests, not the delivery — the reviewer re-runs the gate on the review
card.

### 7. Security tests

Cover authorization boundaries, input validation, secrets, injection, path traversal and
SSRF, including API authentication/authorization, and record severity. You may run the
project's dependency/secret/SAST scan to find findings; the scan is the reviewer's gate, and
a serious finding blocks your plan.

### 8. Regression

Run the existing suite. Add the regression tests the change needs. Confirm no published
contract or schema broke.

### 9. Self-check and deliver

Deliver at `in_review` with the traceability matrix, the commands and results, the
coverage, the security findings and the leftovers. Do not issue a verdict; the reviewer
executes the mandatory gates.

## Boundaries

- Do not change acceptance, scope or the implementation to make a test pass.
- Do not accept your own work; the reviewer is independent.
