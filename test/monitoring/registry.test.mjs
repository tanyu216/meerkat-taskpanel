/**
 * Tests for `monitoring/lib/registry.mjs` — the in-process metrics model and the
 * Prometheus text exposition it renders.
 *
 * The module is pure (no I/O, no Node builtins, no dependencies), so nothing here is
 * mocked: the counter/gauge/histogram arithmetic, the exposition format and the
 * validation errors are exercised directly. The only injected seam is the clock, which
 * `Registry` takes as an option so the recent-sample window can be tested without
 * waiting.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { MonitoringError } from "../../monitoring/lib/errors.mjs";
import {
  DEFAULT_DURATION_BUCKETS,
  REQUEST_DURATION_SECONDS,
  REQUEST_FAILURES_TOTAL,
  REQUEST_TOTAL,
  Registry,
  escapeHelpText,
  escapeLabelValue,
  formatNumber,
} from "../../monitoring/lib/registry.mjs";

/** Run `fn`, assert it threw a `MonitoringError`, and return its `code`. */
function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MonitoringError, `expected a MonitoringError, got ${error}`);
    return error.code;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

describe("registry — Prometheus exposition", () => {
  it("renders a counter family with HELP, TYPE and one line per series", () => {
    const registry = new Registry();
    const requests = registry.registerCounter("demo_requests_total", "Demo requests.", ["method", "status"]);
    requests.inc({ method: "GET", status: 200 }, 2);
    requests.inc({ method: "POST", status: 500 });

    assert.equal(
      registry.render(),
      [
        "# HELP demo_requests_total Demo requests.",
        "# TYPE demo_requests_total counter",
        'demo_requests_total{method="GET",status="200"} 2',
        'demo_requests_total{method="POST",status="500"} 1',
        "",
      ].join("\n"),
    );
  });

  it("renders a label-less series without braces", () => {
    const registry = new Registry();
    registry.registerCounter("demo_events_total", "Events.").inc();
    assert.match(registry.render(), /^demo_events_total 1$/m);
  });

  it("renders a gauge and applies set / inc / dec", () => {
    const registry = new Registry();
    const up = registry.registerGauge("demo_up", "Up.");
    up.set({}, 1);
    up.inc({});
    up.dec({}, 2);
    assert.match(registry.render(), /^# TYPE demo_up gauge$/m);
    assert.match(registry.render(), /^demo_up 0$/m);
  });

  it("renders a histogram as cumulative buckets plus _sum and _count", () => {
    const registry = new Registry();
    const duration = registry.registerHistogram("demo_seconds", "Duration.", {
      labelNames: [],
      buckets: [0.1, 0.5, 1],
    });
    duration.observeMs({}, 50);
    duration.observeMs({}, 700);

    assert.equal(
      registry.render(),
      [
        "# HELP demo_seconds Duration.",
        "# TYPE demo_seconds histogram",
        'demo_seconds_bucket{le="0.1"} 1',
        'demo_seconds_bucket{le="0.5"} 1',
        'demo_seconds_bucket{le="1"} 2',
        'demo_seconds_bucket{le="+Inf"} 2',
        "demo_seconds_sum 0.75",
        "demo_seconds_count 2",
        "",
      ].join("\n"),
    );
  });

  it("sorts series lexicographically and is byte-stable across renders", () => {
    const registry = new Registry();
    const requests = registry.registerCounter("demo_requests_total", "Demo.", ["route"]);
    requests.inc({ route: "/z" });
    requests.inc({ route: "/a" });
    const first = registry.render();
    assert.ok(first.indexOf('route="/a"') < first.indexOf('route="/z"'), "series must be sorted");
    assert.equal(registry.render(), first, "rendering twice must be byte-identical");
  });

  it("escapes help text and label values per the exposition format", () => {
    assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
    assert.equal(escapeHelpText("line1\nline2\\end"), "line1\\nline2\\\\end");

    const registry = new Registry();
    const messages = registry.registerCounter("demo_msgs_total", "Messages.\nSecond line.", ["route"]);
    messages.inc({ route: 'a"b' });

    const text = registry.render();
    assert.match(text, /^# HELP demo_msgs_total Messages\.\\nSecond line\.$/m);
    assert.match(text, /^demo_msgs_total\{route="a\\"b"\} 1$/m);
  });

  it("formats numbers without float noise", () => {
    assert.equal(formatNumber(1), "1");
    assert.equal(formatNumber(0), "0");
    assert.equal(formatNumber(1.5), "1.5");
    assert.equal(formatNumber(0.1 + 0.2), "0.3");
    assert.equal(formatNumber(0.001), "0.001");
  });

  it("rejects names, labels and buckets it cannot expose correctly", () => {
    const registry = new Registry();
    assert.equal(codeOf(() => registry.registerCounter("bad-name", "x")), "INVALID_METRIC_NAME");
    assert.equal(codeOf(() => registry.registerCounter("demo", "x", ["1label"])), "INVALID_LABEL_NAME");
    registry.registerCounter("demo_dup_total", "x");
    assert.equal(codeOf(() => registry.registerCounter("demo_dup_total", "x")), "DUPLICATE_METRIC");
    assert.equal(codeOf(() => registry.registerGauge("demo_dup_total", "x")), "TYPE_CONFLICT");
    assert.equal(
      codeOf(() => registry.registerHistogram("demo_buckets_seconds", "x", { buckets: [0.5, 0.1] })),
      "INVALID_BUCKETS",
    );
    assert.equal(
      codeOf(() => registry.registerHistogram("demo_buckets_seconds", "x", { buckets: [] })),
      "INVALID_BUCKETS",
    );
  });

  it("rejects a label set that does not match the registration", () => {
    const registry = new Registry();
    const requests = registry.registerCounter("demo_requests_total", "x", ["route"]);
    assert.equal(codeOf(() => requests.inc({ route: "/a", extra: "x" })), "LABEL_SET_MISMATCH");
    assert.equal(codeOf(() => requests.inc({})), "LABEL_SET_MISMATCH");
    assert.equal(codeOf(() => requests.inc({ route: null })), "INVALID_LABEL_VALUE");
    assert.equal(codeOf(() => requests.inc({ route: "/a" }, -1)), "INVALID_ARGUMENT");
  });
});

describe("registry — HTTP observations", () => {
  const observation = { method: "GET", route: "/api/tasks", status: 200, durationMs: 12 };

  it("registers the standard families lazily and records counters + histogram", () => {
    const registry = new Registry();
    assert.equal(registry.has(REQUEST_TOTAL), false);

    registry.observeHttpRequest(observation);

    assert.equal(registry.has(REQUEST_TOTAL), true);
    assert.equal(registry.has(REQUEST_FAILURES_TOTAL), true);
    assert.equal(registry.has(REQUEST_DURATION_SECONDS), true);

    const text = registry.render();
    assert.match(text, /^task_panel_http_requests_total\{method="GET",route="\/api\/tasks",status="200"\} 1$/m);
    assert.match(
      text,
      /^task_panel_http_request_duration_seconds_bucket\{method="GET",route="\/api\/tasks",le="0\.025"\} 1$/m,
    );
    assert.match(
      text,
      /^task_panel_http_request_duration_seconds_bucket\{method="GET",route="\/api\/tasks",le="\+Inf"\} 1$/m,
    );
    assert.match(text, /^task_panel_http_request_duration_seconds_sum\{method="GET",route="\/api\/tasks"\} 0\.012$/m);
    assert.match(text, /^task_panel_http_request_duration_seconds_count\{method="GET",route="\/api\/tasks"\} 1$/m);
    assert.doesNotMatch(text, /^task_panel_http_failures_total/m, "a 2xx must not be counted as a failure");
  });

  it("counts a 5xx and a transport failure in failures_total with distinct reasons", () => {
    const registry = new Registry();
    registry.observeHttpRequest({ method: "GET", route: "/api/tasks", status: 503, durationMs: 8 });
    registry.observeHttpRequest({ method: "GET", route: "/api/tasks", status: 200, durationMs: 3, failure: "timeout" });

    const text = registry.render();
    assert.match(text, /^task_panel_http_failures_total\{reason="http_5xx"\} 1$/m);
    assert.match(text, /^task_panel_http_failures_total\{reason="timeout"\} 1$/m);
  });

  it("does not count a 4xx as an availability failure", () => {
    const registry = new Registry();
    registry.observeHttpRequest({ method: "GET", route: "/api/missing", status: 404, durationMs: 1 });
    registry.observeHttpRequest({ method: "POST", route: "/api/tasks", status: 422, durationMs: 2 });
    assert.doesNotMatch(registry.render(), /^task_panel_http_failures_total/m);
    assert.match(registry.render(), /^task_panel_http_requests_total\{/m);
  });

  it("rejects a malformed observation", () => {
    const registry = new Registry();
    const bad = [
      { method: "", route: "/a", status: 200, durationMs: 1 },
      { method: "GET", route: "no-slash", status: 200, durationMs: 1 },
      { method: "GET", route: "/a", status: 200.5, durationMs: 1 },
      { method: "GET", route: "/a", status: 99, durationMs: 1 },
      { method: "GET", route: "/a", status: 200, durationMs: -1 },
      { method: "GET", route: "/a", status: 200, durationMs: 1, failure: "Timeout" },
    ];
    for (const item of bad) {
      assert.equal(codeOf(() => registry.observeHttpRequest(item)), "INVALID_OBSERVATION", JSON.stringify(item));
    }
  });

  it("keeps a bounded recent-sample ring and filters samples by window", () => {
    let clock = 1_000;
    const registry = new Registry({ now: () => clock, maxSamples: 3 });
    for (const route of ["/a", "/b", "/c", "/d"]) {
      registry.observeHttpRequest({ method: "GET", route, status: 200, durationMs: 1 });
      clock += 1_000;
    }

    assert.equal(registry.sampleCount, 3, "the ring must drop the oldest sample");
    const recent = registry.windowSamples({ windowMs: 1_500, now: 4_000 });
    assert.deepEqual(
      recent.map((sample) => sample.route),
      ["/c", "/d"],
    );
    assert.equal(recent[0].ok, true);
    assert.equal(recent[0].durationMs, 1);
  });

  it("describes every family in snapshot() for the OTLP mapper", () => {
    const registry = new Registry();
    registry.registerGauge("task_panel_up", "Up.").set({}, 1);
    registry.observeHttpRequest(observation);

    const snapshot = registry.snapshot({ at: 123 });
    assert.equal(snapshot.generatedAt, 123);

    const up = snapshot.metrics.find((metric) => metric.name === "task_panel_up");
    assert.equal(up.type, "gauge");
    assert.equal(up.series[0].value, 1);

    const requests = snapshot.metrics.find((metric) => metric.name === REQUEST_TOTAL);
    assert.equal(requests.type, "counter");
    assert.deepEqual(requests.series[0].labels, { method: "GET", route: "/api/tasks", status: "200" });
    assert.equal(requests.series[0].value, 1);

    const duration = snapshot.metrics.find((metric) => metric.name === REQUEST_DURATION_SECONDS);
    assert.equal(duration.type, "histogram");
    assert.equal(duration.series[0].count, 1);
    assert.equal(duration.series[0].buckets.at(-1).le, Number.POSITIVE_INFINITY);
    assert.equal(duration.series[0].buckets.length, DEFAULT_DURATION_BUCKETS.length + 1);
  });
});
