# Reviewer audit — development

This is a refinement of the universal floor in `SKILL.md`; read that first. The scenario files
are refinements, not a scope; a mixed card reads every matching file. Board operations are the
`meerkat` board skill's contract.

## Architecture (Linus)
**Floor.** Layering and dependency direction; one home per constant/enum (including cross-runtime mirrors); an ADR for a boundary or cross-cutting decision; ADR status vocabulary; failure modes; migration and contract impact; directory-tree changes recorded; project technical-standard conformance; DB-first invariants when the project declares them. The card sets `stage_handoff=required`; the current report's `## Handoff` is complete and its paths resolve; the project's `meta.review_gate` is recorded when the foundation declares a gate.
Apply the plan-quality refinement; the blast radius is a floor here, not a Beyond item.
**Beyond.** Threat model, upgrade path.

## Development / implementation (Linus)
**Floor.** TDD/regression evidence: red before green; the test fails when the change is reverted; a bug fix has evidence red at the parent and green at the delivery. A read-only reviewer uses the worker's before/after output, the parent-sha CI run, or `git archive <parent>` into a unique temp directory to run the test; worktrees and branches stay untouched.
- **Unit tests:** domain behaviour, branches, error codes, invariants, test mirrors the subject; no I/O leakage.
- **Integration tests against the contract:** real boundaries, not a mocked-away contract; API/CLI snapshots, declared request schema, error envelope, storage/domain vocabulary parity, wire fields. Mocks only at external boundaries. A surface change without a snapshot update is a finding; a change that does not touch the surface does not require one.
- **Code against architecture and technical standards:** dependency direction, naming, a domain error with a stable code, config inventory in both directions, logger/redaction, dependency and network policy, DB-first invariants, append-only migrations, explicit contracts.
- **Code review:** correctness and edge cases, error handling, concurrency/resources, compatibility, dead code, readability, test quality, unrelated changes. Every finding names a rule, a reproducible failure or a missing case; a preference without a declared standard is not a must-fix.
- **Security scan:** the declared arms plus every `security-checklist.md` row; the checklist is a floor, not a ceiling, so add surface security checks and record them.
- **Coverage and performance:** a reproducible coverage source; a performance claim names the number, method and bound.
- **Follow-up:** a report or leftover that names a follow-up card must set `stage_handoff=required` and name it in the `## Handoff`; a missing marker is a `REJECT`.
Apply the plan-quality refinement to the change: every acceptance item maps to code and a test, the blast radius is named, and the change is the smallest reliable one.
**Beyond.** Failure injection, upgrade/compatibility matrix, concurrency/backpressure.

## Refactor (Linus)
**Floor.** Behaviour unchanged; pinning/regression tests prove it; no contract drift; no opportunistic feature.
Apply the plan-quality refinement to the change: every acceptance item maps to code and a test, the blast radius is named, and the change is the smallest reliable one.
**Beyond.** Before/after benchmark when performance is claimed.

## Docs / operations / release
**Floor.** One source of truth; config inventory in both directions; release notes follow the project's release process (this repo: CHANGELOG only on the release branch); version carriers agree; install/upgrade/rollback evidence; declared SBOM/monitoring/runbook impact.
**Beyond.** Runbook and alerting changes.
