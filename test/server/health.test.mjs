/**
 * The health probe — the one measurement behind `/health`.
 *
 * Two facts, and neither may take the board down:
 *
 *   * the database answered the last read (`db`, `lastOkAt`), and
 *   * how late this process's own timer fired (`eventLoopLagMs`).
 *
 * A synchronous block cannot be healed from inside the blocked loop; the probe
 * only *measures* it (the log line is the outside evidence) and reports the lag
 * on `/health`. Every database failure is a reported state, never a throw.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  EVENT_LOOP_BLOCKED_MS,
  HEALTH_PROBE_INTERVAL_MS,
  createHealthProbe,
} from "../../src/server/health.mjs";

const START = Date.parse("2026-01-02T03:04:05.678Z");
const iso = (ms) => new Date(ms).toISOString();

/** The smallest stand-in for the `node:sqlite` handle `currentRevision` reads. */
function fakeDb({ revision = 7, fail = false } = {}) {
  let broken = fail;
  return {
    prepare() {
      if (broken) {
        const err = new Error("SQLITE_IOERR: disk I/O error");
        err.errcode = 266;
        throw err;
      }
      return { get: () => ({ revision }) };
    },
    setBroken(value) {
      broken = value;
    },
  };
}

/**
 * A probe with a hand-driven clock and no real timer: `tick(at)` is the
 * interval callback, so the test decides exactly when it fired.
 */
function harness({ db = fakeDb(), logger = null } = {}) {
  let clock = START;
  const logs = [];
  const probe = createHealthProbe({
    db,
    logger: logger ?? ((record) => logs.push(record)),
    now: () => clock,
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
  });
  return {
    probe,
    logs,
    now: () => clock,
    set: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
      return clock;
    },
  };
}

describe("server/health — the /health projection", () => {
  it("starts from one successful database read and reports the contract fields", () => {
    const { probe } = harness();
    const snapshot = probe.snapshot();
    assert.equal(snapshot.db, "ok");
    assert.equal(snapshot.lastOkAt, iso(START));
    assert.equal(snapshot.eventLoopLagMs, 0);
    assert.equal(snapshot.revision, 7);
  });

  it("says `unavailable` instead of throwing when the database refuses the read", () => {
    const db = fakeDb();
    const { probe, set } = harness({ db });
    db.setBroken(true);
    const broken = probe.check();
    assert.equal(broken.db, "unavailable");
    assert.equal(broken.lastOkAt, iso(START), "the last good read stays readable");
    assert.equal(broken.revision, 7, "the last known revision survives the failure");

    db.setBroken(false);
    set(START + 900);
    const recovered = probe.check();
    assert.equal(recovered.db, "ok");
    assert.equal(recovered.lastOkAt, iso(START + 900));
  });

  it("does not let a failed read escape the probe", () => {
    const db = {
      prepare() {
        throw new TypeError("boom");
      },
    };
    assert.doesNotThrow(() => harness({ db }).probe.check());
  });

  it("accepts a clock that returns a Date, and reports null for an unusable one", () => {
    const dated = createHealthProbe({
      db: fakeDb(),
      now: () => new Date(START),
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {},
    });
    assert.equal(dated.snapshot().lastOkAt, iso(START));

    const broken = createHealthProbe({
      db: fakeDb(),
      now: () => Number.NaN,
      setIntervalFn: () => ({ unref: () => {} }),
      clearIntervalFn: () => {},
    });
    assert.equal(broken.snapshot().lastOkAt, null);
  });
});

describe("server/health — event-loop lag", () => {
  it("measures the delay past the schedule, not the raw interval", () => {
    const { probe, set } = harness();
    // Fired on time: the scheduled moment and the real one agree.
    set(START + HEALTH_PROBE_INTERVAL_MS);
    assert.equal(probe.tick().eventLoopLagMs, 0);
    // Fired 1.5 s late relative to the next schedule.
    set(START + HEALTH_PROBE_INTERVAL_MS * 3 + 500);
    assert.equal(probe.tick().eventLoopLagMs, 1_500);
  });

  it("logs event_loop_blocked only once past the threshold", () => {
    const { probe, logs, set } = harness();
    set(START + HEALTH_PROBE_INTERVAL_MS);
    probe.tick();
    assert.deepEqual(logs, [], "an ordinary tick is silent");

    // A block that pushes the timer 1.5 s late is under the 2 s bound.
    set(START + HEALTH_PROBE_INTERVAL_MS * 3 + 500);
    probe.tick();
    assert.deepEqual(logs, [], `lag 1500 must not report at ${EVENT_LOOP_BLOCKED_MS}ms`);

    // Past the bound: one error record, naming the measured lag.
    set(START + HEALTH_PROBE_INTERVAL_MS * 6 + 600);
    probe.tick();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, "event_loop_blocked");
    assert.equal(logs[0].level, "error");
    assert.ok(logs[0].lag_ms > EVENT_LOOP_BLOCKED_MS);
    assert.equal(logs[0].threshold_ms, EVENT_LOOP_BLOCKED_MS);

    // Still late on the next tick: the episode is already reported, once.
    set(START + 9_700);
    probe.tick();
    assert.equal(logs.length, 1, "one record per episode, not one per late tick");

    // An on-time tick clears the episode, so a later block is news again.
    set(START + 11_000);
    probe.tick();
    assert.equal(logs.length, 1, "recovery is silent");
    set(START + 14_200);
    probe.tick();
    assert.equal(logs.length, 2, "a second episode is reported again");
  });

  it("arms one timer and stops it without touching the state", () => {
    let armed = 0;
    let cleared = 0;
    let callback = null;
    const probe = createHealthProbe({
      db: fakeDb(),
      now: () => START,
      setIntervalFn: (fn, ms) => {
        assert.equal(ms, HEALTH_PROBE_INTERVAL_MS);
        armed += 1;
        callback = fn;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    probe.start();
    probe.start();
    assert.equal(armed, 1, "a second start is a no-op");
    assert.equal(callback().db, "ok", "the interval callback is the probe's tick");
    probe.stop();
    probe.stop();
    assert.equal(cleared, 1, "a second stop is a no-op");
  });
});
