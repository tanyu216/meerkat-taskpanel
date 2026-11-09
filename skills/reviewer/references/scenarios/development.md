# Scenario — development

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** architecture, implementation, refactoring, a bug fix, docs/operations/release,
or a mixed delivery that changes code and its records.

## Checks

### Architecture

Layering and dependency direction; one home per constant and enum, including cross-runtime
mirrors; an ADR for a boundary or cross-cutting decision and the project's ADR status
vocabulary; failure modes; migration and contract impact; directory-tree changes recorded;
conformance to the project's technical standards; DB-first invariants when the project declares
them. A downstream stage sets `stage_handoff=required`, with the current report's `## Handoff`
complete and its paths resolving.

### Implementation / development

Walk these nine checks as nine independent audit passes — one check per pass, each recording its
own evidence in the report — and still return one verdict.

- **TDD and regression evidence.** Red before green: the test fails when the change is
  reverted; a bug fix is red at the parent and green at the delivery. A read-only reviewer uses
  the worker's before/after output, the parent-sha CI run, or `git archive <parent>` into a
  unique temp directory; worktrees and branches stay untouched.
- **Unit tests.** Domain behaviour, branches, error codes and invariants; the test mirrors the
  subject; no I/O leakage.
- **Integration tests against the contract.** Real boundaries, not a mocked-away contract:
  API/CLI snapshots, the declared request schema, the error envelope, storage and domain
  vocabulary parity, wire fields. Mocks only at external boundaries. A surface change without a
  snapshot update is a finding; a change that does not touch the surface needs none.
- **Code against architecture and technical standards.** Dependency direction, naming, a domain
  error with a stable code, the configuration inventory in both directions, logging and
  redaction, dependency and network policy, DB-first invariants, append-only migrations,
  explicit contracts.
- **Code review.** Correctness and edge cases, error handling, concurrency and resources,
  compatibility, dead code, readability, test quality, unrelated changes. Every finding names a
  rule, a reproducible failure or a missing case; a preference without a declared standard is
  not a must-fix.
- **Security scan.** The declared arms plus every `security-checklist.md` row; the checklist is
  a floor, not a ceiling, so add the surface security checks and record them.
- **Coverage and performance.** A reproducible coverage source; a performance claim names the
  number, method and bound.
- **Follow-up.** A report or leftover that names a downstream follow-up card sets
  `stage_handoff=required` and names it in the `## Handoff`; a missing marker is a `REJECT`. A
  defect follow-up filed by its finder in `backlog` is referenced by its identifier.
- The plan-quality refinement applies: every acceptance item maps to code and a test, the blast
  radius is named, and the change is the smallest reliable one.

### Refactor

Behaviour unchanged and pinning/regression tests prove it; no contract drift; no opportunistic
feature; the plan-quality refinement applies to the change.

### Docs / operations / release

One source of truth; the configuration inventory in both directions; release notes follow the
project's release process, including where its changelog is written; version carriers agree;
install/upgrade/rollback evidence; the declared SBOM, monitoring and runbook impact.

## Blocks APPROVE

- A contract change with no snapshot or declared-schema update.
- A test that still passes with the change reverted, or no regression proof on a bug fix.
- A downstream follow-up missing its handoff marker or identifier.
- A security arm recorded as run when it was only read.
- A coverage or performance number without a reproducible source.

## Beyond

Failure injection, upgrade and compatibility matrix, concurrency/backpressure, before/after
benchmarks when performance is claimed.
