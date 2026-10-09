#!/usr/bin/env node
/**
 * One-click containerized verification (`npm run verify:docker`).
 *
 * Runs entirely through Docker so nothing touches the host: no host Node, no host
 * install, no host ports left open. Three phases:
 *
 *   1. build the image from docker/Dockerfile
 *   2. run the full suite inside it (docker/verify-in-container.sh)
 *   3. smoke-test the compose deploy: bring `taskd` up, wait for its /health
 *      healthcheck to report `healthy`, then tear it down
 *
 * Teardown lives in a `finally` block: a failure in phase 3 must never leave a
 * container or volume behind.
 *
 * Every docker invocation passes an argument array to spawnSync — never a shell string.
 *
 * Prerequisite: a running Docker daemon. Image pulls happen on first build.
 */

import { spawnSync } from "node:child_process";

import {
  buildArgs,
  composeDownArgs,
  composeFile,
  composeUpArgs,
  healthInspectArgs,
  imageTag,
  runVerifyInContainerArgs,
} from "./lib/docker-plan.mjs";

const COMPOSE_SERVICE = "taskd";
// Overridable so the failure path can be exercised without a 60s wall-clock wait.
const HEALTH_TIMEOUT_MS = Number(process.env.MEERKAT_TASKPANEL_HEALTH_TIMEOUT_MS ?? 60_000);
const HEALTH_POLL_MS = 2_000;

/** @type {Array<{name: string, ok: boolean, detail: string, ms: number}>} */
const steps = [];

function run(command, args, opts = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });
}

function tail(text, lines = 12) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-lines).join("\n");
}

/**
 * Run one named phase, record its outcome, and return the spawn result.
 */
function phase(name, fn) {
  const startedAt = Date.now();
  process.stdout.write(`\n== ${name} ==\n`);
  const result = fn();
  const ms = Date.now() - startedAt;

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const ok = result.ok === true;
  steps.push({
    name,
    ok,
    detail: ok ? `${ms}ms` : tail(result.detail ?? result.stderr ?? "", 12),
    ms,
  });
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Phase 0 — is there a daemon at all?
// ---------------------------------------------------------------------------

const daemon = run("docker", ["version", "--format", "{{.Server.Version}}"]);

if (daemon.error || daemon.status !== 0) {
  process.stderr.write(
    "verify:docker — cannot reach the Docker daemon.\n" +
      `  command: docker version --format {{.Server.Version}}\n` +
      `  ${daemon.error?.message ?? tail(daemon.stderr, 4)}\n\n` +
      "Start Docker (or colima) and re-run. Nothing was changed.\n",
  );
  process.exit(1);
}

process.stdout.write(`verify:docker — docker server ${(daemon.stdout ?? "").trim()}\n`);

// Name of the container compose creates, discovered after `up` (it depends on the
// compose project name, which is derived from the directory).
let container = null;

try {
  phase(`docker build -t ${imageTag()}`, () => {
    const res = run("docker", buildArgs("."));
    return { ...res, ok: !res.error && res.status === 0, detail: res.error?.message ?? tail(res.stderr) };
  });

  if (!steps.at(-1).ok) {
    throw new Error("image build failed — skipping the remaining phases");
  }

  phase("docker run --rm (full in-container suite)", () => {
    const res = run("docker", runVerifyInContainerArgs());
    return { ...res, ok: !res.error && res.status === 0, detail: res.error?.message ?? tail(res.stderr) };
  });

  if (!steps.at(-1).ok) {
    throw new Error("in-container verification failed — skipping the compose smoke test");
  }

  // -------------------------------------------------------------------------
  // Compose smoke test
  // -------------------------------------------------------------------------

  phase(`docker compose up -d --build (${composeFile()})`, () => {
    const res = run("docker", composeUpArgs());
    return { ...res, ok: !res.error && res.status === 0, detail: res.error?.message ?? tail(res.stderr) };
  });

  if (steps.at(-1).ok) {
    const ps = run("docker", ["compose", "-f", composeFile(), "ps", "-q", COMPOSE_SERVICE]);
    container = (ps.stdout ?? "").trim().split("\n").filter(Boolean)[0] ?? null;

    phase(`healthcheck: ${COMPOSE_SERVICE} → healthy (≤ ${HEALTH_TIMEOUT_MS / 1000}s)`, () => {
      if (!container) {
        return { ok: false, status: 1, detail: `no container found for service "${COMPOSE_SERVICE}"` };
      }

      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      let status = "";

      while (Date.now() < deadline) {
        const res = run("docker", healthInspectArgs(container));
        status = (res.stdout ?? "").trim();

        if (status === "healthy") return { ok: true, status: 0, detail: `${container}: healthy` };
        if (status === "unhealthy") return { ok: false, status: 1, detail: `${container}: unhealthy` };
        if (res.error) return { ok: false, status: 1, detail: res.error.message };

        // Wait synchronously; this phase is not on the hot path.
        spawnSync("sleep", [String(HEALTH_POLL_MS / 1000)]);
      }

      const logs = run("docker", ["logs", "--tail", "20", container]);
      return {
        ok: false,
        status: 1,
        detail: `timed out after ${HEALTH_TIMEOUT_MS / 1000}s (last status: ${status || "<none>"})\n${tail(logs.stdout ?? logs.stderr, 10)}`,
      };
    });
  }
} catch (err) {
  steps.push({ name: "aborted", ok: false, detail: err.message, ms: 0 });
} finally {
  // Always tear down, even after a failure or an exception.
  if (container || steps.some((s) => s.name.startsWith("docker compose up"))) {
    phase(`${composeDownArgs().join(" ")}`, () => {
      const res = run("docker", composeDownArgs());
      return { ...res, ok: !res.error && res.status === 0, detail: res.error?.message ?? tail(res.stderr) };
    });
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

process.stdout.write("\n== SUMMARY ==\n");
for (const step of steps) {
  process.stdout.write(`${step.ok ? "PASS" : "FAIL"}  ${step.name}\n`);
  if (!step.ok) process.stdout.write(`      ${step.detail}\n`);
}

const failed = steps.filter((s) => !s.ok);
process.stdout.write(`\n${steps.length - failed.length}/${steps.length} passed\n`);

if (container) {
  process.stdout.write(`(container ${container} was removed by compose down -v)\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
