/**
 * The board's SLA read: `GET /api/v1/sla` and `/meta.capabilities.sla`.
 *
 * The properties that matter:
 *
 *   * the **defaults** are the documented table when `.env` says nothing;
 *   * a `TASKD_SLA_*` override lands in the published config **and** in the
 *     alert's `threshold_min`;
 *   * the file is re-read per request, so a hand edit applies without a
 *     restart;
 *   * a bad value fails the SLA read closed while `/meta` reports it softly;
 *   * `?card=` answers one card only (the pre-emit re-read).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { loadEnvFile } from "../../src/foundation/env-config.mjs";
import { SLA_ENV_KEYS } from "../../src/foundation/constants.mjs";

const KEY = SLA_ENV_KEYS;
const tempDirs = [];
const servers = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-sla-"));
  tempDirs.push(dir);
  return dir;
}

function varsOf(envFile) {
  try {
    return loadEnvFile({ flag: envFile, env: {} }).vars;
  } catch {
    return new Map();
  }
}

async function start(options = {}) {
  const dataDir = options.dataDir ?? tempDir();
  const envFile = join(dataDir, ".env");
  const taskd = await createTaskd({
    host: "127.0.0.1",
    port: 0,
    env: {},
    dataDir,
    envFile,
    envVars: varsOf(envFile),
    ...options,
  });
  servers.push(taskd);
  return taskd;
}

after(async () => {
  for (const taskd of servers) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function call(taskd, method, path, body, extraHeaders = {}) {
  const response = await fetch(`${taskd.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => {
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
};

/** A card created directly in `blocked`, so `blocked_at` is the creation time. */
async function blockedCard(taskd, title = "Awaiting a decision") {
  // A second call in the same board is a conflict, not a failure.
  await call(taskd, "POST", "/api/v1/projects", { id: "sla", name: "SLA" });
  // A worker files the card: a human write now records the writer as reporter,
  // and that creation would be the board's newest leader event — putting the
  // stall inside its lead. `leader_stalled` needs a board with no leader act.
  const created = dataOf(
    await call(
      taskd,
      "POST",
      "/api/v1/tasks",
      {
        project_id: "sla",
        title,
        status: "blocked",
        blocked_reason: "clarify",
      },
      { "x-taskctl-actor": JSON.stringify({ kind: "claude", id: "tester" }) },
    ),
  );
  return created.task.identifier;
}

describe("GET /api/v1/sla — defaults", () => {
  it("publishes the documented table on an empty board", async () => {
    const taskd = await start();
    const data = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.deepEqual(data.alerts, []);
    assert.equal(data.board_truncated, false);
    assert.equal(data.trails_truncated, false);
    assert.equal(data.config.version, 1);
    assert.equal(data.config.period_seconds, 300);
    assert.equal(data.config.leader_lookback_days, 7);
    assert.equal(data.config.peer_period_min, 15);
    assert.equal(data.config.peer_liveness_k, 3);
    assert.equal(data.config.rows.blocked_clarification.limit_min, 120);
    assert.equal(data.config.rows.blocked_clarification.further_min, 1440);
    assert.deepEqual(data.warnings, []);
  });

  it("reports the same table on /meta", async () => {
    const taskd = await start();
    const meta = dataOf(await call(taskd, "GET", "/meta"));
    assert.equal(meta.capabilities.sla.version, 1);
    assert.equal(meta.capabilities.sla.rows.heartbeat_stale.limit_min, 30);
  });
});

