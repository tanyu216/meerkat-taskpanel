/**
 * The metrics model: counters, gauges and histograms, and the Prometheus *text
 * exposition format* they render to.
 *
 * There is no dependency to lean on (no `prom-client`, no `@opentelemetry/api`), and the
 * project's rule is that the runtime stays dependency-free, so the whole exposition is
 * built here. The contract that matters is the wire format Prometheus scrapes:
 *
 *   # HELP <name> <help>
 *   # TYPE <name> counter|gauge|histogram
 *   <name>{label="value"} <number>
 *
 * Invariants kept on purpose:
 *
 *   - **Deterministic output.** Metric families render in registration order and the
 *     series inside a family are sorted, so two renders of the same state are
 *     byte-identical and a diff is always meaningful.
 *   - **Sums, not rates.** Counters are cumulative since process start; the recent-sample
 *     ring (`windowSamples`) exists only so `/health` can judge a *window* without
 *     keeping a second, divergent set of counters.
 *   - **Fail closed.** A metric name, label name, label value or bucket set that cannot
 *     be exposed unambiguously raises a `MonitoringError` instead of being coerced.
 *
 * The HTTP shape is deliberately part of the model: `observeHttpRequest()` is what
 * populates the standard families and the ring, so `/metrics`, `/health` and the OTLP
 * export all read the same numbers.
 */

import { MonitoringError } from "./errors.mjs";

/** Default duration buckets in seconds — the layout Prometheus' own default library uses. */
export const DEFAULT_DURATION_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

/** The exposition namespace; every metric name starts with it. */
export const NAMESPACE = "meerkat_taskpanel";

/** `meerkat_taskpanel_http_requests_total{method,route,status}` — every observation. */
export const REQUEST_TOTAL = `${NAMESPACE}_http_requests_total`;
/** `meerkat_taskpanel_http_failures_total{reason}` — availability failures only. */
export const REQUEST_FAILURES_TOTAL = `${NAMESPACE}_http_failures_total`;
/** `meerkat_taskpanel_http_request_duration_seconds{method,route}` histogram. */
export const REQUEST_DURATION_SECONDS = `${NAMESPACE}_http_request_duration_seconds`;
/** The failure reason used for an HTTP 5xx. */
export const SERVER_ERROR_REASON = "http_5xx";

/** Metric and label name grammars from the exposition format. */
export const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
export const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** A failure reason is a short snake_case token, never a free-text message. */
export const FAILURE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** How many observations the recent-sample ring keeps by default. */
export const MAX_SAMPLES_DEFAULT = 4096;

/**
 * Format a number the way the exposition format wants it: shortest exact form, no
 * exponent, no `1.0`. 12 significant digits kills the `0.30000000000000004` class of
 * float noise while staying exact for anything a counter or a bucket sum can reach.
 * @param {number} value
 */
export function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MonitoringError("INVALID_ARGUMENT", { details: { value: String(value) } });
  }
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

/**
 * Escape a label value: backslash, double quote and newline, in that order of danger.
 * @param {string} value
 */
export function escapeLabelValue(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}

/**
 * Validate one observation, throwing `INVALID_OBSERVATION` on the first problem.
 *
 * Exported so a batch caller can check every item *before* recording any of them: a batch
 * that fails halfway must not leave half its observations counted.
 *
 * @param {{method: string, route: string, status: number, durationMs: number, failure?: string|null}} observation
 * @returns {{method: string, route: string, status: number, durationMs: number, failure: string|null}}
 */
export function validateObservation(observation) {
  const { method, route, status, durationMs, failure = null } = observation ?? {};
  const invalid = (reason, field) => new MonitoringError("INVALID_OBSERVATION", { details: { reason, field } });

  if (typeof method !== "string" || method.trim() === "" || method.length > 16 || /\s/u.test(method)) {
    throw invalid("method must be a short token without whitespace", "method");
  }
  if (typeof route !== "string" || !route.startsWith("/") || route.length > 64) {
    throw invalid("route must be a path starting with / and at most 64 characters", "route");
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw invalid("status must be an integer between 100 and 599", "status");
  }
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    throw invalid("durationMs must be a finite number >= 0", "durationMs");
  }
  if (failure !== null && (typeof failure !== "string" || !FAILURE_REASON_PATTERN.test(failure))) {
    throw invalid("failure must be a snake_case token, e.g. `timeout`", "failure");
  }

  return { method, route, status, durationMs, failure };
}

