/**
 * Tests for `monitoring/lib/otlp.mjs` — the OpenTelemetry export wiring.
 *
 * `toOtlpPayload` is pure and asserted directly. The push is exercised against a real
 * loopback HTTP server (the OTLP receiver is *external* I/O, so it is stood up here
 * rather than mocked in-process): a 2xx, a rejection, a refused connection, a hang past
 * the timeout, and an unusable endpoint. No external network is ever touched.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { describe, it } from "node:test";

import {
  DEFAULT_SERVICE_NAME,
  SCOPE_NAME,
  exportMetrics,
  resolveOtlpEndpoint,
  toOtlpPayload,
  toUnixNanoString,
} from "../../monitoring/lib/otlp.mjs";
import { Registry } from "../../monitoring/lib/registry.mjs";

/** A registry carrying one gauge, one counter and one histogram. */
function snapshotFixture() {
  const registry = new Registry();
  registry.registerGauge("meerkat_taskpanel_up", "Up.").set({}, 1);
  registry.registerCounter("meerkat_taskpanel_builds_total", "Builds.", ["result"]).inc({ result: "ok" }, 3);
  registry
    .registerHistogram("meerkat_taskpanel_build_duration_seconds", "Build duration.", {
      labelNames: ["result"],
      buckets: [0.5, 1],
    })
    .observeMs({ result: "ok" }, 250);
  return registry.snapshot({ at: 1_000 });
}

/** Run `fn` against a loopback server; always closes it afterwards. */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A free loopback port that nothing is listening on. */
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("otlp — payload mapping", () => {
  it("formats millisecond timestamps as nanosecond strings", () => {
    assert.equal(toUnixNanoString(0), "0");
    assert.equal(toUnixNanoString(1), "1000000");
    assert.equal(toUnixNanoString(1_700_000_000_000), "1700000000000000000");
  });

  it("maps the snapshot onto resource / scope / metric data points", () => {
    const payload = toOtlpPayload(snapshotFixture(), {
      serviceName: "meerkat-taskpanel",
      serviceVersion: "1.0.0",
      startTimeUnixNano: "0",
      timeUnixNano: "1000000000",
    });

    assert.deepEqual(payload.resourceMetrics[0].resource.attributes, [
      { key: "service.name", value: { stringValue: "meerkat-taskpanel" } },
      { key: "service.version", value: { stringValue: "1.0.0" } },
    ]);

    const [scope] = payload.resourceMetrics[0].scopeMetrics;
    assert.equal(scope.scope.name, SCOPE_NAME);
    assert.deepEqual(
      scope.metrics.map((metric) => metric.name),
      ["meerkat_taskpanel_up", "meerkat_taskpanel_builds_total", "meerkat_taskpanel_build_duration_seconds"],
    );

    const [up, builds, duration] = scope.metrics;
    assert.equal(up.gauge.dataPoints[0].asInt, "1");
    assert.deepEqual(up.gauge.dataPoints[0].attributes, []);
    assert.equal(up.gauge.dataPoints[0].timeUnixNano, "1000000000");

    assert.equal(builds.sum.isMonotonic, true);
    assert.equal(builds.sum.aggregationTemporality, 2);
    assert.deepEqual(builds.sum.dataPoints[0].attributes, [{ key: "result", value: { stringValue: "ok" } }]);
    assert.equal(builds.sum.dataPoints[0].asInt, "3");

    const point = duration.histogram.dataPoints[0];
    assert.equal(duration.histogram.aggregationTemporality, 2);
    assert.deepEqual(point.explicitBounds, [0.5, 1]);
    assert.deepEqual(point.bucketCounts, [1, 0, 0]);
    assert.equal(point.count, 1);
    assert.equal(point.sum, 0.25);
    assert.deepEqual(point.attributes, [{ key: "result", value: { stringValue: "ok" } }]);

    assert.equal(JSON.parse(JSON.stringify(payload)).resourceMetrics.length, 1);
  });

  it("omits families that carry no series and defaults the service name", () => {
    const registry = new Registry();
    registry.registerGauge("meerkat_taskpanel_up", "Up.");
    const payload = toOtlpPayload(registry.snapshot({ at: 0 }), { serviceVersion: "1.0.0" });
    assert.equal(payload.resourceMetrics[0].scopeMetrics[0].metrics.length, 0);
    assert.equal(payload.resourceMetrics[0].resource.attributes[0].value.stringValue, DEFAULT_SERVICE_NAME);
  });
});

describe("otlp — endpoint resolution", () => {
  it("completes a generic base URL with /v1/metrics and takes a metrics-specific one verbatim", () => {
    assert.equal(resolveOtlpEndpoint({}), null);
    assert.equal(resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }), "http://127.0.0.1:4318/v1/metrics");
    assert.equal(resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" }), "http://127.0.0.1:4318/v1/metrics");
    assert.equal(
      resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/v1/metrics" }),
      "http://127.0.0.1:4318/v1/metrics",
    );
    // The signal-specific variable is the full URL for this signal: never suffixed.
    assert.equal(
      resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://b:4318/custom" }),
      "http://b:4318/custom",
    );
  });
});

describe("otlp — exportMetrics", () => {
  it("POSTs the JSON payload to /v1/metrics and reports success", async () => {
    const seen = [];
    const result = await withServer(
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          seen.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      },
      (base) => exportMetrics(snapshotFixture(), { endpoint: base, timeoutMs: 2_000 }),
    );

    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/v1/metrics");
    assert.match(seen[0].contentType, /application\/json/);
    const metrics = JSON.parse(seen[0].body).resourceMetrics[0].scopeMetrics[0].metrics;
    assert.deepEqual(
      metrics.map((metric) => metric.name),
      ["meerkat_taskpanel_up", "meerkat_taskpanel_builds_total", "meerkat_taskpanel_build_duration_seconds"],
    );
  });

  it("reports a rejection without throwing", async () => {
    const result = await withServer(
      (req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"bad request"}');
      },
      (base) => exportMetrics(snapshotFixture(), { endpoint: base }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "OTLP_REJECTED");
    assert.equal(result.status, 400);
  });

  it("reports a refused connection and an unusable endpoint without throwing", async () => {
    const port = await closedPort();
    const refused = await exportMetrics(snapshotFixture(), { endpoint: `http://127.0.0.1:${port}`, timeoutMs: 1_000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "OTLP_EXPORT_FAILED");
    assert.ok(typeof refused.error === "string" && refused.error.length > 0);

    const invalid = await exportMetrics(snapshotFixture(), { endpoint: "not-a-url" });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "OTLP_EXPORT_FAILED");
  });

  it("gives up after the timeout instead of hanging", async () => {
    const result = await withServer(
      () => {
        /* deliberate: never respond */
      },
      (base) => exportMetrics(snapshotFixture(), { endpoint: base, timeoutMs: 100 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "OTLP_EXPORT_FAILED");
    assert.match(result.error, /timed out|abort/i);
  });
});
