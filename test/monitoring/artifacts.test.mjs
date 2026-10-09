/**
 * Static + structural tests for the declarative observability artefacts: the compose
 * overlay, the Prometheus config and rules, the collector config and the runbook.
 *
 * The YAML files are parsed with `monitoring/lib/yaml.mjs` and asserted structurally
 * (not by regex), so a broken nesting fails here. `docker compose config` is run too —
 * but only when the compose CLI is actually available: CI's container job has no docker
 * socket, and a skipped check is honest where a faked one would not be.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { parseYaml } from "../../monitoring/lib/yaml.mjs";
import { parseRules, validateRules } from "../../monitoring/lib/rules.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ARTEFACTS = Object.freeze({
  compose: "docker/docker-compose.observability.yml",
  prometheus: "monitoring/prometheus/prometheus.yml",
  rules: "monitoring/prometheus/meerkat-taskpanel.rules.yml",
  collector: "monitoring/otel/collector.yml",
  docs: "docs/observability.md",
  readme: "monitoring/README.md",
});

const read = (relative) => readFile(join(ROOT, relative), "utf8");
const yaml = async (relative) => parseYaml(await read(relative));

/** Every `.mjs` under `monitoring/`, relative to the repo root. */
function monitoringModules(dir = join(ROOT, "monitoring")) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...monitoringModules(path));
    else if (entry.name.endsWith(".mjs")) found.push(path);
  }
  return found;
}

