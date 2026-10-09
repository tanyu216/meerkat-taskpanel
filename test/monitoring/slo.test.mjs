/**
 * Tests for `monitoring/lib/slo.mjs` — the health/alarm thresholds (availability
 * 99.9%, 5xx error rate <= 0.1%, p95 latency) and the math behind them.
 *
 * Pure functions over an array of observations: no I/O, nothing mocked. The p95 comes
 * from `histogramQuantile`, which is the same interpolation Prometheus' own
 * `histogram_quantile()` performs over the very same bucket layout, so the local
 * `/health` verdict and the alerting rule cannot drift apart.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { MonitoringError } from "../../monitoring/lib/errors.mjs";
import {
  SLO_TARGETS,
  SLO_WINDOW_TEXT,
  formatRatio,
  formatSeconds,
  histogramQuantile,
  httpStatusFor,
  summarize,
  toHealth,
} from "../../monitoring/lib/slo.mjs";

const OK = { at: 0, method: "GET", route: "/api/tasks", status: 200, durationMs: 5, ok: true, failure: null };

/** A clean observation, optionally degraded. */
function sample({ status = 200, durationMs = 5, failure = null } = {}) {
  return { ...OK, status, durationMs, failure, ok: failure === null && status < 500 };
}

const many = (count, overrides = {}) => Array.from({ length: count }, () => sample(overrides));

describe("slo — histogramQuantile", () => {
  it("returns null for an empty histogram", () => {
    assert.equal(histogramQuantile(0.95, []), null);
    assert.equal(histogramQuantile(0.95, [{ le: 1, count: 0 }, { le: Number.POSITIVE_INFINITY, count: 0 }]), null);
  });

  it("interpolates linearly inside the bucket that holds the quantile", () => {
    const buckets = [
      { le: 0.1, count: 50 },
      { le: 0.2, count: 100 },
      { le: Number.POSITIVE_INFINITY, count: 100 },
    ];
    // 0.95 * 100 = 95 → inside (0.1, 0.2], with 50 below: 0.1 + 0.1 * 45/50.
    assert.equal(histogramQuantile(0.95, buckets), 0.1 + 0.1 * (45 / 50));
  });

  it("interpolates from zero for the first bucket", () => {
    const buckets = [
      { le: 0.01, count: 10 },
      { le: Number.POSITIVE_INFINITY, count: 10 },
    ];
    // 0.95 * 10 = 9.5, all in the first bucket: 0 + 0.01 * 9.5/10.
    assert.equal(histogramQuantile(0.95, buckets), 0.0095);
  });

  it("falls back to the highest finite bound when the quantile sits in +Inf", () => {
    const buckets = [
      { le: 0.1, count: 1 },
      { le: Number.POSITIVE_INFINITY, count: 10 },
    ];
    assert.equal(histogramQuantile(0.95, buckets), 0.1);
    assert.equal(histogramQuantile(0.5, [{ le: Number.POSITIVE_INFINITY, count: 3 }]), Number.POSITIVE_INFINITY);
  });

  it("rejects a quantile outside [0, 1]", () => {
    assert.throws(
      () => histogramQuantile(1.5, [{ le: 1, count: 1 }]),
      (error) => error instanceof MonitoringError && error.code === "INVALID_ARGUMENT",
    );
  });
});

