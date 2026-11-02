# Turing — regression verification

## Steps

1. Plan (adopt and audit)
2. Establish the baseline
3. Reproduce before and after
4. Blast radius
5. Verify the fix
6. Production verification (when the bug is in production)
7. Evidence

Verifies a development fix, including a **production bug**: does the fix remove the defect
without breaking what surrounds it? Board operations are the `meerkat` board skill's contract;
the shared contract in `SKILL.md` (Delivery and Hard boundaries) applies.

Inputs: the bug card and the fix card/report, the commit under test, the original reproduction,
logs or production evidence, and the previous passing baseline. The archived spec, PRD and
prototype are not inputs here: verify against the defect, reproduction, frozen acceptance and
baseline.

### 1. Plan (adopt and audit)

Purpose: make this card's verification plan cover the defect. Leave behind `plan.md`. This
card's plan is the one written or adopted by you, not the fix card's plan; adopt an attached
plan before writing. Audit it: the baseline, the before/after reproduction and the blast
radius cover the frozen acceptance.

### 2. Establish the baseline

Purpose: know the last good behaviour and the exact failing build. Leave behind the symptom,
timeline, scope, mitigation and the failing build.

### 3. Reproduce before and after

Purpose: prove the bug existed before and is gone after. Leave behind both outputs: the case
fails on the pre-fix commit and passes on the fix. A case that passes both sides proves
nothing.

### 4. Blast radius

Purpose: find what the fix could touch. Leave behind callers, contracts, migrations, config,
data and adjacent flows, plus targeted, surrounding, contract and API/browser cases.

### 5. Verify the fix

Purpose: show the cause is removed, not the symptom masked. Leave behind targeted, integration,
UI, boundary and concurrency/failure results, plus error-handling and rollback observations.

### 6. Production verification

When the bug is in production, define the check before running it. Leave behind logs, metrics,
traces, canary or flag observations, the smoke test, any data repair, the observation window
and the rollback trigger. A destructive production action needs the human.

### 7. Evidence

Purpose: let the reviewer reproduce the verdict. Leave behind commands, exit codes, before and
after results, the coverage delta and production observations in `regression.md`. No unrelated
change; the fix card's delivered round is still current.

Then run the shared `self-check.md` and deliver per `SKILL.md` §Delivery.