/** Escape help text: the exposition format only unescapes `\\` and `\n`. */
export function escapeHelpText(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n");
}

/** One labelled data point, keyed by its canonical label string. */
class Series {
  /** @param {string} labelKey @param {Record<string, string>} labels */
  constructor(labelKey, labels) {
    this.labelKey = labelKey;
    this.labels = labels;
  }
}

/** Shared behaviour for the three metric types. */
class Metric {
  /**
   * @param {{name: string, help: string, labelNames: string[], type: "counter"|"gauge"|"histogram"}} spec
   */
  constructor({ name, help, labelNames, type }) {
    if (!METRIC_NAME_PATTERN.test(name)) {
      throw new MonitoringError("INVALID_METRIC_NAME", { details: { name } });
    }
    for (const label of labelNames) {
      if (!LABEL_NAME_PATTERN.test(label)) {
        throw new MonitoringError("INVALID_LABEL_NAME", { details: { name, label } });
      }
    }
    if (new Set(labelNames).size !== labelNames.length) {
      throw new MonitoringError("INVALID_LABEL_NAME", { details: { name, labelNames, reason: "duplicate label name" } });
    }
    this.name = name;
    this.help = help;
    this.labelNames = Object.freeze([...labelNames]);
    this.type = type;
    /** @type {Map<string, object>} */
    this.series = new Map();
  }

  /**
   * Validate a caller-supplied label set and return its canonical key.
   * @param {Record<string, string|number|boolean>} labels
   */
  keyOf(labels) {
    if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
      throw new MonitoringError("LABEL_SET_MISMATCH", { details: { metric: this.name, reason: "labels must be an object" } });
    }
    const got = Object.keys(labels);
    const missing = this.labelNames.filter((label) => !got.includes(label));
    const extra = got.filter((label) => !this.labelNames.includes(label));
    if (missing.length > 0 || extra.length > 0) {
      throw new MonitoringError("LABEL_SET_MISMATCH", {
        details: { metric: this.name, expected: this.labelNames, missing, extra },
      });
    }
    const ordered = {};
    for (const label of this.labelNames) {
      const raw = labels[label];
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        throw new MonitoringError("INVALID_LABEL_VALUE", { details: { metric: this.name, label, value: String(raw) } });
      }
      ordered[label] = String(raw);
    }
    return JSON.stringify(this.labelNames.map((label) => ordered[label]));
  }

  /** The series for `labels`, created empty on first use. */
  seriesFor(labels) {
    const key = this.keyOf(labels);
    let series = this.series.get(key);
    if (series === undefined) {
      const ordered = {};
      for (const label of this.labelNames) ordered[label] = String(labels[label]);
      series = new Series(key, ordered);
      this.series.set(key, series);
    }
    return series;
  }

  /** Every series, sorted by canonical label string (deterministic rendering). */
  all() {
    return [...this.series.values()].sort((a, b) => (a.labelKey < b.labelKey ? -1 : a.labelKey > b.labelKey ? 1 : 0));
  }

  /** The label suffix for a series: `{a="1",b="2"}`, or "" when the metric is unlabelled. */
  labelSuffix(series) {
    if (this.labelNames.length === 0) return "";
    const pairs = this.labelNames.map((label) => `${label}="${escapeLabelValue(series.labels[label])}"`);
    return `{${pairs.join(",")}}`;
  }
}

/** A monotonically increasing counter. */
export class Counter extends Metric {
  constructor(spec) {
    super({ ...spec, type: "counter" });
  }

  /**
   * @param {Record<string, string|number|boolean>} [labels]
   * @param {number} [by]
   */
  inc(labels = {}, by = 1) {
    if (typeof by !== "number" || !Number.isFinite(by) || by < 0) {
      throw new MonitoringError("INVALID_ARGUMENT", { details: { metric: this.name, by } });
    }
    const series = this.seriesFor(labels);
    series.value = (series.value ?? 0) + by;
    return series.value;
  }

  /** @param {Record<string, string|number|boolean>} [labels] */
  value(labels = {}) {
    return this.seriesFor(labels).value ?? 0;
  }
}

/** A gauge: the last value written wins. */
export class Gauge extends Metric {
  constructor(spec) {
    super({ ...spec, type: "gauge" });
  }

