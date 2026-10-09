/**
 * The observability sidecar — the runnable half of `monitoring/`.
 *
 *   node monitoring/exporter.mjs            # zero dependencies, no network, no config
 *
 * It serves three routes on one loopback port:
 *
 *   GET  /metrics       the Prometheus text exposition (scraped by prometheus.yml)
 *   GET  /health        the SLO verdict: 200 while it holds, 503 once a budget is blown
 *   POST /v1/observe    the push ingest: one observation, or `{observations: [...]}`
 *
 * and, when `MONITORING_OTLP_ENDPOINT` (or the OTel variables below) is set, periodically
 * pushes the same snapshot to an OTLP/HTTP collector.
 *
 * Why a sidecar rather than instrumenting the board itself: the card forbids changing
 * `src/server` semantics, and this keeps the whole stack observable without a single new
 * runtime dependency. Nothing here reaches the network unless an OTLP endpoint is
 * configured, and the process serves /metrics and /health with no configuration at all —
 * which is what makes the acceptance check runnable offline.
 *
 * The process never crashes on bad input: `/v1/observe` answers with a coded JSON error and
 * keeps serving. /health is the only route allowed to answer non-2xx, and only for a
 * genuine SLO breach.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { VERSION } from "../src/shared/constants.mjs";
import { MonitoringError, isMonitoringError } from "./lib/errors.mjs";
import { exportMetrics, resolveOtlpEndpoint, withMetricsPath } from "./lib/otlp.mjs";
import { Registry, validateObservation } from "./lib/registry.mjs";
import { SLO_TARGETS, httpStatusFor, summarize, toHealth } from "./lib/slo.mjs";

/** Loopback by default: the sidecar is a local component, not a public one. */
export const DEFAULT_HOST = "127.0.0.1";
/** The port `prometheus.yml` scrapes and compose publishes. */
export const DEFAULT_PORT = 9105;
/** How often a configured OTLP endpoint is pushed to. */
export const DEFAULT_OTLP_INTERVAL_MS = 15_000;
/** How long one OTLP export may take before it is abandoned. */
export const DEFAULT_OTLP_TIMEOUT_MS = 3_000;
/** The largest /v1/observe body accepted, in bytes. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** `/metrics` carries the exposition format's content type, version included. */
const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const INTEGER_PATTERN = /^-?\d+$/u;

/** Read an integer environment variable, failing closed on anything that is not one. */
function envInteger(env, name, { fallback, min, max }) {
  const raw = env?.[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!INTEGER_PATTERN.test(text)) {
    throw new MonitoringError("INVALID_ARGUMENT", { details: { variable: name, value: text, reason: "must be an integer" } });
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MonitoringError("INVALID_ARGUMENT", { details: { variable: name, value: text, reason: `must be between ${min} and ${max}` } });
  }
  return value;
}

/**
 * The configuration, from the environment.
 *
 * `MONITORING_OTLP_ENDPOINT` wins over the OTel-standard variables so an operator can
 * point this sidecar somewhere else without disturbing anything else in the process that
 * honours `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function parseConfig(env = {}) {
  const configured = env.MONITORING_OTLP_ENDPOINT;
  return {
    host: env.MONITORING_HOST ?? DEFAULT_HOST,
    port: envInteger(env, "MONITORING_PORT", { fallback: DEFAULT_PORT, min: 1, max: 65_535 }),
    serviceName: env.MONITORING_SERVICE_NAME ?? "meerkat-taskpanel",
    windowMs: envInteger(env, "MONITORING_SLO_WINDOW_MS", { fallback: SLO_TARGETS.windowMs, min: 1, max: 86_400_000 }),
    p95LatencyMs: envInteger(env, "MONITORING_SLO_P95_LATENCY_MS", { fallback: SLO_TARGETS.p95LatencyMs, min: 1, max: 3_600_000 }),
    otlpEndpoint: configured ? withMetricsPath(configured) : resolveOtlpEndpoint(env),
    otlpIntervalMs: envInteger(env, "MONITORING_OTLP_INTERVAL_MS", { fallback: DEFAULT_OTLP_INTERVAL_MS, min: 1, max: 3_600_000 }),
    otlpTimeoutMs: envInteger(env, "MONITORING_OTLP_TIMEOUT_MS", { fallback: DEFAULT_OTLP_TIMEOUT_MS, min: 1, max: 600_000 }),
    maxBodyBytes: envInteger(env, "MONITORING_MAX_BODY_BYTES", { fallback: DEFAULT_MAX_BODY_BYTES, min: 1, max: 1_073_741_824 }),
  };
}

/** The thresholds `/health` and the OTLP export are judged by: the pinned ones, windows overridden. */
function targetsFrom(config) {
  return Object.freeze({ ...SLO_TARGETS, windowMs: config.windowMs, p95LatencyMs: config.p95LatencyMs });
}

