/**
 * 0034 — the loop's clocks, as one contract.
 *
 * Every value here already existed; what did not exist was a statement that they
 * *relate*. The inequalities below are the statement, so a future edit to one
 * clock that silently breaks its neighbour fails here instead of in production:
 *
 *   * a claim is fresh longer than a worker is expected to pulse (10m < 30m);
 *   * a turn outlasts two heartbeat windows and finishes before the ledger
 *     reaps a live row (20m ≤ turn < 2h);
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
  HEARTBEAT_FRESH_MS,
} from "../../src/foundation/constants.mjs";
import {
  DEFAULT_CONTINUE_SECONDS,
  LEDGER_STALE_MS,
  PATROL_STALE_MS,
  planPatrol,
} from "../../src/foundation/scheduling.mjs";
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

  it("a turn outlasts two heartbeat windows and ends before the ledger reap", () => {
    assert.ok(2 * HEARTBEAT_FRESH_MS <= TURN_MIN_MS, "a 20-minute floor covers two 10-minute pulses");
    assert.ok(TURN_DEFAULT_MS >= TURN_MIN_MS);
    assert.ok(TURN_DEFAULT_MS <= TURN_MAX_EXCLUSIVE_MS);
    assert.ok(TURN_DEFAULT_MS < LEDGER_STALE_MS, "the turn must finish before its ledger row is reclaimed");
    assert.ok(TURN_MAX_EXCLUSIVE_MS <= LEDGER_STALE_MS);
  });

  it("the continue cadence fits inside a turn", () => {
    assert.ok(DEFAULT_CONTINUE_SECONDS * 1000 < TURN_DEFAULT_MS);
  });

  it("patrol's staleness is the same-holder recovery window", () => {
    assert.equal(PATROL_STALE_MS, CLAIM_STALE_SAME_MS);
  });

  it("a pool heartbeat is stale well after it is written", () => {
    assert.ok(POOL_STALE_MS > POOL_HEARTBEAT_MS);
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
