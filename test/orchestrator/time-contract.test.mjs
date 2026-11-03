/**
 * 0034 — the loop's clocks, as one contract.
 *
 * Every value here already existed; what did not exist was a statement that they
 * *relate*. The inequalities below are the statement, so a future edit to one
 * clock that silently breaks its neighbour fails here instead of in production:
 *
 *   * a claim is fresh longer than a worker is expected to pulse (10m < 30m);
 *   * a turn outlasts two heartbeat windows (20m ≤ turn < 2h);
 *   * the continue cadence fits inside a turn;
 *   * patrol's staleness is the same-holder recovery window;
 *   * a pool heartbeat is stale well after it is written.
 *
 * Plus the two `awaiting` exemptions the protocol relies on: patrol never scans
 * an awaiting card, and the sweep never offers it as a stale claim.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAIM_STALE_ANY_MS,
  CLAIM_STALE_SAME_MS,
  CLI_TIMEOUT_MS,
  HEARTBEAT_FRESH_MS,
} from "../../src/foundation/constants.mjs";
import {
  DEFAULT_CONTINUE_SECONDS,
  PATROL_STALE_MS,
  planPatrol,
} from "../../src/foundation/scheduling.mjs";
import {
  POOL_KILL_GRACE_MS,
  POOL_START_BUDGET_MS,
  POOL_VERDICTS,
  killDeadlineMs,
  sendDeadlineMs,
  startKillDeadlineMs,
} from "../../src/foundation/loop-state.mjs";
import { REQUEST_TIMEOUT_MS } from "../../src/foundation/transport/http.mjs";
import { POOL_HEARTBEAT_MS, POOL_STALE_MS } from "../../src/orchestrator/session.mjs";

/** The documented turn default and the bounds `src/orchestrator/options.mjs` enforces. */
const TURN_DEFAULT_MS = 30 * 60 * 1000;
const TURN_MIN_MS = 1200 * 1000;
const TURN_MAX_EXCLUSIVE_MS = 7200 * 1000;

describe("scheduling/time-contract — the clocks relate", () => {
  it("heartbeat < same-holder staleness < any-holder takeover", () => {
    assert.ok(HEARTBEAT_FRESH_MS < CLAIM_STALE_SAME_MS);
    assert.ok(CLAIM_STALE_SAME_MS < CLAIM_STALE_ANY_MS);
  });

  it("a turn outlasts two heartbeat windows, within its documented bounds", () => {
    assert.ok(2 * HEARTBEAT_FRESH_MS <= TURN_MIN_MS, "a 20-minute floor covers two 10-minute pulses");
    assert.ok(TURN_DEFAULT_MS >= TURN_MIN_MS);
    assert.ok(TURN_DEFAULT_MS <= TURN_MAX_EXCLUSIVE_MS);
  });

  it("the continue cadence fits inside a turn", () => {
    assert.ok(DEFAULT_CONTINUE_SECONDS * 1000 < TURN_DEFAULT_MS);
  });

  it("patrol's staleness is the same-holder recovery window", () => {
    assert.equal(PATROL_STALE_MS, CLAIM_STALE_SAME_MS);
  });

  it("a pool heartbeat is stale well after it is written", () => {
    assert.ok(POOL_STALE_MS > POOL_HEARTBEAT_MS);
    assert.equal(POOL_STALE_MS, 6 * POOL_HEARTBEAT_MS, "90s: six beats, not four");
    assert.ok(POOL_STALE_MS < TURN_MIN_MS, "a stale heartbeat is detected inside one turn");
  });

  it("a send deadline outlasts the turn across the whole allowed range", () => {
    // The whole range the option parser accepts: [1200s, 7200s).
    for (let turn = TURN_MIN_MS; turn < TURN_MAX_EXCLUSIVE_MS; turn += 60_000) {
      const send = sendDeadlineMs(turn);
      const kill = killDeadlineMs(turn);
      assert.ok(send > turn, `turn=${turn}ms: a legitimate turn is never the deadline`);
      assert.ok(kill > send, `turn=${turn}ms: the kill deadline has its own grace`);
      assert.ok(POOL_STALE_MS <= send, `turn=${turn}ms: staleness is inside the send window`);
    }
    // The boundaries themselves, without relying on the loop step.
    for (const turn of [TURN_MIN_MS, TURN_DEFAULT_MS, TURN_MAX_EXCLUSIVE_MS - 1]) {
      assert.ok(sendDeadlineMs(turn) > turn);
      assert.ok(killDeadlineMs(turn) > sendDeadlineMs(turn));
    }
    assert.deepEqual(POOL_VERDICTS, [
      "running",
      "busy",
      "starting",
      "unresponsive",
      "wedged",
      "gone",
    ]);
  });

  it("the CLI child bound is 60 s, above the CLI's own HTTP bound", () => {
    assert.equal(CLI_TIMEOUT_MS, 60_000);
    assert.ok(CLI_TIMEOUT_MS > REQUEST_TIMEOUT_MS, "the outer bound outlasts the inner one");
  });

  it("the ping's kill grace sits after both phase deadlines", () => {
    assert.equal(POOL_KILL_GRACE_MS, 60_000);
    assert.equal(
      startKillDeadlineMs(),
      POOL_START_BUDGET_MS + POOL_KILL_GRACE_MS,
      "the starting phase gets the same grace as a tick",
    );
    for (const turn of [TURN_MIN_MS, TURN_DEFAULT_MS, TURN_MAX_EXCLUSIVE_MS - 1]) {
      assert.equal(killDeadlineMs(turn), sendDeadlineMs(turn) + POOL_KILL_GRACE_MS);
      assert.ok(killDeadlineMs(turn) > sendDeadlineMs(turn));
      assert.ok(killDeadlineMs(turn) > turn, "the grace never shortens a legitimate turn");
    }
  });

  it("patrol never reports an awaiting card as stale — it holds a dormant claim", () => {
    const now = "2026-10-22T12:00:00.000Z";
    const old = "2026-10-22T10:00:00.000Z"; // 2h ago, past every heartbeat window
    const base = { identifier: "PROJ-1", claimed_by_actor: { display_name: "linus" }, heartbeat_at: old };

    assert.deepEqual(planPatrol({ now, tasks: [{ ...base, status: "awaiting" }] }), []);
    const stale = planPatrol({ now, tasks: [{ ...base, status: "in_progress" }] });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].type, "stale");
  });
});