/** Where the exporter's own configuration comes from, with the caller's options on top. */
function normalizeOptions(options = {}) {
  const config = { ...parseConfig({}), ...options };
  return {
    ...config,
    otlpEndpoint: config.otlpEndpoint === null || config.otlpEndpoint === undefined ? null : withMetricsPath(config.otlpEndpoint),
    version: config.version ?? VERSION,
    now: config.now ?? (() => Date.now()),
  };
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": JSON_CONTENT_TYPE, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Write a coded JSON error — the shape every failure on this surface takes. */
function sendError(res, status, code, details = undefined) {
  sendJson(res, status, details === undefined ? { error: code } : { error: code, details });
}

/**
 * Build the exporter without binding a port (the seam the tests and embedders use).
 *
 * @param {object} [options] see `parseConfig`; plus `version`, `now`
 * @returns {{handler: import("node:http").RequestListener, registry: Registry, otel: object,
 *   config: object, targets: object, pushOnce: () => Promise<object>}}
 */
export function createExporter(options = {}) {
  const config = normalizeOptions(options);
  const targets = targetsFrom(config);
  const startedAt = config.now();

  const registry = new Registry({ now: config.now });
  registry.registerGauge("meerkat_taskpanel_up", "1 while the monitoring exporter is serving.").set({}, 1);
  const scrapes = registry.registerCounter("meerkat_taskpanel_exporter_scrapes_total", "Prometheus scrapes of /metrics.");
  registry.registerGauge("meerkat_taskpanel_exporter_info", "Build information for the monitoring exporter.", ["version"]).set({ version: config.version }, 1);

  /** The OTLP push state, as `/health` reports it. */
  const otel = {
    enabled: config.otlpEndpoint !== null,
    endpoint: config.otlpEndpoint,
    lastOk: null,
    lastError: null,
    pushes: 0,
    lastPushAt: null,
  };

  /**
   * Push one snapshot. Never throws — an observability outage must not become a
   * meerkat-taskpanel outage — and never blocks a scrape: the result is recorded and returned.
   */
  async function pushOnce() {
    const snapshot = registry.snapshot({ at: config.now() });
    const result = await exportMetrics(snapshot, {
      endpoint: config.otlpEndpoint,
      timeoutMs: config.otlpTimeoutMs,
      serviceName: config.serviceName,
      serviceVersion: config.version,
    });
    otel.pushes += 1;
    otel.lastPushAt = config.now();
    otel.lastOk = result.ok === true;
    otel.lastError = result.ok ? null : result.error;
    return result;
  }

  /** GET /metrics — increment first, so the counter includes the scrape being served. */
  function serveMetrics(res) {
    scrapes.inc({}, 1);
    const body = registry.render();
    res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE, "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  /** GET /health — the window verdict, with the thresholds that produced it. */
  function serveHealth(res) {
    const now = config.now();
    const samples = registry.windowSamples({ windowMs: config.windowMs, now });
    const summary = summarize(samples, { targets });
    const body = toHealth(summary, {
      version: config.version,
      uptimeSeconds: Math.max(0, (now - startedAt) / 1000),
      windowMs: config.windowMs,
      targets,
      otel: { ...otel },
    });
    sendJson(res, httpStatusFor(summary.status), body);
  }

  /** Read a request body, refusing anything past the limit. */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let oversized = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          oversized = true;
          return; // drained, not buffered
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (oversized) reject(new MonitoringError("PAYLOAD_TOO_LARGE", { details: { maxBodyBytes: config.maxBodyBytes } }));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }

  /** The observations a request body carries: an array, a batch object, or one observation. */
  function observationsOf(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed === null || typeof parsed !== "object") {
      throw new MonitoringError("INVALID_OBSERVATION", { details: { reason: "the body must be an observation or {observations: [...]}" } });
    }
    if (Object.hasOwn(parsed, "observations")) {
      if (!Array.isArray(parsed.observations) || parsed.observations.length === 0) {
        throw new MonitoringError("INVALID_OBSERVATION", { details: { reason: "missing_observations" } });
      }
      return parsed.observations;
    }
    // A bare observation: `{"method": ..., "route": ..., "status": ..., "durationMs": ...}`.
    if ("method" in parsed || "route" in parsed || "status" in parsed) return [parsed];
    throw new MonitoringError("INVALID_OBSERVATION", { details: { reason: "missing_observations" } });
  }

  /** POST /v1/observe. */
  async function handleObserve(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (isMonitoringError(error) && error.code === "PAYLOAD_TOO_LARGE") {
        sendError(res, 413, "PAYLOAD_TOO_LARGE", error.details);
        return;
      }
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(res, 400, "INVALID_OBSERVATION", { reason: "the body is not valid JSON" });
      return;
    }

    let observations;
    try {
      observations = observationsOf(parsed);
    } catch (error) {
      sendError(res, 400, "INVALID_OBSERVATION", error.details);
      return;
    }

    // Validate the whole batch before recording any of it: a batch that fails on item 3
    // must not leave items 1 and 2 counted.
    for (const [index, observation] of observations.entries()) {
      try {
        validateObservation(observation);
      } catch (error) {
        sendError(res, 400, "INVALID_OBSERVATION", { ...error.details, index });
        return;
      }
    }
    for (const observation of observations) registry.observeHttpRequest(observation);

    sendJson(res, 202, { accepted: observations.length, rejected: 0 });
  }

  /** The router. */
  const handler = (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/u, "") || "/";
    try {
      if (path === "/metrics") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "METHOD_NOT_ALLOWED");
        return serveMetrics(res);
      }
      if (path === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "METHOD_NOT_ALLOWED");
        return serveHealth(res);
      }
      if (path === "/v1/observe") {
        if (req.method !== "POST") return sendError(res, 405, "METHOD_NOT_ALLOWED");
        handleObserve(req, res).catch((error) => {
          sendError(res, 500, isMonitoringError(error) ? error.code : "INTERNAL_ERROR", { reason: String(error?.message ?? error) });
        });
        return undefined;
      }
      return sendError(res, 404, "NOT_FOUND");
    } catch (error) {
      return sendError(res, 500, isMonitoringError(error) ? error.code : "INTERNAL_ERROR", { reason: String(error?.message ?? error) });
    }
  };

  return { handler, registry, otel, config, targets, pushOnce };
}