describe("slo — summarize", () => {
  it("reports insufficient_data (and nothing breached) below the sample floor", () => {
    const summary = summarize(many(3));
    assert.equal(summary.status, "insufficient_data");
    assert.equal(summary.evaluated, false);
    assert.deepEqual(summary.breached, []);
    assert.equal(httpStatusFor(summary.status), 200);
  });

  it("reports ok when every threshold holds", () => {
    const summary = summarize(many(2000, { durationMs: 5 }));
    assert.equal(summary.status, "ok");
    assert.deepEqual(summary.breached, []);
    assert.equal(summary.metrics.availability, 1);
    assert.equal(summary.metrics.errorRatio5xx, 0);
    assert.equal(summary.checks.availability.target, 0.999);
    assert.equal(summary.checks.errorRate5xx.target, 0.001);
    assert.ok(Math.abs(summary.metrics.p95LatencyMs - 4.75) < 1e-9, `p95 was ${summary.metrics.p95LatencyMs}`);
    assert.equal(httpStatusFor(summary.status), 200);
  });

  it("breaches availability on transport failures that are not 5xx", () => {
    const samples = [...many(995), ...Array.from({ length: 5 }, () => sample({ failure: "timeout" }))];
    const summary = summarize(samples);
    assert.equal(summary.counts.serverErrors, 0);
    assert.equal(summary.counts.failures, 5);
    assert.equal(summary.metrics.errorRatio5xx, 0);
    assert.deepEqual(summary.breached, ["availability"]);
    assert.equal(summary.status, "degraded");
    assert.equal(httpStatusFor(summary.status), 503);
  });

  it("breaches both the availability and the 5xx budget on server errors", () => {
    const samples = [...many(998), sample({ status: 500 }), sample({ status: 503 })];
    const summary = summarize(samples);
    assert.deepEqual(summary.breached, ["availability", "errorRate5xx"]);
    assert.equal(summary.counts.serverErrors, 2);
    assert.ok(Math.abs(summary.metrics.errorRatio5xx - 0.002) < 1e-12);
  });

  it("breaches the p95 budget when latency sits above the target", () => {
    const summary = summarize(many(30, { durationMs: 800 }));
    assert.deepEqual(summary.breached, ["p95LatencyMs"]);
    assert.ok(Math.abs(summary.metrics.p95LatencyMs - 975) < 1e-9, `p95 was ${summary.metrics.p95LatencyMs}`);
    assert.equal(summary.status, "degraded");
  });

  it("lets insufficient_data win over a breach it cannot vouch for", () => {
    const summary = summarize(many(3, { status: 500 }));
    assert.equal(summary.status, "insufficient_data");
    assert.deepEqual(summary.breached, ["availability", "errorRate5xx"]);
    assert.equal(httpStatusFor(summary.status), 200);
  });

  it("treats an empty window as insufficient data with a null p95", () => {
    const summary = summarize([]);
    assert.equal(summary.status, "insufficient_data");
    assert.equal(summary.metrics.availability, 1);
    assert.equal(summary.metrics.p95LatencyMs, null);
    assert.equal(summary.checks.p95LatencyMs.ok, true);
  });

  it("echoes the pinned targets and the window text the rules must share", () => {
    assert.deepEqual(SLO_TARGETS, {
      availabilityRatio: 0.999,
      errorRatio5xx: 0.001,
      p95LatencyMs: 300,
      windowMs: 300_000,
      minSamples: 20,
    });
    assert.equal(SLO_WINDOW_TEXT, "5m");
    assert.equal(formatRatio(0.001), "0.001");
    assert.equal(formatRatio(0.999), "0.999");
    assert.equal(formatSeconds(300), "0.3");
  });
});

describe("slo — toHealth", () => {
  it("projects a summary into the /health document", () => {
    const summary = summarize(many(30, { durationMs: 800 }));
    const health = toHealth(summary, {
      version: "1.0.0",
      uptimeSeconds: 12.5,
      windowMs: 300_000,
      otel: { enabled: false, endpoint: null, lastOk: null, lastError: null },
    });

    assert.equal(health.status, "degraded");
    assert.equal(health.version, "1.0.0");
    assert.equal(health.uptimeSeconds, 12.5);
    assert.deepEqual(health.window, { seconds: 300, samples: 30, minSamples: 20, sloWindowText: "5m" });
    assert.deepEqual(health.thresholds, { availabilityRatio: 0.999, errorRatio5xx: 0.001, p95LatencyMs: 300 });
    assert.deepEqual(health.breached, ["p95LatencyMs"]);
    assert.equal(health.checks.p95LatencyMs.target, 300);
    assert.equal(health.otel.enabled, false);
  });

  it("rejects an unknown status", () => {
    assert.throws(
      () => httpStatusFor("exploded"),
      (error) => error instanceof MonitoringError && error.code === "INVALID_ARGUMENT",
    );
  });
});
