/**
 * The loop's state-file vocabulary and pool defaults — the names the
 * orchestrator writes and the installer's status probe reads.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { processStartToken } from "../../src/foundation/daemon-state.mjs";
import {
  LIVE_STATUSES,
  POOL_HEARTBEAT_MS,
  POOL_KILL_GRACE_MS,
  POOL_STALE_MS,
  POOL_START_BUDGET_MS,
  POOL_VERDICTS,
  POOL_WEDGE_MARGIN_MS,
  QUEUE_FILES,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  STATE_FILES,
  effectiveTurnTimeoutMs,
  killDeadlineMs,
  poolVerdict,
  sendDeadlineMs,
  startKillDeadlineMs,
  statePathsForDir,
  wedgeKillAction,
} from "../../src/foundation/loop-state.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const LIVE = { poolPid: 4242, isAlive: (pid) => pid === 4242, now: () => NOW };

describe("loop-state — the loop's state vocabulary", () => {
  it("names the state siblings under one directory", () => {
    assert.deepEqual(statePathsForDir("/state"), {
      continueState: join("/state", "continue.state.json"),
      slaLedger: join("/state", "sla-ledger.json"),
      workflowLedger: join("/state", "workflow-ledger.json"),
      slaLastOk: join("/state", "loop-patrol-last-ok.json"),
      deferrals: join("/state", "deferrals.json"),
      poolWedge: join("/state", "pool-wedge.json"),
    });
    assert.equal(STATE_FILES.deferrals, "deferrals.json");
    assert.equal(STATE_FILES.poolWedge, "pool-wedge.json");
  });

  it("pins the queue, liveness and session constants", () => {
    assert.deepEqual(QUEUE_FILES, {
      cards: "cards.queue.json",
      ledger: "subagents.state.json",
      sessions: "sessions.state.json",
      workspaces: "workspaces.json",
    });
    assert.deepEqual(LIVE_STATUSES, ["spawned", "running", "reattaching"]);
    assert.equal(SESSION_LOCK_FILE, "session.lock");
    assert.equal(STATE_FILES.runLock, "run.lock");
    assert.equal(POOL_HEARTBEAT_MS, 15_000);
    // Six beats: four is too tight under load and turns a busy pool into one
    // that reads "gone" to a second reader.
    assert.equal(POOL_STALE_MS, 6 * POOL_HEARTBEAT_MS);
    assert.equal(POOL_STALE_MS, 90_000);
    assert.equal(POOL_START_BUDGET_MS, 5 * 60_000);
    assert.equal(POOL_WEDGE_MARGIN_MS, 2 * 60_000);
    assert.equal(POOL_KILL_GRACE_MS, 60_000);
    assert.deepEqual(POOL_VERDICTS, [
      "running",
      "busy",
      "starting",
      "unresponsive",
      "wedged",
      "gone",
    ]);
    assert.deepEqual(SESSION_DEFAULTS, {
      maxConcurrency: 8,
      projectConcurrency: 8,
      poolMax: 8,
      projectIdleMs: 30 * 60 * 1000,
      sessionMaxAgeMs: 24 * 60 * 60 * 1000,
      turnTimeoutMs: 30 * 60 * 1000,
      pollMs: 1000,
    });
  });
});

describe("loop-state — one liveness verdict", () => {
  it("is gone when there is no pid, the pid is dead, or its start token differs", (t) => {
    assert.deepEqual(
      { verdict: poolVerdict({ ...LIVE, poolPid: null }).verdict, live: poolVerdict({ ...LIVE, poolPid: null }).live },
      { verdict: "gone", live: false },
    );
    assert.equal(poolVerdict({ ...LIVE, isAlive: () => false }).verdict, "gone");
    // A live pid whose start token is not the one recorded is a reused pid.
    if (processStartToken(process.pid) === null) {
      t.skip("this platform cannot report a start token; pid-only liveness is the rule");
      return;
    }
    const reused = poolVerdict({
      poolPid: process.pid,
      poolPidStart: "not-this-process",
      isAlive: () => true,
      now: () => NOW,
    });
    assert.equal(reused.verdict, "gone", "a token mismatch is a dead pool, not a live one");
  });

  it("is starting inside the start budget and wedged past it", () => {
    const starting = poolVerdict({
      ...LIVE,
      phase: "starting",
      startStartedAt: ago(1_000),
      heartbeatAt: null,
    });
    assert.equal(starting.verdict, "starting");
    assert.equal(starting.live, true, "a starting pool is a live pool");
    // An older file may carry the phase without the timestamp; it is still
    // within an unknown budget, so it is starting (never a guessed wedged).
    assert.equal(poolVerdict({ ...LIVE, phase: "starting", startStartedAt: null }).verdict, "starting");

    const wedged = poolVerdict({
      ...LIVE,
      phase: "starting",
      startStartedAt: ago(POOL_START_BUDGET_MS + 1),
    });
    assert.equal(wedged.verdict, "wedged");
    assert.equal(wedged.live, true);
  });

  it("is busy while a tick is in flight within its deadline, wedged past it", () => {
    const turn = 30 * 60 * 1_000;
    const busy = poolVerdict({
      ...LIVE,
      phase: "running",
      tickStartedAt: ago(1_000),
      // The heartbeat is old, but a tick in flight is the stronger fact.
      heartbeatAt: ago(POOL_STALE_MS + 60_000),
      turnTimeoutMs: turn,
    });
    assert.equal(busy.verdict, "busy");
    assert.equal(busy.live, true);

    const wedged = poolVerdict({
      ...LIVE,
      phase: "running",
      tickStartedAt: ago(sendDeadlineMs(turn) + 1),
      turnTimeoutMs: turn,
    });
    assert.equal(wedged.verdict, "wedged");
    assert.equal(wedged.live, true);
  });

  it("is unresponsive while a live pid keeps a stale heartbeat and no tick is in flight", () => {
    const stale = poolVerdict({
      ...LIVE,
      phase: "running",
      heartbeatAt: ago(POOL_STALE_MS + 1),
    });
    assert.equal(stale.verdict, "unresponsive");
    assert.equal(stale.live, true, "liveness never depends on heartbeat freshness");
    const unwritten = poolVerdict({ ...LIVE, phase: "running", heartbeatAt: null });
    assert.equal(unwritten.verdict, "unresponsive");
    assert.match(unwritten.reason, /no heartbeat/);

    const fresh = poolVerdict({
      ...LIVE,
      phase: "running",
      heartbeatAt: ago(1_000),
    });
    assert.equal(fresh.verdict, "running");
    assert.equal(fresh.live, true);
  });

  it("derives the tick deadline from the effective turn timeout, not a constant", () => {
    for (const turn of [1_200_000, 1_800_000, 7_199_000]) {
      // One millisecond inside the margin is still a busy tick for every turn.
      const busy = poolVerdict({
        ...LIVE,
        phase: "running",
        tickStartedAt: ago(turn + POOL_WEDGE_MARGIN_MS - 1),
        turnTimeoutMs: turn,
      });
      assert.equal(busy.verdict, "busy", `${turn}ms turn: the margin is part of the deadline`);
      const wedged = poolVerdict({
        ...LIVE,
        phase: "running",
        tickStartedAt: ago(turn + POOL_WEDGE_MARGIN_MS + 1),
        turnTimeoutMs: turn,
      });
      assert.equal(wedged.verdict, "wedged", `${turn}ms turn: past the deadline is wedged`);
    }
    assert.equal(effectiveTurnTimeoutMs(undefined), SESSION_DEFAULTS.turnTimeoutMs);
    assert.equal(sendDeadlineMs(undefined), SESSION_DEFAULTS.turnTimeoutMs + POOL_WEDGE_MARGIN_MS);
    assert.equal(killDeadlineMs(1_200_000), sendDeadlineMs(1_200_000) + 60_000);
  });

  it("keeps live and the six-state vocabulary in one relation", () => {
    const samples = [
      poolVerdict({ ...LIVE, poolPid: null }),
      poolVerdict({ ...LIVE, isAlive: () => false }),
      poolVerdict({ ...LIVE, phase: "starting", startStartedAt: ago(1_000) }),
      poolVerdict({ ...LIVE, phase: "starting", startStartedAt: ago(POOL_START_BUDGET_MS + 1) }),
      poolVerdict({ ...LIVE, phase: "running", tickStartedAt: ago(1_000) }),
      poolVerdict({ ...LIVE, phase: "running", tickStartedAt: ago(2 * 60 * 60 * 1_000) }),
      poolVerdict({ ...LIVE, phase: "running", heartbeatAt: ago(POOL_STALE_MS + 1) }),
      poolVerdict({ ...LIVE, phase: "running", heartbeatAt: ago(1_000) }),
    ];
    for (const sample of samples) {
      assert.ok(POOL_VERDICTS.includes(sample.verdict), `unexpected verdict ${sample.verdict}`);
      assert.equal(sample.live, sample.verdict !== "gone", `${sample.verdict} live relation`);
    }
    assert.deepEqual(new Set(samples.map((sample) => sample.verdict)), new Set(POOL_VERDICTS));
  });
});

describe("loop-state — the ping's one kill decision", () => {
  const TURN = 30 * 60 * 1_000;
  const pool = (extra = {}) => ({
    poolPid: 4242,
    poolPidStart: "token-1",
    isAlive: (pid) => pid === 4242,
    now: () => NOW,
    turnTimeoutMs: TURN,
    ...extra,
  });
  const identity = { poolPid: 4242, poolPidStart: "token-1" };

  it("does nothing while a phase is inside its deadline", () => {
    const starting = wedgeKillAction(
      pool({ phase: "starting", startStartedAt: ago(POOL_START_BUDGET_MS - 1) }),
    );
    assert.equal(starting.action, "none");
    assert.match(starting.reason, /inside/);

    const busyTick = wedgeKillAction(
      pool({ phase: "running", tickStartedAt: ago(sendDeadlineMs(TURN) - 1) }),
    );
    assert.equal(busyTick.action, "none");
    assert.match(busyTick.reason, /inside/);
  });

  it("waits the 60 s grace after the phase deadline", () => {
    // At the poolVerdict threshold the pool is already "wedged", but the ping
    // may not act until the grace has passed.
    const starting = wedgeKillAction(
      pool({ phase: "starting", startStartedAt: ago(POOL_START_BUDGET_MS + 1) }),
    );
    assert.equal(starting.action, "none");
    assert.match(starting.reason, /grace/);

    const tick = wedgeKillAction(
      pool({ phase: "running", tickStartedAt: ago(sendDeadlineMs(TURN) + POOL_KILL_GRACE_MS - 1) }),
    );
    assert.equal(tick.action, "none");
    assert.match(tick.reason, /grace/);
  });

  it("asks for SIGTERM once a phase is past its deadline plus 60 s", () => {
    const starting = wedgeKillAction(
      pool({ phase: "starting", startStartedAt: ago(startKillDeadlineMs() + 1) }),
    );
    assert.equal(starting.action, "sigterm");
    assert.equal(starting.phase, "starting");
    assert.equal(starting.poolPid, 4242);
    assert.equal(starting.deadlineMs, startKillDeadlineMs());
    assert.equal(starting.marker.wedgedKillAt, new Date(NOW).toISOString());
    assert.deepEqual(
      { poolPid: starting.marker.poolPid, poolPidStart: starting.marker.poolPidStart },
      identity,
    );

    const tick = wedgeKillAction(
      pool({ phase: "running", tickStartedAt: ago(killDeadlineMs(TURN) + 1) }),
    );
    assert.equal(tick.action, "sigterm");
    assert.equal(tick.phase, "tick");
    assert.equal(tick.deadlineMs, killDeadlineMs(TURN));
    assert.equal(tick.ageMs, killDeadlineMs(TURN) + 1);
  });

  it("never treats lastTickOkAt's age as a kill signal", () => {
    const fastFailing = wedgeKillAction(
      pool({
        phase: "running",
        lastTickOkAt: ago(6 * 60 * 60 * 1_000),
        heartbeatAt: ago(0),
      }),
    );
    assert.equal(fastFailing.action, "none", "a fast-failing tick is degraded, not wedged");
    assert.match(fastFailing.reason, /no tick in flight/);
  });

  it("does nothing for a gone pool or a phase whose age cannot be proven", () => {
    assert.equal(
      wedgeKillAction(pool({ phase: "running", tickStartedAt: ago(10_000), isAlive: () => false })).action,
      "none",
    );
    assert.equal(wedgeKillAction(pool({ phase: "starting", startStartedAt: null })).action, "none");
    assert.equal(wedgeKillAction(pool({ phase: "running", tickStartedAt: "not-a-time" })).action, "none");
    // A different start token is a reused pid: never the pool this marker names.
    // Use this process's pid so a real token is readable and can mismatch.
    if (processStartToken(process.pid) !== null) {
      const reused = wedgeKillAction({
        poolPid: process.pid,
        poolPidStart: "not-this-process",
        isAlive: () => true,
        now: () => NOW,
        phase: "running",
        tickStartedAt: ago(killDeadlineMs(TURN) + 1),
      });
      assert.equal(reused.action, "none");
      assert.match(reused.reason, /gone/);
    }
  });

  it("SIGKILLs on a later ping, then acts no more; a new pool is a new wedge", () => {
    // One wedge has one tickStartedAt; later pings only advance the clock.
    const tickStartedAt = ago(killDeadlineMs(TURN) + 1);
    const fired = wedgeKillAction(pool({ phase: "running", tickStartedAt }));
    assert.equal(fired.action, "sigterm");

    const samePing = wedgeKillAction(pool({ phase: "running", tickStartedAt, marker: fired.marker }));
    assert.equal(samePing.action, "none", "one action per ping cadence, not two");

    const later = wedgeKillAction(
      pool({ phase: "running", tickStartedAt, now: () => NOW + 60_000, marker: fired.marker }),
    );
    assert.equal(later.action, "sigkill");
    assert.equal(later.marker.wedgedSigkillAt, new Date(NOW + 60_000).toISOString());

    const afterKill = wedgeKillAction(
      pool({ phase: "running", tickStartedAt, now: () => NOW + 120_000, marker: later.marker }),
    );
    assert.equal(afterKill.action, "none");
    assert.match(afterKill.reason, /already killed/);

    // A restarted pool has a new start token: the old marker never applies.
    const restarted = wedgeKillAction({
      poolPid: 5252,
      poolPidStart: "token-2",
      isAlive: (pid) => pid === 5252,
      now: () => NOW,
      turnTimeoutMs: TURN,
      phase: "running",
      tickStartedAt,
      marker: later.marker,
    });
    assert.equal(restarted.action, "sigterm");
    assert.equal(restarted.marker.poolPid, 5252);
  });

  it("acts once per wedge in the starting phase too", () => {
    // The kill-once rule is per phase, not per tick: a pool stuck starting has
    // the same one SIGTERM, then one SIGKILL, then silence.
    const startStartedAt = ago(startKillDeadlineMs() + 1);
    const fired = wedgeKillAction(pool({ phase: "starting", startStartedAt }));
    assert.equal(fired.action, "sigterm");
    assert.equal(fired.phase, "starting");

    const samePing = wedgeKillAction(
      pool({ phase: "starting", startStartedAt, marker: fired.marker }),
    );
    assert.equal(samePing.action, "none", "one action per ping cadence, not two");

    const later = wedgeKillAction(
      pool({ phase: "starting", startStartedAt, now: () => NOW + 60_000, marker: fired.marker }),
    );
    assert.equal(later.action, "sigkill");
    assert.equal(later.marker.wedgedKillAt, fired.marker.wedgedKillAt);

    const afterKill = wedgeKillAction(
      pool({ phase: "starting", startStartedAt, now: () => NOW + 120_000, marker: later.marker }),
    );
    assert.equal(afterKill.action, "none");
    assert.match(afterKill.reason, /already killed/);
  });
});