  /** @param {Record<string, string|number|boolean>} labels @param {number} value */
  set(labels, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new MonitoringError("INVALID_ARGUMENT", { details: { metric: this.name, value } });
    }
    this.seriesFor(labels).value = value;
    return value;
  }

  /** @param {Record<string, string|number|boolean>} labels @param {number} [by] */
  inc(labels, by = 1) {
    return this.set(labels, (this.seriesFor(labels).value ?? 0) + by);
  }

  /** @param {Record<string, string|number|boolean>} labels @param {number} [by] */
  dec(labels, by = 1) {
    return this.set(labels, (this.seriesFor(labels).value ?? 0) - by);
  }

  /** @param {Record<string, string|number|boolean>} [labels] */
  value(labels = {}) {
    return this.seriesFor(labels).value ?? 0;
  }
}

/** A cumulative histogram of durations, in seconds. */
export class Histogram extends Metric {
  /**
   * @param {{name: string, help: string, labelNames: string[], buckets: number[]}} spec
   */
  constructor({ name, help, labelNames, buckets }) {
    super({ name, help, labelNames, type: "histogram" });
    const finite = Array.isArray(buckets) ? buckets.filter((le) => Number.isFinite(le)) : [];
    const ascending = finite.every((le, index) => index === 0 || le > finite[index - 1]);
    if (finite.length === 0 || finite.length !== buckets.length || !ascending) {
      throw new MonitoringError("INVALID_BUCKETS", { details: { name, buckets } });
    }
    this.buckets = Object.freeze([...finite]);
  }

  /**
   * Observe a duration in seconds.
   * @param {Record<string, string|number|boolean>} labels
   * @param {number} seconds
   */
  observe(labels, seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      throw new MonitoringError("INVALID_ARGUMENT", { details: { metric: this.name, seconds } });
    }
    const series = this.seriesFor(labels);
    series.count = (series.count ?? 0) + 1;
    series.sum = (series.sum ?? 0) + seconds;
    series.counts ??= this.buckets.map(() => 0);
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (seconds <= this.buckets[index]) series.counts[index] += 1;
    }
    return series.count;
  }

  /**
   * Observe a duration in milliseconds (the unit `observeHttpRequest` speaks).
   * @param {Record<string, string|number|boolean>} labels
   * @param {number} milliseconds
   */
  observeMs(labels, milliseconds) {
    if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
      throw new MonitoringError("INVALID_ARGUMENT", { details: { metric: this.name, milliseconds } });
    }
    return this.observe(labels, milliseconds / 1000);
  }
}

/**
 * The registry: metric families, the recent-sample ring, and the two renderings of the
 * same state (`render()` for Prometheus, `snapshot()` for OTLP and `/health`).
 */
export class Registry {
  /**
   * @param {{now?: () => number, maxSamples?: number, buckets?: number[]}} [options]
   */
  constructor({ now = () => Date.now(), maxSamples = MAX_SAMPLES_DEFAULT, buckets = DEFAULT_DURATION_BUCKETS } = {}) {
    this.now = now;
    this.maxSamples = maxSamples;
    this.buckets = Object.freeze([...buckets]);
    /** @type {Map<string, Metric>} registration order is rendering order */
    this.metrics = new Map();
    /** @type {object[]} */
    this.samples = [];
  }

  /** @param {string} name @param {string} help @param {string[]} [labelNames] */
  registerCounter(name, help, labelNames = []) {
    return this.register(new Counter({ name, help, labelNames }));
  }

  /** @param {string} name @param {string} help @param {string[]} [labelNames] */
  registerGauge(name, help, labelNames = []) {
    return this.register(new Gauge({ name, help, labelNames }));
  }

  /** @param {string} name @param {string} help @param {{labelNames?: string[], buckets?: number[]}} [options] */
  registerHistogram(name, help, { labelNames = [], buckets = this.buckets } = {}) {
    return this.register(new Histogram({ name, help, labelNames, buckets }));
  }

