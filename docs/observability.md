# Observability

The minimum a task-panel deployment needs to be *watched*: one metrics endpoint, one
health verdict, one alerting-rules file and one wired OpenTelemetry export — all
dependency-free, all runnable offline.

The whole stack is a **sidecar**. `monitoring/` never touches `src/core`, `src/server` or
`src/mcp`, so no business semantic changed to make the board observable.

## What runs

| Piece | Path | What it does |
| --- | --- | --- |
| Metrics sidecar | `monitoring/exporter.mjs` | Serves `/metrics`, `/health`, `/v1/observe`; optionally pushes OTLP |
| Metrics model | `monitoring/lib/registry.mjs` | Counters / gauges / histograms and the Prometheus **text exposition format** |
| Thresholds | `monitoring/lib/slo.mjs` | `SLO_TARGETS` — the single source of truth for every number below |
| OTLP wiring | `monitoring/lib/otlp.mjs` | Maps a snapshot to OTLP/HTTP + JSON and pushes it |
| Alert rules | `monitoring/prometheus/task-panel.rules.yml` | The committed Prometheus rules |
| Scrape config | `monitoring/prometheus/prometheus.yml` | Loads the rules, scrapes the sidecar every 15s |
| Collector config | `monitoring/otel/collector.yml` | Receives OTLP on `:4318`, re-exposes it on `:8889` |
| Stack | `docker/docker-compose.observability.yml` | Sidecar + Prometheus + collector as one overlay |

## Startup

### Offline, zero-dependency (the default)

```bash
node monitoring/exporter.mjs
```

That is the whole startup. There is **no network access, no `npm install` and no
container required**: the sidecar uses Node builtins only and binds loopback
`127.0.0.1:9105`. With nothing configured the OTLP export is disabled and `/metrics` plus
`/health` still answer — which is what the test suite exercises.

```bash
curl -s localhost:9105/metrics | head
curl -s localhost:9105/health
```

### With the observability stack

```bash
docker compose -f docker/docker-compose.observability.yml up
```

This adds Prometheus (`:9090`, rules loaded) and an OpenTelemetry Collector (`:4318`
OTLP/HTTP in, `:8889` Prometheus out) around the same sidecar. The overlay reuses the
repository image — it declares no Dockerfile of its own — and mounts every config file
read-only, so the running containers never write configuration back into the repo.

Those two upstream images (`prom/prometheus`, `otel/opentelemetry-collector-contrib`) are
**pulled**, so this path needs the images present. The sidecar path above needs nothing.

## Shutdown

- `SIGINT` / `SIGTERM` to `node monitoring/exporter.mjs`: the sidecar stops accepting
  connections, clears the OTLP push interval, drains the listener and exits `0`.
- `docker compose -f docker/docker-compose.observability.yml down`: stops the three
  services. The `prometheus-data` volume is a **named** volume, so it survives `down` —
  the alerting history is not silently dropped. Add `-v` to remove it too.

An observability outage is deliberately not a task-panel outage: if the OTLP receiver
refuses, times out or disappears, the push is recorded as a failure (`otel.lastError`) and
`/metrics` keeps serving. Only a real SLO breach makes `/health` answer non-2xx.

## Endpoints

### `GET /metrics` — Prometheus text format

The exposition format, `text/plain; version=0.0.4`:

```
task_panel_http_requests_total{method="GET",route="/api/tasks",status="200"} 42
task_panel_http_failures_total{reason="http_5xx"} 3
task_panel_http_request_duration_seconds_bucket{method="GET",route="/api/tasks",le="0.3"} 40
task_panel_up 1
```

The standard families are created on the first observation, so a freshly started sidecar
exposes only its own series (`task_panel_up`, `task_panel_exporter_info{version="…"}`,
`task_panel_exporter_scrapes_total`). Output is deterministic: families render in
registration order and series sort within a family, so two scrapes of the same state are
byte-identical.

### `GET /health` — the SLO verdict

`200` while the thresholds hold or there is not enough data; `503` once a window breaches
one. The response echoes the thresholds, so an operator never has to guess which numbers
produced the verdict:

```json
{
  "status": "degraded",
  "window": { "samples": 60, "minSamples": 20, "sloWindowText": "5m" },
  "thresholds": { "availabilityRatio": 0.999, "errorRatio5xx": 0.001, "p95LatencyMs": 300 },
  "breached": ["availability", "errorRate5xx"],
  "otel": { "enabled": true, "lastOk": true }
}
```

### `POST /v1/observe` — the push ingest

One observation, or a batch. `202` with `{accepted, rejected}`:

```bash
curl -s -X POST localhost:9105/v1/observe -H 'content-type: application/json' \
  -d '{"observations":[{"method":"GET","route":"/api/tasks","status":200,"durationMs":12}]}'
```

