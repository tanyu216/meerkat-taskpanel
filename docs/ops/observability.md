# Observability

The minimum a meerkat-taskpanel deployment needs to be *watched*: one metrics endpoint, one
health verdict, one alerting-rules file and one wired OpenTelemetry export — all
dependency-free, all runnable offline.

The whole stack is a **sidecar**. `monitoring/` never touches `src/core` or `src/server`,
so no business semantic changed to make the board observable.

Logs are the other half and are **not** part of the sidecar: the processes write them
themselves (see [Structured logs](#structured-logs)). The two signals are deliberately
separate — the sidecar is fed observations from outside, while the log is the process's
own account of what it did.

## Structured logs

One facility, `src/foundation/log.mjs`, for `taskd`, `taskctl` and the loop. It implements
the `logger({ event, ... })` seam that `openBoard`, the write lock, the migration runner,
the command context and the server already used — before this existed, `taskd` supplied no
logger and every one of those events was dropped.

### Levels and the default

`debug < info < warn < error < off`, selected by `TASKD_LOG_LEVEL` (default `info`).

- `info` — the core paths: startup/shutdown, a request, a migration applied, label GC and
  container sweeps.
- `warn` — recovered or suspicious: a stale write lock taken over, a stale schema, a
  label-count mismatch, a refused command (a 4xx `DomainError`).
- `error` — the exception boundaries: a 5xx or unmapped request failure, a failed
  background job, a startup failure, an SSE read failure, a 5xx command failure.
- `debug` — per-command success, SSE open/close, `/health` and static traffic, CLI
  dispatch. Silent unless asked for.

A 4xx is the **caller's** error, so it is a `warn` at most; the rendered CLI error is not
duplicated into the log. The CLI is `off` unless `TASKD_LOG_LEVEL` is set, because its
stdout is the data plane and its stderr is the product's error surface.

### Event catalogue

| Event | Level | Emitted when |
| --- | --- | --- |
| `startup`, `shutdown_signal`, `shutdown_complete` | info | the daemon's lifecycle |
| `board_opened` | info | the database is open at the schema this build expects |
| `token_created`, `token_rotated` | info | first boot / credential rotation — the file is named, the token never is |
| `migration_applied` | info | one migration ran |
| `migrations_skipped` | debug | a restart found every migration already applied |
| `request` | info (debug for `/health` and static) | one HTTP call |
| `sse_stream_opened`, `sse_stream_closed` | debug | an event stream's lifetime, joinable by `request_id` |
| `task_created`, `task_claimed`, `task_moved`, `task_archived` | info | the card lifecycle backbone — one line per real transition (a re-claim by the same holder and a reopen's underlying move are not repeated) |
| `report_written`, `task_delivered`, `task_reopened` | info | a report, a delivery (including a waived one), a terminal card back in work |
| `label_gc_scheduled`, `label_gc_disabled` | info | the startup housekeeping policy |
| `label_gc`, `container_sweep` | info | a sweep that changed something (an empty one is silent) |
| `command` | debug | a command succeeded |
| `command_failed` | warn (4xx) / error (5xx or unmapped) | a command was refused or failed |
| `schema_stale`, `writer_lock_stale`, `writer_lock_release_failed`, `label_gc_mismatch`, `allow_list_invalid`, `sla_config_invalid`, `log_level_invalid` | warn | recovered or suspicious, but the process carries on |
| `request_failed`, `startup_failed`, `shutdown_failed`, `board_open_failed`, `migration_failed`, `sse_stream_failed`, `label_gc_failed`, `container_sweep_failed` | error | an exception boundary |
| `cli_command`, `cli_failure` | debug | CLI diagnostics (off unless `TASKD_LOG_LEVEL=debug`) |

The loop writes free-form lines rather than event objects (`time=… level=info
component=supervisor msg="…"`), and marks a failure with the same levels: `session: tick
failed`, `continue error`, `workflow: … failed`, `subscribe: dispatch failed` are `error`;
a recoverable one (`notify failed`, a refused question enqueue) is `warn`.

### The line

One line per event in **logfmt** — the de-facto text convention (Heroku, Go's `slog`,
Prometheus exporters): every token is `key=value`, so any logfmt reader parses it and
there is no format-specific grammar to learn.

```
time=2026-10-27T12:34:56.789Z level=info component=taskd event=startup url=http://127.0.0.1:9527 msg="listening on http://127.0.0.1:9527"
time=2026-10-27T12:34:56.790Z level=info event=request method=GET path=/api/v1/tasks status=200 duration_ms=3 request_id=9f1c… actor=human:local
time=2026-10-27T12:34:56.791Z level=warn event=command_failed command=moveStatus code=VERSION_CONFLICT http=409 duration_ms=1
time=2026-10-27T12:34:56.792Z level=error event=request_failed method=POST path=/api/v1/tasks status=500 request_id=9f1c… code=VALIDATION_FAILED
time=2026-10-27T12:34:56.793Z level=info component=supervisor msg="/meerkat-loop Continue — timer turn"
```

- A header-less request carries `actor=human:local` unless `TASKCTL_HUMAN` names the
  configured human (the install-root `.env`), in which case that name is used.
- The fixed prefix is `time=` (ISO-8601 with milliseconds), then `level=`; an optional
  `component=` follows.
- `event=` comes next, then the prose in `msg=`, then every other field. `msg` is an
  ordinary field, so a free-form line and an event line are the same grammar.
- Values are unquoted when they contain no whitespace, `=` or `"`; otherwise they are
  double-quoted with JSON/logfmt escapes. Object values are JSON inside one quoted field
  (`error="{\"name\":\"DomainError\",\"code\":\"DB_BUSY\",…}"`). Long values are truncated.
- Keys are snake_case (`label_id`, `request_id`); camelCase and kebab-case are normalised.
- The whole line is **redacted last**: a `td_…` token in a message or a field becomes
  `td_****`, and a secret-named key (`token`, `secret`, `password`) is blanked outright.
  `token_source` and `token_file` stay readable — they say *where* a token came from.
- The loop's lines carry `component=supervisor` instead of a bare prose prefix.

### Correlation

Every HTTP request gets a `request_id` (a supplied `x-request-id` when it matches
`^[A-Za-z0-9._-]{1,64}$`, else a UUID), which is echoed on the response and carried into
the command layer through `AsyncLocalStorage`. A `command_failed` therefore names the
request it belongs to without any handler passing an id down by hand.

### Where it goes, and rotation

- **stderr** — always. Under systemd that is the journal; under launchd, the unified log.
- **`<dataDir>/logs/taskd.log`** — written and rotated by `taskd` itself. `taskd` is the
  only writer: the systemd/launchd units and the CLI's lazy start deliberately do **not**
  redirect into it, which would duplicate every line. Rotation is by size:
  `TASKD_LOG_MAX_BYTES` (default 10 MiB) into `taskd.log.1 … .N`, with `TASKD_LOG_KEEP`
  (default 5). Files are created `0600` in a `0700` directory.
- **`--log <path>`** — the loop's own file, same sink and rotation, skipped by `--dry-run`.

The log holds no token, no request headers and no argv.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TASKD_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `off` (`warning`/`silent` accepted) |
| `TASKD_LOG_MAX_BYTES` | `10485760` | Largest `taskd.log` before rotation |
| `TASKD_LOG_KEEP` | `5` | Rotated files kept |

An unusable value in `.env` is a `CONFIG_FILE_INVALID` refusal, not a silent fallback.

### Logs are not activities

The board's `task_activities` rows are the **audit trail** — business facts, append-only,
replicated to clients. Log events are operational and local. A new event name belongs in
`EVENT_LEVELS` in `src/foundation/log.mjs`, never in `ACTIVITY_EVENTS`.

## What runs

| Piece | Path | What it does |
| --- | --- | --- |
| Metrics sidecar | `monitoring/exporter.mjs` | Serves `/metrics`, `/health`, `/v1/observe`; optionally pushes OTLP |
| Metrics model | `monitoring/lib/registry.mjs` | Counters / gauges / histograms and the Prometheus **text exposition format** |
| Thresholds | `monitoring/lib/slo.mjs` | `SLO_TARGETS` — the single source of truth for every number below |
| OTLP wiring | `monitoring/lib/otlp.mjs` | Maps a snapshot to OTLP/HTTP + JSON and pushes it |
| Alert rules | `monitoring/prometheus/meerkat-taskpanel.rules.yml` | The committed Prometheus rules |
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

An observability outage is deliberately not a meerkat-taskpanel outage: if the OTLP receiver
refuses, times out or disappears, the push is recorded as a failure (`otel.lastError`) and
`/metrics` keeps serving. Only a real SLO breach makes `/health` answer non-2xx.

## Endpoints

### `GET /metrics` — Prometheus text format

The exposition format, `text/plain; version=0.0.4`:

```
meerkat_taskpanel_http_requests_total{method="GET",route="/api/tasks",status="200"} 42
meerkat_taskpanel_http_failures_total{reason="http_5xx"} 3
meerkat_taskpanel_http_request_duration_seconds_bucket{method="GET",route="/api/tasks",le="0.3"} 40
meerkat_taskpanel_up 1
```

The standard families are created on the first observation, so a freshly started sidecar
exposes only its own series (`meerkat_taskpanel_up`, `meerkat_taskpanel_exporter_info{version="…"}`,
`meerkat_taskpanel_exporter_scrapes_total`). Output is deterministic: families render in
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

`monitoring/prometheus/meerkat-taskpanel.rules.yml`, group `meerkat-taskpanel-slo`:

| Alert | Fires when | For | Severity |
| --- | --- | --- | --- |
| `MeerkatTaskPanelAvailabilityBelowSLO` | failures / attempts over 5m > 0.001 | 5m | critical |
| `MeerkatTaskPanelErrorRate5xxAboveBudget` | 5xx / attempts over 5m > 0.001 | 5m | critical |
| `MeerkatTaskPanelP95LatencyAboveBudget` | `histogram_quantile(0.95, …)` > 0.3 | 10m | warning |

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
| `MONITORING_SERVICE_NAME` | `meerkat-taskpanel` | `service.name` on the OTLP resource |
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
