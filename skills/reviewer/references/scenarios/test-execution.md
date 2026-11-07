# Scenario — test execution

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** a test run, a regression proof, a performance result, or any delivery whose
evidence is a command's output.

## Checks

- The run happened at the delivered sha in the named environment; record the command, exit
  code, scope, date and the report or log path.
- A regression proof is red at the parent and green at the delivery. A test that passes with the
  change reverted proves nothing; reproduce it from the worker's before/after output, the
  parent-sha CI run, or `git archive <parent>` into a unique temp directory.
- Every skip, exclusion, quarantine and retry is accounted for; a skip is not a pass.
- The declared legs ran: the project's API and browser suites where declared. A lane that cannot
  run one records the CI run at the sha.
- Flake controls are named, and a flake is not counted as green.
- A performance claim names the number, method, sample, bound and environment; a bound without a
  measured number is a finding.
- Evidence has provenance: a report you read is recorded as read, never as run.

## Blocks APPROVE

- A run not observed at the sha, or a read report passed off as a run.
- A red or partially skipped run softened into a note.
- A regression claim without red-before-green evidence.
- A performance claim without method and bound.

## Beyond

Failure injection, the upgrade/compatibility matrix, concurrency and backpressure.
