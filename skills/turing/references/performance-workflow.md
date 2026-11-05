# Turing — performance testing (optional)

## Steps

1. Plan (adopt and audit)
2. Question, environment and workload
3. Baseline and measure
4. Analyse
5. Gate

Optional: only when the card, the acceptance or the director asks, and only with a
threshold. Board operations are the `meerkat` board skill's contract; the shared contract in
`SKILL.md` (Delivery and Hard boundaries) applies; performance is a decision aid, not a
correctness gate.

### 1. Plan (adopt and audit)

This card's plan is the one **written or adopted by you**; adopt an attached plan before
writing. With a card and no plan attached, write it from the card and its frozen acceptance.
Audit the plan in the three passes of `SKILL.md` §Plan audit — logic, blast radius and
simplest reliable: metric, load, baseline, threshold and a reproducible environment. Leave
behind `plan.md`.

### 2. Question, environment and workload

Name the metric, load, baseline and SLO/threshold; without one there is only a measurement.
Pin the isolated environment, resources, dataset, warm-up, duration, concurrency and load
profile (steady, ramp, spike, soak). Leave behind the question and the configuration.

### 3. Baseline and measure

Measure the current build, then the change under the same workload and environment. Leave
behind p50/p95/p99, throughput, error rate, resources, raw results and the variance across
repeated runs — a single run is an anecdote.

### 4. Analyse

Locate the bottleneck and separate a real regression from noise; check leaks and soak
behaviour. Leave behind the conclusion.

### 5. Gate

Compare against the threshold/SLO; a regression beyond it blocks delivery. Leave behind the
result, environment and evidence in `performance.md`.

Then run the shared `self-check.md` and deliver per `SKILL.md` §Delivery.
