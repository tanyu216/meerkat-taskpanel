/**
 * The boot-health record and its backoff ladder.
 *
 * A long-lived loop entry that dies before completing its first tick is a boot
 * that never worked. The service manager would restart it immediately, so a
 * deterministic fault becomes a hot loop. The record lives beside the loop's
 * other state (`supervisor.health.json`, `docs/scheduling.md §The supervisor's
 * state directory`) and the ladder delays only that case: a crash after a
 * successful run is never delayed.
 *
 * The tests inject the clock, the file functions and the synchronous sleep, so
 * the 5/15/60/300 s ladder is asserted without waiting.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { VERSION } from "../../src/foundation/constants.mjs";
import {
  BOOT_BACKOFF_MS,
  BOOT_FAILURE_THRESHOLD,
  START_HISTORY_LIMIT,
  beginBootHealth,
  bootDelayMs,
  failureRecord,
  firstTickRecord,
  startRecord,
} from "../../src/orchestrator/boot-health.mjs";
import { main as supervisorMain } from "../../src/orchestrator/supervisor.mjs";

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-01-02T03:04:05.678Z");
const iso = (ms) => new Date(ms).toISOString();

/** A `beginBootHealth` harness: in-memory file, captured writes, recording sleep. */
function harness(previous = {}) {
  const writes = [];
  const logs = [];
  const sleeps = [];
  let state = previous;
  const boot = beginBootHealth({
    path: "/state/supervisor.health.json",
    log: (line, fields) => logs.push({ line, fields }),
    now: () => NOW,
    pid: 4242,
    version: "9.9.9",
    read: () => state,
    write: (path, value) => {
      writes.push({ path, value });
      state = value;
    },
    sleepSync: (ms) => sleeps.push(ms),
  });
  return { boot, writes, logs, sleeps, state: () => state };
}

describe("boot-health — the restart ladder", () => {
  it("delays nothing until the boot-failure threshold is crossed", () => {
    assert.equal(BOOT_FAILURE_THRESHOLD, 3);
    assert.equal(bootDelayMs(0), 0);
    assert.equal(bootDelayMs(1), 0);
    assert.equal(bootDelayMs(2), 0);
    assert.equal(bootDelayMs(3), 0);
    assert.equal(bootDelayMs(4), 5_000);
    assert.equal(bootDelayMs(5), 15_000);
    assert.equal(bootDelayMs(6), 60_000);
    assert.equal(bootDelayMs(7), 300_000);
    // The cap is the bound: a longer streak does not grow past five minutes.
    assert.equal(bootDelayMs(40), 300_000);
    assert.deepEqual(BOOT_BACKOFF_MS, [5_000, 15_000, 60_000, 300_000]);
  });

  it("records the six fields the contract names, appending to a bounded start history", () => {
    const record = startRecord(
      { bootFailures: 2, lastCrash: "2026-01-01T00:00:00.000Z", starts: [iso(NOW - 1)] },
      { startedAt: iso(NOW), pid: 4242, version: "9.9.9" },
    );
    assert.deepEqual(Object.keys(record).sort(), [
      "bootFailures",
      "lastCrash",
      "pid",
      "startedAt",
      "starts",
      "version",
    ]);
    assert.equal(record.bootFailures, 2, "a start does not assume the boot succeeded");
    assert.equal(record.lastCrash, "2026-01-01T00:00:00.000Z");
    assert.equal(record.starts.at(-1), iso(NOW));
    assert.equal(record.starts.length, 2);

    let long = { starts: Array.from({ length: 5 }, (_, index) => iso(NOW + index)) };
    for (let index = 0; index < START_HISTORY_LIMIT; index += 1) {
      long = startRecord(long, { startedAt: iso(NOW + 100 + index), pid: 1, version: "1" });
    }
    assert.equal(long.starts.length, START_HISTORY_LIMIT, "the history is bounded");
  });

  it("a first tick clears the streak", () => {
    const record = startRecord({}, { startedAt: iso(NOW), pid: 4242, version: "9.9.9" });
    const cleared = firstTickRecord({ ...record, bootFailures: 4 });
    assert.equal(cleared.bootFailures, 0);
    assert.equal(cleared.lastCrash, record.lastCrash);
  });

  it("a failure records the crash and one more boot failure", () => {
    const record = startRecord({}, { startedAt: iso(NOW), pid: 4242, version: "9.9.9" });
    const next = failureRecord(record, { lastCrash: iso(NOW + 1) });
    assert.equal(next.bootFailures, 1);
    assert.equal(next.lastCrash, iso(NOW + 1));
  });
});

