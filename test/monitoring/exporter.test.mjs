/**
 * Tests for `monitoring/exporter.mjs` — the zero-dependency sidecar that serves
 * `/metrics` (Prometheus text), `/health` (the 99.9% / 0.1% / p95 verdict) and
 * `/v1/observe` (the push ingest), and optionally pushes OTLP.
 *
 * Every test here drives the real HTTP server over loopback with `fetch`; the only
 * injected seam is the clock, and the OTLP receiver is stood up as another loopback
 * server. Nothing reaches the network.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { describe, it } from "node:test";

import { MonitoringError } from "../../monitoring/lib/errors.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, createExporter, parseConfig, startExporter } from "../../monitoring/exporter.mjs";

const observation = { method: "GET", route: "/api/tasks", status: 200, durationMs: 12 };

/** Start an exporter on an ephemeral loopback port and always close it. */
async function withExporter(options, fn) {
  const exporter = await startExporter({ host: "127.0.0.1", port: 0, ...options });
  try {
    return await fn(exporter);
  } finally {
    await exporter.close();
  }
}

const getJson = async (url) => {
  const response = await fetch(url);
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.json() };
};

const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

/** Poll `predicate` until it is true or the budget runs out. */
async function waitFor(predicate, { timeoutMs = 3_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** A loopback server that records every request it receives. */
async function withReceiver(fn) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("exporter — /metrics", () => {
  it("serves the Prometheus text exposition, including its own series", async () => {
    await withExporter({}, async ({ url }) => {
      const response = await fetch(`${url}/metrics`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);

      const text = await response.text();
      assert.match(text, /^# TYPE task_panel_up gauge$/m);
      assert.match(text, /^task_panel_up 1$/m);
      assert.match(text, /^# TYPE task_panel_exporter_scrapes_total counter$/m);
      assert.match(text, /^task_panel_exporter_scrapes_total 1$/m);
      assert.match(text, /^task_panel_exporter_info\{version="[^"]+"\} 1$/m);

      await fetch(`${url}/metrics`);
      const second = await (await fetch(`${url}/metrics`)).text();
      assert.match(second, /^task_panel_exporter_scrapes_total 3$/m);
      assert.doesNotMatch(text, /^task_panel_http_requests_total/m, "no traffic yet means no HTTP families");
    });
  });
});

describe("exporter — /health", () => {
  it("reports insufficient_data before there is traffic, with the thresholds echoed", async () => {
    await withExporter({}, async ({ url }) => {
      const health = await getJson(`${url}/health`);
      assert.equal(health.status, 200);
      assert.match(health.contentType, /^application\/json/);
      assert.equal(health.body.status, "insufficient_data");
      assert.deepEqual(health.body.thresholds, { availabilityRatio: 0.999, errorRatio5xx: 0.001, p95LatencyMs: 300 });
      assert.equal(health.body.window.sloWindowText, "5m");
      assert.equal(health.body.window.minSamples, 20);
      assert.deepEqual(health.body.breached, []);
      assert.equal(health.body.otel.enabled, false);
      assert.equal(typeof health.body.version, "string");
      assert.equal(typeof health.body.uptimeSeconds, "number");
    });
  });

  it("turns 503 once a window of traffic breaches an SLO", async () => {
    await withExporter({}, async ({ url }) => {
      const observations = Array.from({ length: 30 }, () => observation);
      const accepted = await post(`${url}/v1/observe`, JSON.stringify({ observations }));
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), { accepted: 30, rejected: 0 });

      const healthy = await getJson(`${url}/health`);
      assert.equal(healthy.status, 200, JSON.stringify(healthy.body));
      assert.equal(healthy.body.status, "ok");
      assert.equal(healthy.body.window.samples, 30);

      const broken = await post(`${url}/v1/observe`, JSON.stringify({ observations: Array.from({ length: 30 }, () => ({ ...observation, status: 503 })) }));
      assert.equal(broken.status, 202);

      const health = await getJson(`${url}/health`);
      assert.equal(health.status, 503);
      assert.equal(health.body.status, "degraded");
      assert.deepEqual(health.body.breached, ["availability", "errorRate5xx"]);
      assert.equal(health.body.checks.availability.target, 0.999);
    });
  });
});

describe("exporter — /v1/observe and routing", () => {
  it("accepts a single observation or a batch, and exposes them on /metrics", async () => {
    await withExporter({}, async ({ url }) => {
      const single = await post(`${url}/v1/observe`, JSON.stringify(observation));
      assert.equal(single.status, 202);
      assert.deepEqual(await single.json(), { accepted: 1, rejected: 0 });

      const batch = await post(`${url}/v1/observe`, JSON.stringify({ observations: [observation, { ...observation, route: "/health" }] }));
      assert.equal(batch.status, 202);
      assert.deepEqual(await batch.json(), { accepted: 2, rejected: 0 });

      const text = await (await fetch(`${url}/metrics`)).text();
      assert.match(text, /^task_panel_http_requests_total\{method="GET",route="\/api\/tasks",status="200"\} 2$/m);
      assert.match(text, /^task_panel_http_requests_total\{method="GET",route="\/health",status="200"\} 1$/m);
    });
  });

  it("answers 404, 405 and 400 with coded JSON", async () => {
    await withExporter({ maxBodyBytes: 128 }, async ({ url }) => {
      const missing = await getJson(`${url}/`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "NOT_FOUND");

      const wrongMethod = await getJson(`${url}/v1/observe`);
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.body.error, "METHOD_NOT_ALLOWED");

      const notJson = await post(`${url}/v1/observe`, "definitely not json");
      assert.equal(notJson.status, 400);
      assert.deepEqual((await notJson.json()).error, "INVALID_OBSERVATION");

      const empty = await post(`${url}/v1/observe`, JSON.stringify({}));
      assert.equal(empty.status, 400);
      const emptyBody = await empty.json();
      assert.equal(emptyBody.error, "INVALID_OBSERVATION");
      assert.equal(emptyBody.details.reason, "missing_observations");

      const badItem = await post(`${url}/v1/observe`, JSON.stringify({ observations: [observation, { method: "GET" }] }));
      assert.equal(badItem.status, 400);
      const badBody = await badItem.json();
      assert.equal(badBody.details.index, 1);

      const oversized = await post(`${url}/v1/observe`, JSON.stringify({ observations: [observation], padding: "x".repeat(200) }));
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).error, "PAYLOAD_TOO_LARGE");
    });
  });
});

