# `monitoring/` — the observability sidecar

The minimum observability surface for Meerkat TaskPanel: a metrics endpoint, a health verdict, a
committed alerting-rules file and an OpenTelemetry export — **zero runtime dependencies,
runnable offline**.

The operator-facing runbook is [`docs/observability.md`](../docs/observability.md). This
file is the map for someone editing the code.

## Layout

```text
monitoring/
├── exporter.mjs                 # the executable: HTTP routes + the OTLP push loop
├── lib/
│   ├── registry.mjs             # counters/gauges/histograms + Prometheus text exposition
│   ├── slo.mjs                  # SLO_TARGETS, window summarisation, histogram_quantile math
│   ├── otlp.mjs                 # snapshot -> OTLP/HTTP+JSON, endpoint resolution, push
│   ├── rules.mjs                # parses the rules file and checks it against SLO_TARGETS
│   ├── yaml.mjs                 # the nested-YAML-subset reader the artefacts are checked with
│   └── errors.mjs               # MonitoringError: every failure carries a code
├── prometheus/
│   ├── prometheus.yml           # scrape config (15s) + rule_files
│   └── meerkat-taskpanel.rules.yml     # the three SLO alerts
└── otel/
    └── collector.yml            # OTLP/HTTP in on :4318, Prometheus out on :8889
```

## Running it

```bash
node monitoring/exporter.mjs
```

Loopback `127.0.0.1:9105` by default; `MONITORING_HOST`, `MONITORING_PORT`,
`MONITORING_OTLP_ENDPOINT` and friends are documented in `docs/observability.md`.

## The one rule this directory lives by

`SLO_TARGETS` in `lib/slo.mjs` is the **single source of truth** for 99.9% availability,
the 0.1% 5xx budget and the 300 ms p95. Everything else is checked against it:

- `/health` reports the verdict *and* the thresholds it used.
- `lib/rules.mjs` derives the expected PromQL tokens from `SLO_TARGETS` and the registry's
  metric names, then parses the committed `meerkat-taskpanel.rules.yml` and fails if any token
  drifted. A relaxed target turns the rules file red until it is updated too.
- `test/monitoring/rules.test.mjs` mutates a parsed copy of the rules to prove the
  validator actually catches drift, rather than merely agreeing with a file it just read.

## Dependency policy

Every module here imports Node builtins or a relative path — nothing else, ever. The test
suite asserts that mechanically (`test/monitoring/artifacts.test.mjs`), and the repository
root keeps an empty `dependencies` map. That is why the exposition format, the OTLP/HTTP
payload and the YAML reader are written in-repo instead of pulled in: the runtime is
offline by design, and the wire formats involved are small, published and stable.

## Tests

```bash
node --test test/monitoring/*.test.mjs
```

`test/monitoring/` covers the registry and its wire format, the SLO math, the YAML reader,
the OTLP mapping, the rules validator and the exporter's real HTTP surface. The only mocks
are *external* I/O: the OTLP receiver is a loopback HTTP server, and the clock is injected.
No test touches the network, and none of them needs the container.
