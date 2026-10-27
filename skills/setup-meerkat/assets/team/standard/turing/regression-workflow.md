# Turing — post-fix regression verification

Read this from the role workflow when a development fix must be verified, including a
production bug. The question is narrow: does the fix remove the defect without breaking
anything around it?

## Inputs

- the bug card and the fix card/report, with the commit or artifact under test;
- this card's `.meerkat/<id>/plan.md` (written by you, not the fix card's plan);
- the original reproduction, logs or production evidence;
- the previous passing baseline and the relevant tests.

The archived spec, PRD and prototype are not inputs here: a bug fix is verified against the
defect, its reproduction, the frozen acceptance and the baseline.

The regression card depends on the fix card. It is post-delivery verification: it does not
replace the fix card's review gate, and a finding creates a fix/rework card. The project
session creates and links it.

## Steps

### 1. Establish the baseline

Record the symptom, the timeline, the affected scope and the current mitigation (for a
production bug). Identify the last known good behaviour and the exact build that failed.

### 2. Reproduce before and after

Run the original failing case against the pre-fix commit or a faithful reproduction: it must
fail. Run it against the fix: it must pass. A test that passes both before and after proves
nothing. Keep both outputs as evidence.

### 3. Blast radius

List the callers, contracts, migrations, configuration, data and adjacent flows the fix
could touch. Build the regression set: targeted, surrounding, contract/schema, and the API
and browser-based cases for the touched surface.

### 4. Verify the fix

Run the targeted test, the integration suite, the UI flow, and the boundary and
concurrency/failure paths. Confirm the fix removes the cause and does not mask the symptom.
Check the error handling and the rollback path.

### 5. Production verification

When the bug is in production, define the check before running it: logs, metrics, traces,
a canary or feature flag, a smoke test, and any data repair. Confirm the symptom is gone and
no new error signature appeared. Record the observation window and the rollback trigger.
Never run a destructive production action without the human.

### 6. Evidence

Record the commands, exit codes, before/after results, the coverage delta and the production
observations. The evidence must let the reviewer reproduce the verdict.

### 7. Deliver

Re-export the brief. Confirm there
are no unrelated changes, the regression test is committed, and the fix card is still in
the round you verified. Deliver at `in_review`; do not issue a verdict.

## Boundaries

- Do not change the fix or the acceptance to make the verification pass.
- Do not accept your own work; the reviewer is independent.