/**
 * Bind the exporter to a port and start the OTLP push loop when one is configured.
 *
 * @param {object} [options] see `parseConfig`
 * @returns {Promise<{server: import("node:http").Server, url: string, host: string,
 *   port: number, registry: Registry, config: object, otel: object,
 *   close: () => Promise<void>}>}
 */
export async function startExporter(options = {}) {
  const built = createExporter(options);
  const { host, port } = built.config;

  const server = createServer(built.handler);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const timer =
    built.config.otlpEndpoint === null
      ? null
      : setInterval(() => {
          // Fire and forget: the loop must not stack up behind a slow receiver.
          built.pushOnce().catch(() => {});
        }, built.config.otlpIntervalMs);
  timer?.unref();

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  async function close() {
    if (timer !== null) clearInterval(timer);
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    // Without this an idle keep-alive connection keeps `close` pending until its timeout.
    server.closeAllConnections();
    await closed;
  }

  return {
    server,
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    registry: built.registry,
    config: built.config,
    otel: built.otel,
    pushOnce: built.pushOnce,
    close,
  };
}

/** Run as a script: start, say where, and shut down cleanly on a signal. */
async function main() {
  const config = parseConfig(process.env);
  const exporter = await startExporter(config);
  process.stdout.write(`meerkat-taskpanel monitoring exporter listening on ${exporter.url}\n`);
  process.stdout.write(`  GET ${exporter.url}/metrics\n  GET ${exporter.url}/health\n  POST ${exporter.url}/v1/observe\n`);
  process.stdout.write(
    config.otlpEndpoint === null
      ? "OTLP export: disabled (set MONITORING_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT to enable)\n"
      : `OTLP export: ${config.otlpEndpoint} every ${config.otlpIntervalMs} ms\n`,
  );

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal} received — draining the listener\n`);
    await exporter.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void shutdown(signal));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${isMonitoringError(error) ? error.code : "ERROR"}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