describe("exporter — OTLP push", () => {
  it("pushes a snapshot to the configured receiver and records the outcome", async () => {
    await withReceiver(async (base, received) => {
      await withExporter({ otlpEndpoint: base, otlpIntervalMs: 25 }, async ({ url }) => {
        assert.equal((await post(`${url}/v1/observe`, JSON.stringify(observation))).status, 202);

        const pushed = await waitFor(() => received.length > 0);
        assert.ok(pushed, "expected at least one OTLP push");
        assert.equal(received[0].url, "/v1/metrics");
        const metrics = JSON.parse(received[0].body).resourceMetrics[0].scopeMetrics[0].metrics;
        assert.ok(metrics.some((metric) => metric.name === "task_panel_http_requests_total"));

        const health = await getJson(`${url}/health`);
        assert.equal(health.body.otel.enabled, true);
        assert.equal(health.body.otel.endpoint, `${base}/v1/metrics`);
        assert.equal(health.body.otel.lastOk, true);
        assert.ok(health.body.otel.pushes >= 1);
      });
    });
  });

  it("stays healthy (and records the error) when the receiver refuses the push", async () => {
    await withExporter({ otlpEndpoint: "http://127.0.0.1:1/v1/metrics", otlpIntervalMs: 25 }, async ({ url }) => {
      const failed = await waitFor(async () => (await getJson(`${url}/health`)).body.otel.lastOk === false);
      assert.ok(failed, "expected the push to be attempted and to fail");

      const health = await getJson(`${url}/health`);
      assert.equal(health.status, 200, "an OTLP outage must not fail the healthcheck");
      assert.equal(typeof health.body.otel.lastError, "string");
      assert.equal(health.body.otel.lastError.length > 0, true);
    });
  });
});

describe("exporter — config and lifecycle", () => {
  it("defaults to loopback on the monitoring port and honours env overrides", () => {
    const defaults = parseConfig({});
    assert.equal(defaults.host, DEFAULT_HOST);
    assert.equal(defaults.port, DEFAULT_PORT);
    assert.equal(defaults.otlpEndpoint, null);
    assert.equal(defaults.windowMs, 300_000);
    assert.equal(defaults.p95LatencyMs, 300);

    const overridden = parseConfig({
      MONITORING_HOST: "0.0.0.0",
      MONITORING_PORT: "9199",
      MONITORING_SERVICE_NAME: "task-panel-ops",
      MONITORING_SLO_WINDOW_MS: "60000",
      MONITORING_SLO_P95_LATENCY_MS: "150",
      MONITORING_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://ignored:4318",
    });
    assert.equal(overridden.host, "0.0.0.0");
    assert.equal(overridden.port, 9199);
    assert.equal(overridden.serviceName, "task-panel-ops");
    assert.equal(overridden.windowMs, 60_000);
    assert.equal(overridden.p95LatencyMs, 150);
    assert.equal(overridden.otlpEndpoint, "http://collector:4318/v1/metrics");
  });

  it("rejects an unusable port or window", () => {
    for (const env of [{ MONITORING_PORT: "0" }, { MONITORING_PORT: "70000" }, { MONITORING_PORT: "abc" }, { MONITORING_SLO_WINDOW_MS: "-1" }]) {
      assert.throws(
        () => parseConfig(env),
        (error) => error instanceof MonitoringError && error.code === "INVALID_ARGUMENT",
        JSON.stringify(env),
      );
    }
  });

  it("closes the listener on close()", async () => {
    const exporter = await startExporter({ host: "127.0.0.1", port: 0 });
    const { url } = exporter;
    assert.equal((await fetch(`${url}/health`)).status, 200);
    await exporter.close();
    await assert.rejects(() => fetch(`${url}/health`));
  });

  it("exposes the handler without binding a port when built by createExporter", () => {
    const app = createExporter({});
    assert.equal(typeof app.handler, "function");
    assert.equal(typeof app.registry.render(), "string");
  });
});