An observation is `{method, route, status, durationMs, failure?}`. `failure` names a
transport-level failure (`timeout`, `aborted`) that produced no status. A **4xx is not a
failure** — it is the caller's error — while a 5xx and a transport failure both are. Bad
input is rejected with a coded JSON error (`INVALID_OBSERVATION`, `PAYLOAD_TOO_LARGE`) and
the sidecar keeps serving.

## The threshold set

`SLO_TARGETS` in `monitoring/lib/slo.mjs` is the source of truth; the alerting rules and
these docs are checked against it.

| Signal | Target | Window |
| --- | --- | --- |
| Availability | **99.9%** | 5m |
| 5xx error rate | **≤ 0.1%** | 5m |
| Latency **p95** | **≤ 300 ms** | 5m |

Below 20 observations in the window the verdict is `insufficient_data`: too little traffic
to vouch for a percentage, so the sidecar says so instead of guessing. It answers `200`,
and any raw breach is still reported in `breached`.

The p95 is a **bucket-resolution** estimate — the same linear interpolation over the same
bucket layout that Prometheus' `histogram_quantile()` performs, computed locally so the
healthcheck and the alert cannot disagree. It is an estimate, not an exact percentile.

## The alerting rules

`monitoring/prometheus/task-panel.rules.yml`, group `task-panel-slo`:

| Alert | Fires when | For | Severity |
| --- | --- | --- | --- |
| `TaskPanelAvailabilityBelowSLO` | failures / attempts over 5m > 0.001 | 5m | critical |
| `TaskPanelErrorRate5xxAboveBudget` | 5xx / attempts over 5m > 0.001 | 5m | critical |
| `TaskPanelP95LatencyAboveBudget` | `histogram_quantile(0.95, …)` > 0.3 | 10m | warning |

Two rules, not one, because availability counts *every* failure while the 5xx budget counts
server errors only — a timeout storm and a 503 storm deserve different alerts.

The thresholds are not restated by hand: `monitoring/lib/rules.mjs` derives them from
`SLO_TARGETS` and from the registry's metric names, parses the committed YAML and fails if
an expression no longer carries them. Relax a target and the rules file goes red until it is
updated too, so an alert cannot silently rot to the old number. No rule points at a real
external alert channel — `alertmanager` is deliberately not part of this stack.

## OpenTelemetry export

The same snapshot that `/metrics` renders is pushed to an OTLP/HTTP receiver, so a series
can be traced 1:1 between Prometheus and the collector. Enable it with either variable:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — a **base** URL; the `/v1/metrics` path is appended.
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` — the **full** URL for this signal; used verbatim.
- `MONITORING_OTLP_ENDPOINT` — the sidecar's own variable; wins over both of the above.

The payload is OTLP/HTTP with a JSON body: cumulative temporality, `resource` carrying
`service.name` / `service.version`, and metric names passed through verbatim (with `_total`
and `_bucket` suffixes intact) so nothing has to be re-mapped when reading both backends.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONITORING_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` inside a container) |
| `MONITORING_PORT` | `9105` | Listen port |
| `MONITORING_SERVICE_NAME` | `task-panel` | `service.name` on the OTLP resource |
| `MONITORING_SLO_WINDOW_MS` | `300000` | The rolling window `/health` judges |
| `MONITORING_SLO_P95_LATENCY_MS` | `300` | The p95 budget |
| `MONITORING_OTLP_ENDPOINT` | *(unset)* | OTLP receiver; unset disables the push |
| `MONITORING_OTLP_INTERVAL_MS` | `15000` | Push interval |
| `MONITORING_OTLP_TIMEOUT_MS` | `3000` | Per-push timeout |
| `MONITORING_MAX_BODY_BYTES` | `1048576` | Largest `/v1/observe` body |

An unusable value (a non-integer port, a negative window) fails at startup with a coded
`INVALID_ARGUMENT` rather than being coerced into something surprising.

## Verifying it

Everything that must actually *run* runs in the container, per the repository's rule:

```bash
node --test test/monitoring/*.test.mjs   # the unit + loopback suite
npm run verify:docker                    # the containerised gate
```

The `test/monitoring/` suite drives the real HTTP server over loopback and stands up the
OTLP receiver as another loopback server — no external network is touched. The declarative
artefacts (`prometheus.yml`, the rules, the collector config, the compose overlay) are
parsed structurally and, where the compose CLI is available, checked with `docker compose
config`.

## Limits

- The p95 is bucket-resolution, as described above.
- The sample ring keeps the most recent 4096 observations in memory; `/health` reads the
  configured window out of it, and counters are cumulative since process start.
- The sidecar is a single process with a single writer of its own state, matching the
  service model of the rest of the project.
