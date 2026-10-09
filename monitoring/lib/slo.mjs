/**
 * The health / alerting thresholds — the numbers `/health` judges a window by, and the
 * numbers the Prometheus rules must encode.
 *
 * `SLO_TARGETS` is the single source of truth. `monitoring/prometheus/meerkat-taskpanel.rules.yml`
 * is *not* allowed to restate them: `rules.mjs` parses the committed YAML and fails if the
 * expressions no longer carry these exact tokens, so the local verdict, the alert and the
 * docs cannot drift apart.
 *
 * The p95 is estimated with `histogramQuantile` — the same linear interpolation over the
 * same bucket layout `histogram_quantile()` performs server-side. That is deliberate: a
 * locally-computed exact percentile would disagree with the alert, and an alarm that
 * contradicts the healthcheck is worse than either alone. It is a bucket-resolution
 * estimate and is documented as one.
 *
 * Nothing here touches the clock, the network or the filesystem; the window is passed in.
 */

import { MonitoringError } from "./errors.mjs";
import { DEFAULT_DURATION_BUCKETS, formatNumber } from "./registry.mjs";

/** The pinned SLO targets. */
export const SLO_TARGETS = Object.freeze({
  /** Availability floor: 99.9% of observations must not be failures. */
  availabilityRatio: 0.999,
  /** 5xx budget: at most 0.1% of observations may be server errors. */
  errorRatio5xx: 0.001,
  /** p95 latency budget, in milliseconds. */
  p95LatencyMs: 300,
  /** The rolling window the verdict is computed over (matches the rules' `[5m]`). */
  windowMs: 300_000,
  /** Below this many observations in the window, the verdict is `insufficient_data`. */
  minSamples: 20,
});

/** The PromQL range selector the rules use; asserted to match `windowMs`. */
export const SLO_WINDOW_TEXT = "5m";

/** The three check names, in the order they are reported and alerted on. */
export const CHECK_NAMES = Object.freeze(["availability", "errorRate5xx", "p95LatencyMs"]);

/** A ratio as it must appear verbatim in a PromQL expression. */
export function formatRatio(value) {
  return formatNumber(value);
}

/** Latency in milliseconds as the seconds token a PromQL expression uses. */
export function formatSeconds(milliseconds) {
  return formatNumber(milliseconds / 1000);
}

/**
 * Estimate a quantile from cumulative histogram buckets.
 *
 * @param {number} q in [0, 1]
 * @param {{le: number, count: number}[]} buckets cumulative counts, ascending, the last
 *   one conventionally `+Inf` (or any finite top bound)
 * @returns {number|null} the upper bound in the buckets' unit, `null` for an empty
 *   histogram, and the highest finite bound when the quantile falls in the `+Inf` bucket
 */
export function histogramQuantile(q, buckets) {
  if (typeof q !== "number" || !Number.isFinite(q) || q < 0 || q > 1) {
    throw new MonitoringError("INVALID_ARGUMENT", { details: { q } });
  }
  if (!Array.isArray(buckets) || buckets.length === 0) return null;

  const total = buckets[buckets.length - 1].count;
  if (!(total > 0)) return null;

  const rank = q * total;
  let previousLe = null;
  let previousCount = 0;

  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) {
        return previousLe === null ? Number.POSITIVE_INFINITY : previousLe;
      }
      const lower = previousLe === null ? 0 : previousLe;
      const within = bucket.count - previousCount;
      if (within <= 0) return bucket.le;
      return lower + ((bucket.le - lower) * (rank - previousCount)) / within;
    }
    previousLe = bucket.le;
    previousCount = bucket.count;
  }

  return previousLe;
}