describe("TASKD_SLA_* overrides", () => {
  it("lands in the published config and in the alert's threshold", async () => {
    const dataDir = tempDir();
    const envFile = join(dataDir, ".env");
    writeFileSync(
      envFile,
      [
        `${KEY.rows.blocked_clarification.limitMin}=0`,
        `${KEY.rows.blocked_clarification.furtherMin}=0`,
        "",
      ].join("\n"),
    );
    const taskd = await start({ dataDir, envFile, envVars: varsOf(envFile) });
    const identifier = await blockedCard(taskd);

    const data = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.equal(data.config.rows.blocked_clarification.limit_min, 0);
    const alert = data.alerts.find(
      (entry) => entry.card_id === identifier && entry.sla_row === "blocked_clarification",
    );
    assert.ok(alert, "the blocked row is reported");
    assert.equal(alert.threshold_min, 0);
    assert.equal(alert.mechanism, "taskd");
  });

  it("is re-read per request — a hand edit applies without a restart", async () => {
    const dataDir = tempDir();
    const envFile = join(dataDir, ".env");
    writeFileSync(envFile, `${KEY.rows.blocked_clarification.limitMin}=60\n`);
    const taskd = await start({ dataDir, envFile, envVars: varsOf(envFile) });

    const first = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.equal(first.config.rows.blocked_clarification.limit_min, 60);

    writeFileSync(envFile, `${KEY.rows.blocked_clarification.limitMin}=90\n`);
    const second = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.equal(second.config.rows.blocked_clarification.limit_min, 90);
  });

  it("lets the process environment win over the file", async () => {
    const dataDir = tempDir();
    const envFile = join(dataDir, ".env");
    writeFileSync(envFile, `${KEY.rows.blocked_clarification.limitMin}=60\n`);
    const taskd = await start({
      dataDir,
      envFile,
      envVars: varsOf(envFile),
      processEnv: { [KEY.rows.blocked_clarification.limitMin]: "30" },
    });
    const data = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.equal(data.config.rows.blocked_clarification.limit_min, 30);
  });

  it("fails the read closed but leaves /meta standing when a process value is bad", async () => {
    const taskd = await start({
      processEnv: { [KEY.rows.blocked_clarification.limitMin]: "not-a-number" },
    });
    const read = await call(taskd, "GET", "/api/v1/sla");
    assert.equal(read.status, 400, JSON.stringify(read.body));
    assert.equal(read.body.error.code, "CONFIG_FILE_INVALID");

    const meta = dataOf(await call(taskd, "GET", "/meta"));
    assert.equal(meta.capabilities.sla.error, "CONFIG_FILE_INVALID");
    assert.equal(meta.capabilities.sse, true, "the other capabilities are unaffected");
  });
});

describe("GET /api/v1/sla — request parameters", () => {
  it("applies ?period to the warn lead without changing the board's table", async () => {
    const taskd = await start();
    const data = dataOf(await call(taskd, "GET", "/api/v1/sla?period=600"));
    assert.equal(data.config.period_seconds, 600);
    // L is untouched; only P moved (so `warn = L − P` is computed with 600).
    assert.equal(data.config.rows.blocked_clarification.limit_min, 120);
  });

  it("refuses a malformed period rather than silently using the default", async () => {
    const taskd = await start();
    for (const bad of ["abc", "0", "-5", "12.5"]) {
      const result = await call(taskd, "GET", `/api/v1/sla?period=${encodeURIComponent(bad)}`);
      assert.equal(result.status, 400, bad);
      assert.equal(result.body.error.code, "VALIDATION_FAILED", bad);
    }
  });

  it("?card answers one card only and omits the board-level row", async () => {
    const dataDir = tempDir();
    const envFile = join(dataDir, ".env");
    writeFileSync(
      envFile,
      `${KEY.rows.blocked_clarification.limitMin}=0\n${KEY.rows.blocked_clarification.furtherMin}=0\n`,
    );
    const taskd = await start({ dataDir, envFile, envVars: varsOf(envFile) });
    const identifier = await blockedCard(taskd);

    const full = dataOf(await call(taskd, "GET", "/api/v1/sla"));
    assert.ok(full.alerts.some((alert) => alert.sla_row === "leader_stalled"));

    const one = dataOf(await call(taskd, "GET", `/api/v1/sla?card=${identifier}`));
    assert.ok(one.alerts.length > 0);
    assert.ok(one.alerts.every((alert) => alert.card_id === identifier));
    assert.equal(one.alerts.some((alert) => alert.sla_row === "leader_stalled"), false);
  });

  it("answers NOT_FOUND for an unknown card", async () => {
    const taskd = await start();
    const result = await call(taskd, "GET", "/api/v1/sla?card=NOPE-9999");
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "NOT_FOUND");
  });
});
