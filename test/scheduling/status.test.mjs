/**
 * The supervisor status probe and the one explicit session takeover.
 *
 * These are runtime facts, not guesses: a pool state file, the session lock,
 * the continue files, the subscriber state and the installed units. The take-
 * over starts only the pool (external control), and `--stop` only ever stops
 * the pool this command recorded.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { parseArgs } from "../../scripts/loop/options.mjs";
import {
  probeSupervisor,
  probeUnits,
  stopSupervisor,
  takeOver,
} from "../../scripts/loop/status.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-status-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function optsFor(dir) {
  return parseArgs(
    [
      "--state", join(dir, "state.json"),
      "--config", join(dir, "config.env"),
      "--agent", "alice",
      "--actor-kind", "claude",
      "--home", dir,
    ],
    { HOME: dir },
  );
}

/** Every manager says "not loaded" unless the case says otherwise. */
function noUnits() {
  return (command) => ({
    status: 1,
    stdout: "",
    stderr: "",
    error: null,
    ...(command === "crontab" ? { stdout: "no crontab for test\n" } : {}),
  });
}

function writePool(dir, overrides = {}) {
  writeFileSync(
    join(dir, "sessions.state.json"),
    JSON.stringify({
      version: 1,
      poolPid: 4242,
      heartbeatAt: new Date(NOW).toISOString(),
      controlMode: "internal",
      ...overrides,
    }),
  );
}

describe("supervisor status", () => {
  it("is absent when nothing is loaded and nothing is running", () => {
    const dir = tempDir();
    const report = probeSupervisor(optsFor(dir), {
      isAlive: () => false,
      now: () => NOW,
      run: noUnits(),
    });
    assert.equal(report.verdict, "absent");
    assert.equal(report.pool.live, false);
    assert.equal(report.units.any, false);
  });

  it("is running when the pool heartbeat is fresh, and reports the control mode", () => {
    const dir = tempDir();
    writePool(dir, { controlMode: "external" });
    const report = probeSupervisor(optsFor(dir), {
      isAlive: (pid) => pid === 4242,
      now: () => NOW,
      run: noUnits(),
    });
    assert.equal(report.verdict, "running");
    assert.equal(report.pool.poolPid, 4242);
    assert.equal(report.pool.controlMode, "external");
  });

  it("is busy while a continue turn is in flight", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "continue.processing.json"),
      JSON.stringify({ version: 1, reason: "timer" }),
    );
    const report = probeSupervisor(optsFor(dir), {
      isAlive: () => false,
      now: () => NOW,
      run: noUnits(),
    });
    assert.equal(report.verdict, "busy");
    assert.equal(report.continue.processing, true);
  });

  it("is configured-idle when the units are loaded but the pool is not", () => {
    const dir = tempDir();
    const run = (command, args) => {
      const loaded =
        command === "launchctl" && args.join(" ").includes("com.meerkat-taskpanel.alice.claude.session");
      return { status: loaded ? 0 : 1, stdout: "", stderr: "", error: null };
    };
    const report = probeSupervisor(optsFor(dir), {
      isAlive: () => false,
      now: () => NOW,
      run,
    });
    assert.equal(report.verdict, "configured-idle");
    assert.equal(report.units.launchd.any, true);
  });

  it("is partial when only the subscriber is alive", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "subscribe.state.json"),
      JSON.stringify({ version: 1, pid: 4242, connectedAt: new Date(NOW).toISOString() }),
    );
    const report = probeSupervisor(optsFor(dir), {
      isAlive: (pid) => pid === 4242,
      now: () => NOW,
      run: noUnits(),
    });
    assert.equal(report.verdict, "partial");
    assert.equal(report.subscribe.live, true);
  });

  it("detects the cron marker for the agent directory", () => {
    const dir = tempDir();
    const run = (command) =>
      command === "crontab"
        ? {
            status: 0,
            stdout: "# >>> meerkat-taskpanel (~/.claude) >>>\n* * * * * node x\n",
            stderr: "",
            error: null,
          }
        : { status: 1, stdout: "", stderr: "", error: null };
    const units = probeUnits(optsFor(dir), { run });
    assert.equal(units.cron.any, true);
    assert.equal(units.cron.loaded.block, true);
  });
});

describe("session takeover", () => {
  it("refuses when anything could already own the loop", async () => {
    const dir = tempDir();
    writePool(dir);
    const result = await takeOver(optsFor(dir), {
      isAlive: (pid) => pid === 4242,
      now: () => NOW,
      run: noUnits(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /running/);
  });

  it("starts only the pool, in external-control mode, and records its pid", async () => {
    const dir = tempDir();
    let argv = null;
    const child = {
      pid: 4242,
      unref() {},
    };
    const result = await takeOver(optsFor(dir), {
      isAlive: (pid) => pid === 4242,
      now: () => NOW,
      run: noUnits(),
      spawn: (command, args) => {
        argv = [command, ...args];
        writePool(dir, { controlMode: "external" });
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.poolPid, 4242);
    assert.ok(argv.includes("--session"));
    assert.ok(argv.includes("--control=external"));
    assert.equal(argv.includes("--once"), false);

    const record = JSON.parse(
      readFileSync(join(dir, "supervisor.session.json"), "utf8"),
    );
    assert.equal(record.poolPid, 4242);
    assert.equal(record.controlMode, "external");
  });

  it("reports a pool that never comes up", async () => {
    const dir = tempDir();
    let t = 0;
    const result = await takeOver(optsFor(dir), {
      isAlive: (pid) => pid === 4242,
      now: () => (t += 1_000),
      sleep: async () => {},
      waitMs: 3_000,
      run: noUnits(),
      spawn: () => ({ pid: 4242, unref() {} }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not come up/);
    assert.equal(result.poolPid, 4242);
  });

  it("stops only the pool it recorded", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "supervisor.session.json"),
      JSON.stringify({ version: 1, poolPid: 4242, controlMode: "external" }),
    );
    let alive = true;
    let signal = null;
    const result = await stopSupervisor(optsFor(dir), {
      isAlive: () => alive,
      kill: (pid, sig) => {
        signal = [pid, sig];
        alive = false;
      },
      now: (() => {
        let t = 0;
        return () => (t += 1_000);
      })(),
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.deepEqual(signal, [4242, "SIGTERM"]);
    assert.equal(exists(join(dir, "supervisor.session.json")), false);
  });

  it("refuses to stop when this session started nothing", async () => {
    const dir = tempDir();
    const result = await stopSupervisor(optsFor(dir), { isAlive: () => false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no session-started supervisor/);
  });
});

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
