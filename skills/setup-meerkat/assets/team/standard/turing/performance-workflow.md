# Turing — performance testing (optional)

Read this from the role workflow only when the card, the acceptance or the project session
asks for performance, latency, throughput or resource testing. It never starts by default.
Performance is a decision aid, not a correctness gate.

## Steps

### 1. Define the question

Name the metric, the load, the baseline and the SLO or threshold. Without a threshold there
is no test, only a measurement.

### 2. Environment and workload

Isolate the environment, pin the resources, and define the dataset, warm-up, duration,
concurrency and load profile (steady, ramp, spike, soak). Record the configuration.

### 3. Baseline

Measure the current build: p50/p95/p99, throughput, error rate, CPU, memory and I/O. Keep
the raw results with the configuration.

### 4. Measure the change

Run the same workload in the same environment. Repeat the runs and report the variance, not
a single sample. A single run is an anecdote.

### 5. Analyse

Locate the bottleneck: CPU, I/O, lock contention, allocation or query cost. Separate a real
regression from noise. Check for leaks and soak behaviour.

### 6. Gate

Compare against the threshold or SLO. A regression beyond the threshold blocks delivery.
Record the evidence and the environment.

### 7. Deliver

Re-export the brief (`taskctl export md <id> --out .meerkat/<id>/card.md`), then deliver at
`in_review` with the reproducible command and configuration, the raw results, the variance,
the conclusion and the leftovers. Do not issue a verdict.

## Boundaries

- Do not run this branch without a request and a threshold.
- Do not change the implementation or acceptance to make the numbers pass.
- A performance result is evidence for a decision, not an acceptance verdict.