describe("observability artifacts — files and structure", () => {
  it("ships every artefact", () => {
    for (const relative of Object.values(ARTEFACTS)) {
      assert.ok(existsSync(join(ROOT, relative)), `${relative} must exist`);
    }
  });

  it("parses the rules file and passes rule validation", async () => {
    const report = validateRules(parseRules(await read(ARTEFACTS.rules)));
    assert.deepEqual(report.problems, []);
  });

  it("parses each YAML artefact without a refusal", async () => {
    for (const relative of [ARTEFACTS.compose, ARTEFACTS.prometheus, ARTEFACTS.rules, ARTEFACTS.collector]) {
      const doc = await yaml(relative);
      assert.ok(doc !== null && typeof doc === "object", `${relative} must parse to a mapping`);
    }
  });

  it("passes `docker compose config` when the compose CLI is available", (t) => {
    const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      t.skip("docker compose CLI is not available here");
      return;
    }
    const result = spawnSync("docker", ["compose", "-f", ARTEFACTS.compose, "config", "--quiet"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

describe("observability artifacts — compose overlay", () => {
  it("adds the three services on pinned images, with no Dockerfile of its own", async () => {
    const compose = await yaml(ARTEFACTS.compose);
    assert.deepEqual(Object.keys(compose.services).sort(), ["monitoring", "otel-collector", "prometheus"]);
    assert.equal(compose.version, undefined, "compose v2 must not carry a top-level `version:` key");

    for (const [name, service] of Object.entries(compose.services)) {
      if (service.image !== undefined) {
        assert.doesNotMatch(service.image, /:latest$/, `${name} must pin its image tag`);
        assert.match(service.image, /:[^/]+$/u, `${name} must pin a tag`);
      }
      if (service.build !== undefined) {
        assert.equal(service.build.dockerfile, "docker/Dockerfile", `${name} must reuse the existing Dockerfile`);
        assert.equal(service.build.context, "..");
      }
    }
  });

  it("runs the sidecar from the repository image and wires the rules into Prometheus", async () => {
    const compose = await yaml(ARTEFACTS.compose);

    const monitoring = compose.services.monitoring;
    assert.equal(monitoring.image, "meerkat-taskpanel:local");
    assert.ok(monitoring.command.includes("monitoring/exporter.mjs"));
    assert.ok(monitoring.ports.some((mapping) => mapping.endsWith(":9105")));
    assert.match(monitoring.healthcheck.test.join(" "), /\/health/);

    const prometheus = compose.services.prometheus;
    assert.match(prometheus.image, /^prom\/prometheus:v\d+\.\d+\.\d+$/);
    assert.ok(prometheus.ports.some((mapping) => mapping.endsWith(":9090")));
    assert.ok(
      prometheus.volumes.some((volume) => volume.includes("../monitoring/prometheus/meerkat-taskpanel.rules.yml:") && volume.endsWith(":ro")),
      "the rules file must be mounted read-only",
    );
    assert.ok(
      prometheus.volumes.some((volume) => volume.includes("../monitoring/prometheus/prometheus.yml:") && volume.endsWith(":ro")),
      "the scrape config must be mounted read-only",
    );

    const collector = compose.services["otel-collector"];
    assert.match(collector.image, /^otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+$/);
    assert.ok(collector.volumes.some((volume) => volume.includes("../monitoring/otel/collector.yml:") && volume.endsWith(":ro")));
    assert.deepEqual(collector.environment, { MONITORING_OTLP_ENDPOINT: "http://otel-collector:4318" });
  });
});

describe("observability artifacts — Prometheus and collector config", () => {
  it("loads the rules and scrapes the sidecar every 15s", async () => {
    const prometheus = await yaml(ARTEFACTS.prometheus);
    assert.ok(
      prometheus.rule_files.includes("/etc/prometheus/rules/meerkat-taskpanel.rules.yml"),
      "prometheus.yml must load the committed rules file",
    );

    const job = prometheus.scrape_configs.find((entry) => entry.job_name === "monitoring");
    assert.ok(job, "expected a `monitoring` scrape job");
    assert.equal(job.metrics_path, "/metrics");
    assert.deepEqual(job.static_configs, [{ targets: ["monitoring:9105"] }]);
    assert.equal(prometheus.global.scrape_interval, "15s");
  });

  it("receives OTLP/HTTP on 4318 and exposes it for scraping", async () => {
    const collector = await yaml(ARTEFACTS.collector);
    assert.equal(collector.receivers.otlp.protocols.http.endpoint, "0.0.0.0:4318");

    const pipeline = collector.service.pipelines.metrics;
    assert.deepEqual(pipeline.receivers, ["otlp"]);
    assert.deepEqual(pipeline.exporters, ["prometheus"]);
    assert.equal(collector.exporters.prometheus.endpoint, "0.0.0.0:8889");
    assert.ok(collector.processors.batch !== undefined, "a batch processor keeps the export volume sane");
  });
});

describe("observability artifacts — runbook and dependency policy", () => {
  it("documents startup, shutdown, the metrics and the thresholds", async () => {
    const docs = await read(ARTEFACTS.docs);
    assert.ok(docs.length > 1_500, "docs/observability.md looks too thin");
    for (const needle of [
      "monitoring/exporter.mjs",
      "/metrics",
      "/health",
      "/v1/observe",
      "99.9%",
      "0.1%",
      "p95",
      "MeerkatTaskPanelAvailabilityBelowSLO",
      "MeerkatTaskPanelErrorRate5xxAboveBudget",
      "MeerkatTaskPanelP95LatencyAboveBudget",
      "docker/docker-compose.observability.yml",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "MONITORING_PORT",
      "no network",
    ]) {
      assert.ok(docs.includes(needle), `docs/observability.md must mention ${needle}`);
    }
  });

  it("keeps every monitoring module on Node builtins and relative imports", () => {
    const modules = monitoringModules();
    assert.ok(modules.length >= 5, "expected the monitoring modules to be present");

    for (const file of modules) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/gu)) {
        const specifier = match[1];
        assert.ok(
          specifier.startsWith("node:") || specifier.startsWith("."),
          `${file} must only import Node builtins or relative modules, found ${specifier}`,
        );
      }
    }
  });

  it("adds no runtime dependency to the repository root", async () => {
    const pkg = JSON.parse(await read("package.json"));
    assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0);
  });
});
