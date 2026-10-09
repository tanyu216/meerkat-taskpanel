/**
 * OpenTelemetry (OTLP/HTTP + JSON) export wiring.
 *
 * The sidecar is *the* metrics source: it renders Prometheus text for scraping and, when
 * an endpoint is configured, pushes the same snapshot to an OTLP collector. Both views
 * come from one `Registry#snapshot()`, so a Prometheus scrape and an OTLP export can
 * never disagree about a counter.
 *
 * Deliberate choices, because they are the parts a reviewer would otherwise assume:
 *
 *   - **Hand-rolled, zero-dependency.** The real SDK is a large dependency tree and the
 *     project's runtime is dependency-free and offline; OTLP/HTTP with a JSON body is a
 *     published, stable wire format. `node:fetch` is enough.
 *   - **Metric names are passed through verbatim** (with `_total` and `_bucket`
 *     suffixes intact) rather than being rewritten to OTel dotted conventions, so a
 *     series can be traced 1:1 between Prometheus and the collector. The cost is that
 *     the names are not idiomatic OTel; the benefit is that they are unambiguous.
 *   - **The push never throws.** The receiver is external I/O: a refusal, a timeout or a
 *     DNS failure is reported as `{ok: false, code, error}` so the scraper keeps serving
 *     and `/health` keeps answering. An observability outage must not become a meerkat-taskpanel
 *     outage.
 */

import { MonitoringError } from "./errors.mjs";

/** The instrumentation scope name reported to the collector. */
export const SCOPE_NAME = "meerkat-taskpanel/monitoring";
/** `service.name` when the caller does not name one. */
export const DEFAULT_SERVICE_NAME = "meerkat-taskpanel";
/** OTLP `aggregationTemporality`: 2 = cumulative. */
export const CUMULATIVE = 2;
/** The OTLP/HTTP metrics path. */
export const METRICS_PATH = "v1/metrics";

/** Nanoseconds since the epoch, as the decimal string OTLP wants (JSON has no int64). */
export function toUnixNanoString(milliseconds) {
  return (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
}

/** Append the OTLP metrics path to a base URL, leaving an explicit one alone. */
export function withMetricsPath(endpoint) {
  const trimmed = String(endpoint).replace(/\/+$/u, "");
  return trimmed.endsWith(`/${METRICS_PATH}`) ? trimmed : `${trimmed}/${METRICS_PATH}`;
}

/**
 * Resolve the configured endpoint from the environment.
 *
 * Per the OTLP spec the *signal-specific* variable
 * (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is the full URL for this signal and is used
 * verbatim, while the generic `OTEL_EXPORTER_OTLP_ENDPOINT` is a base URL that gets the
 * metrics path appended. The signal-specific variable wins. Returns `null` when neither is
 * set — the sidecar then serves `/metrics` only, which is the offline default.
 */
export function resolveOtlpEndpoint(env = {}) {
  const specific = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (specific) return String(specific);
  return env.OTEL_EXPORTER_OTLP_ENDPOINT ? withMetricsPath(env.OTEL_EXPORTER_OTLP_ENDPOINT) : null;
}

/** OTLP attribute list from a metric's labels, in label order. */
function labelAttributes(labels) {
  return Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

/** An OTLP number: int64 as a string, anything else as a double. */
function numberValue(value) {
  return Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

/**
 * Map a registry snapshot onto an OTLP `ExportMetricsServiceRequest` (JSON encoding).
 *
 * Families with no series are omitted: an empty metric is noise in every backend, and the
 * registry only creates a series once something was recorded.
 *
 * @param {{generatedAt: number, metrics: object[]}} snapshot
 * @param {{serviceName?: string, serviceVersion?: string, startTimeUnixNano?: string,
 *   timeUnixNano?: string, resourceAttributes?: Record<string,string>,
 *   scopeName?: string, scopeVersion?: string}} [options]
 */
export function toOtlpPayload(
  snapshot,
  {
    serviceName = DEFAULT_SERVICE_NAME,
    serviceVersion = "unknown",
    startTimeUnixNano = "0",
    timeUnixNano = toUnixNanoString(snapshot?.generatedAt ?? 0),
    resourceAttributes = {},
    scopeName = SCOPE_NAME,
    scopeVersion = serviceVersion,
  } = {},
) {
  const attributes = [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "service.version", value: { stringValue: serviceVersion } },
    ...Object.entries(resourceAttributes).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
  ];

  const metrics = [];
  for (const metric of snapshot?.metrics ?? []) {
    if (metric.series.length === 0) continue;

    if (metric.type === "histogram") {
      metrics.push({
        name: metric.name,
        description: metric.help,
        unit: "s",
        histogram: {
          aggregationTemporality: CUMULATIVE,
          dataPoints: metric.series.map((series) => {
            const finite = series.buckets.filter((bucket) => Number.isFinite(bucket.le));
            const bucketCounts = finite.map((bucket, index) => bucket.count - (index === 0 ? 0 : finite[index - 1].count));
            bucketCounts.push(series.count - (finite.length === 0 ? 0 : finite[finite.length - 1].count));
            return {
              attributes: labelAttributes(series.labels),
              startTimeUnixNano,
              timeUnixNano,
              count: series.count,
              sum: series.sum,
              bucketCounts,
              explicitBounds: finite.map((bucket) => bucket.le),
            };
          }),
        },
      });
      continue;
    }

    const dataPoints = metric.series.map((series) => ({
      attributes: labelAttributes(series.labels),
      startTimeUnixNano,
      timeUnixNano,
      ...numberValue(series.value),
    }));

    metrics.push(
      metric.type === "counter"
        ? {
            name: metric.name,
            description: metric.help,
            unit: "1",
            sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints },
          }
        : { name: metric.name, description: metric.help, unit: "1", gauge: { dataPoints } },
    );
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes },
        scopeMetrics: [{ scope: { name: scopeName, version: scopeVersion }, metrics }],
      },
    ],
  };
}

/**
 * Push a snapshot to an OTLP/HTTP receiver. Never throws.
 *
 * @param {object} snapshot
 * @param {{endpoint: string, headers?: Record<string,string>, timeoutMs?: number,
 *   fetchImpl?: typeof fetch} & Parameters<typeof toOtlpPayload>[1]} options
 * @returns {Promise<{ok: true, status: number} | {ok: false, code: "OTLP_REJECTED"|"OTLP_EXPORT_FAILED", status?: number, error: string}>}
 */
export async function exportMetrics(snapshot, options = {}) {
  const { endpoint, headers = {}, timeoutMs = 5_000, fetchImpl = globalThis.fetch, ...payloadOptions } = options;

  let url;
  try {
    url = withMetricsPath(endpoint);
  } catch (error) {
    return { ok: false, code: "OTLP_EXPORT_FAILED", error: error instanceof Error ? error.message : String(error) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MonitoringError("OTLP_EXPORT_FAILED", { message: `OTLP export timed out after ${timeoutMs} ms` })), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(toOtlpPayload(snapshot, payloadOptions)),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, code: "OTLP_REJECTED", status: response.status, error: `the OTLP receiver answered ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, code: "OTLP_EXPORT_FAILED", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