/** Cumulative buckets (with a final `+Inf`) over a list of durations in seconds. */
export function bucketize(durations, buckets = DEFAULT_DURATION_BUCKETS) {
  const counts = buckets.map(() => 0);
  for (const seconds of durations) {
    for (let index = 0; index < buckets.length; index += 1) {
      if (seconds <= buckets[index]) counts[index] += 1;
    }
  }
  return [...buckets.map((le, index) => ({ le, count: counts[index] })), { le: Number.POSITIVE_INFINITY, count: durations.length }];
}

/**
 * Judge a window of observations against `SLO_TARGETS`.
 *
 * An observation is a failure when the registry marked it one: a 5xx, or a transport-level
 * `failure` (timeout / aborted) that never produced a status. `errorRate5xx` counts the
 * 5xx subset only, which is why the two checks can disagree — and why both exist.
 *
 * `insufficient_data` never turns a container unhealthy, but `breached` is still reported
 * raw, so an operator sees the breaches in the same response that says "not enough data".
 *
 * @param {object[]} samples observations from `Registry#windowSamples`
 * @param {{targets?: typeof SLO_TARGETS, buckets?: number[]}} [options]
 */
export function summarize(samples, { targets = SLO_TARGETS, buckets = DEFAULT_DURATION_BUCKETS } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const total = list.length;
  const failures = list.filter((sample) => sample.ok === false).length;
  const serverErrors = list.filter((sample) => sample.status >= 500).length;

  const availability = total === 0 ? 1 : (total - failures) / total;
  const errorRatio5xx = total === 0 ? 0 : serverErrors / total;

  const quantile = histogramQuantile(0.95, bucketize(list.map((sample) => sample.durationMs / 1000), buckets));
  const p95LatencyMs = quantile === null || quantile === Number.POSITIVE_INFINITY ? quantile : quantile * 1000;

  const checks = {
    availability: { ok: availability >= targets.availabilityRatio, target: targets.availabilityRatio, observed: availability },
    errorRate5xx: { ok: errorRatio5xx <= targets.errorRatio5xx, target: targets.errorRatio5xx, observed: errorRatio5xx },
    p95LatencyMs: {
      ok: p95LatencyMs === null ? true : p95LatencyMs <= targets.p95LatencyMs,
      target: targets.p95LatencyMs,
      observed: p95LatencyMs,
    },
  };

  const breached = CHECK_NAMES.filter((name) => !checks[name].ok);
  const evaluated = total >= targets.minSamples;

  return {
    status: !evaluated ? "insufficient_data" : breached.length > 0 ? "degraded" : "ok",
    evaluated,
    counts: { samples: total, failures, serverErrors },
    metrics: { availability, errorRatio5xx, p95LatencyMs },
    checks,
    breached,
  };
}

/** The HTTP status a verdict maps to: only a breach makes the service unhealthy. */
export function httpStatusFor(status) {
  if (status === "ok" || status === "insufficient_data") return 200;
  if (status === "degraded") return 503;
  throw new MonitoringError("INVALID_ARGUMENT", { details: { status } });
}

/**
 * Project a summary into the `/health` document.
 * @param {ReturnType<typeof summarize>} summary
 * @param {{version?: string, uptimeSeconds?: number, windowMs?: number, otel?: object|null,
 *   targets?: typeof SLO_TARGETS}} [options]
 */
export function toHealth(summary, { version = "unknown", uptimeSeconds = 0, windowMs = SLO_TARGETS.windowMs, otel = null, targets = SLO_TARGETS } = {}) {
  return {
    status: summary.status,
    version,
    uptimeSeconds,
    evaluated: summary.evaluated,
    window: {
      seconds: windowMs / 1000,
      samples: summary.counts.samples,
      minSamples: targets.minSamples,
      sloWindowText: SLO_WINDOW_TEXT,
    },
    thresholds: {
      availabilityRatio: targets.availabilityRatio,
      errorRatio5xx: targets.errorRatio5xx,
      p95LatencyMs: targets.p95LatencyMs,
    },
    counts: summary.counts,
    checks: summary.checks,
    breached: summary.breached,
    otel,
  };
}