describe("boot-health — the process lifecycle", () => {
  it("arms the record at start, preserving the previous streak", () => {
    const h = harness({ bootFailures: 2, lastCrash: iso(NOW - 10), starts: [iso(NOW - 20)] });
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].path, "/state/supervisor.health.json");
    const record = h.writes[0].value;
    assert.equal(record.startedAt, iso(NOW));
    assert.equal(record.pid, 4242);
    assert.equal(record.version, "9.9.9");
    assert.equal(record.bootFailures, 2);
    assert.deepEqual(record.starts, [iso(NOW - 20), iso(NOW)]);
  });

  it("a first tick clears the streak on disk", () => {
    const h = harness({ bootFailures: 5 });
    h.boot.noteFirstTick();
    assert.equal(h.state().bootFailures, 0);
    // Idempotent: a later tick must not rewrite the record for no reason.
    const writes = h.writes.length;
    h.boot.noteFirstTick();
    assert.equal(h.writes.length, writes);
  });

  it("a crash before the first tick delays only after the third consecutive failure", () => {
    const first = harness({ bootFailures: 0 });
    first.boot.crashSync();
    assert.deepEqual(first.sleeps, [], "the manager's own RestartSec is the back-off at first");
    assert.equal(first.state().bootFailures, 1);

    const fourth = harness({ bootFailures: 3 });
    fourth.boot.crashSync();
    assert.equal(fourth.state().bootFailures, 4);
    assert.deepEqual(fourth.sleeps, [5_000]);
    assert.equal(fourth.state().lastCrash, iso(NOW));
    const record = fourth.logs.find((entry) => entry.fields?.event === "crash_loop");
    assert.ok(record, `no crash_loop record: ${JSON.stringify(fourth.logs)}`);
    assert.equal(record.fields.level, "error");
    assert.equal(record.fields.boot_failures, 4);
    assert.equal(record.fields.delay_ms, 5_000);
  });

  it("a crash after a successful run is never delayed", () => {
    const h = harness({ bootFailures: 0 });
    h.boot.noteFirstTick();
    h.boot.crashSync();
    assert.deepEqual(h.sleeps, []);
    assert.equal(h.state().bootFailures, 0);
    assert.equal(h.state().lastCrash, iso(NOW), "the crash is still recorded");
    assert.equal(h.logs.some((entry) => entry.fields?.event === "crash_loop"), false);
  });

  it("cli exit 78 is a permanent fault, not a boot failure", () => {
    const h = harness({ bootFailures: 3 });
    const { delayMs } = h.boot.settle(78);
    assert.equal(delayMs, 0);
    assert.equal(h.state().bootFailures, 3, "a stopped unit must not poison the next start");
    assert.deepEqual(h.sleeps, []);
  });

  it("a non-zero early exit is a boot failure and returns the ladder delay", () => {
    const h = harness({ bootFailures: 3 });
    const { delayMs } = h.boot.settle(2);
    assert.equal(delayMs, 5_000);
    assert.equal(h.state().bootFailures, 4);
    assert.equal(h.logs.some((entry) => entry.fields?.event === "crash_loop"), true);
  });

  it("a clean exit after a successful run writes nothing more", () => {
    const h = harness({ bootFailures: 2 });
    h.boot.noteFirstTick();
    const writes = h.writes.length;
    assert.deepEqual(h.boot.settle(0), { delayMs: 0 });
    assert.equal(h.writes.length, writes);
  });
});

describe("boot-health — wiring", () => {
  it("taskctl pool arms supervisor.health.json before it checks the skills, then exits 78", async () => {
    const dir = makeTempDir("meerkat-taskpanel-boot-health-");
    const home = join(dir, "home");
    const stateDir = join(dir, "state");
    const logPath = join(dir, "supervisor.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const code = await supervisorMain(
      [
        "--session",
        "--actor-kind",
        "claude",
        "--agent",
        "alice",
        "--home",
        home,
        // The moved parser's spelling; the CLI's `--state-dir` is translated by
        // `orchestrator/dispatch.mjs` before it reaches this entry.
        "--state",
        join(stateDir, "supervisor.state.json"),
        "--log",
        logPath,
      ],
      { ...process.env, TASKD_NO_AUTOSTART: "1" },
    );

    assert.equal(code, 78, "a missing skill is EX_CONFIG");
    const health = JSON.parse(readFileSync(join(stateDir, "supervisor.health.json"), "utf8"));
    assert.deepEqual(Object.keys(health).sort(), [
      "bootFailures",
      "lastCrash",
      "pid",
      "startedAt",
      "starts",
      "version",
    ]);
    assert.equal(health.version, VERSION);
    assert.equal(health.pid, process.pid);
    assert.equal(health.bootFailures, 0);
    assert.equal(health.starts.length, 1);
    assert.equal(health.lastCrash, null);
  });

  it("a state directory that cannot be written does not kill the entry", () => {
    const logs = [];
    const boot = beginBootHealth({
      path: "/definitely/not/here/supervisor.health.json",
      log: (line, fields) => logs.push({ line, fields }),
      now: () => NOW,
      pid: 1,
      version: "1",
      sleepSync: () => {},
    });
    // The real writer throws ENOENT; the lifecycle must degrade, not throw.
    assert.doesNotThrow(() => boot.noteFirstTick());
    assert.doesNotThrow(() => boot.settle(1));
    assert.doesNotThrow(() => boot.crashSync());
  });
});