  /** @param {Metric} metric */
  register(metric) {
    const existing = this.metrics.get(metric.name);
    if (existing !== undefined) {
      throw new MonitoringError(existing.type === metric.type ? "DUPLICATE_METRIC" : "TYPE_CONFLICT", {
        details: { name: metric.name, registered: existing.type, attempted: metric.type },
      });
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /** @param {string} name */
  has(name) {
    return this.metrics.has(name);
  }

  /** @param {string} name @returns {Metric|undefined} */
  get(name) {
    return this.metrics.get(name);
  }

  /** The standard HTTP families, registered on first observation. */
  httpMetrics() {
    if (!this.has(REQUEST_TOTAL)) {
      this.registerCounter(REQUEST_TOTAL, "HTTP observations, by method, route and status.", ["method", "route", "status"]);
      this.registerCounter(REQUEST_FAILURES_TOTAL, "Availability failures, by reason (5xx and transport failures).", ["reason"]);
      this.registerHistogram(REQUEST_DURATION_SECONDS, "HTTP observation duration in seconds.", {
        labelNames: ["method", "route"],
      });
    }
    return {
      requests: this.get(REQUEST_TOTAL),
      failures: this.get(REQUEST_FAILURES_TOTAL),
      duration: this.get(REQUEST_DURATION_SECONDS),
    };
  }

  /**
   * Record one HTTP observation.
   *
   * An observation is a *success* unless the status is 5xx or the caller names a
   * transport-level `failure` (a timeout, an aborted socket). A 4xx is the caller's
   * error and is never an availability failure — that distinction is the reason
   * availability and the 5xx budget can disagree, and it is asserted by the tests.
   *
   * @param {{method: string, route: string, status: number, durationMs: number, failure?: string|null}} observation
   */
  observeHttpRequest(observation) {
    const { method, route, status, durationMs, failure } = validateObservation(observation);

    const { requests, failures, duration } = this.httpMetrics();
    requests.inc({ method, route, status: String(status) });
    duration.observeMs({ method, route }, durationMs);

    const reason = failure ?? (status >= 500 ? SERVER_ERROR_REASON : null);
    if (reason !== null) failures.inc({ reason });

    const sample = { at: this.now(), method, route, status, durationMs, ok: reason === null, failure };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    return { recorded: true, ok: sample.ok, reason };
  }

  /** How many observations the ring currently holds. */
  get sampleCount() {
    return this.samples.length;
  }

  /**
   * The observations inside the window `(now - windowMs, now]`, oldest first.
   * @param {{windowMs: number, now?: number}} options
   */
  windowSamples({ windowMs, now = this.now() }) {
    const floor = now - windowMs;
    return this.samples.filter((sample) => sample.at > floor && sample.at <= now);
  }

  /** The Prometheus text exposition of every registered family. */
  render() {
    const lines = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${escapeHelpText(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const series of metric.all()) {
        const suffix = metric.labelSuffix(series);
        if (metric.type === "histogram") {
          series.counts.forEach((count, index) => {
            lines.push(`${metric.name}_bucket${labelWithLe(metric, series, formatNumber(metric.buckets[index]))} ${count}`);
          });
          lines.push(`${metric.name}_bucket${labelWithLe(metric, series, "+Inf")} ${series.count}`);
          lines.push(`${metric.name}_sum${suffix} ${formatNumber(series.sum)}`);
          lines.push(`${metric.name}_count${suffix} ${formatNumber(series.count)}`);
        } else {
          lines.push(`${metric.name}${suffix} ${formatNumber(series.value)}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }

  /**
   * A plain-object view of the same state, shaped for the OTLP mapper.
   * @param {{at?: number}} [options]
   */
  snapshot({ at = this.now() } = {}) {
    const metrics = [];
    for (const metric of this.metrics.values()) {
      const series = metric.all().map((entry) =>
        metric.type === "histogram"
          ? {
              labels: { ...entry.labels },
              count: entry.count,
              sum: entry.sum,
              buckets: [
                ...metric.buckets.map((le, index) => ({ le, count: entry.counts[index] })),
                { le: Number.POSITIVE_INFINITY, count: entry.count },
              ],
            }
          : { labels: { ...entry.labels }, value: entry.value },
      );
      metrics.push({ name: metric.name, type: metric.type, help: metric.help, series });
    }
    return { generatedAt: at, metrics };
  }
}

/** `{a="1",le="0.5"}` — the histogram's label suffix with the bucket bound appended. */
function labelWithLe(metric, series, le) {
  if (metric.labelNames.length === 0) return `{le="${le}"}`;
  const pairs = metric.labelNames.map((label) => `${label}="${escapeLabelValue(series.labels[label])}"`);
  pairs.push(`le="${le}"`);
  return `{${pairs.join(",")}}`;
}
