/**
 * The recovery inventory: every bounded cycle has one exported constant.
 *
 * A hand-kept list, on purpose. It does not parse prose; it fails when a bound
 * that `docs/scheduling.md` promises changes value without this table changing
 * with it. A new bound is not blocked by this test — only a changed one is.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_REWORK_MAX_ROUNDS } from "../../src/foundation/constants.mjs";
import { SESSION_DEFAULTS } from "../../src/foundation/loop-state.mjs";
import { BOOT_BACKOFF_MS, BOOT_FAILURE_THRESHOLD } from "../../src/orchestrator/boot-health.mjs";
import {
  DEFERRAL_HOLD,
  DEFERRAL_HOLD_DISPATCH,
  DEFERRAL_THRESHOLD,
} from "../../src/orchestrator/deferrals.mjs";
import {
  DEFAULT_CARD_MAX_ATTEMPTS,
  DEFAULT_RECOVERY_MAX,
  TIMEOUT_BACKOFF_MS,
  TIMEOUT_MAX_ATTEMPTS,
} from "../../src/orchestrator/queue.mjs";
import { DIRECTOR_MAX_ATTEMPTS } from "../../src/orchestrator/session.mjs";
import { DEFAULT_REVIEW_REOPEN_MAX } from "../../src/core/domain/workflow.mjs";

describe("recovery inventory", () => {
  it("pins every bounded cycle to one exported constant", () => {
    // Card handoffs and their two independent counters.
    assert.equal(DEFAULT_CARD_MAX_ATTEMPTS, 3);
    assert.equal(TIMEOUT_MAX_ATTEMPTS, 3);
    assert.deepEqual(TIMEOUT_BACKOFF_MS, [2, 4, 8].map((minutes) => minutes * 60_000));
    assert.equal(DEFAULT_RECOVERY_MAX, 3);

    // The deferral ladder: alert at 3, hold at 5, dispatch holds at 3.
    assert.equal(DEFERRAL_THRESHOLD, 3);
    assert.equal(DEFERRAL_HOLD, 5);
    assert.equal(DEFERRAL_HOLD_DISPATCH, 3);

    // The director lane has a tighter bound than a worker handoff.
    assert.equal(DIRECTOR_MAX_ATTEMPTS, 2);

    // Review reopen and rework rounds are board-workflow bounds.
    assert.equal(DEFAULT_REVIEW_REOPEN_MAX, 2);
    assert.equal(DEFAULT_REWORK_MAX_ROUNDS, 4);

    // Boot health and the resident pool's own defaults.
    assert.equal(BOOT_FAILURE_THRESHOLD, 3);
    assert.deepEqual(BOOT_BACKOFF_MS, [5_000, 15_000, 60_000, 300_000]);
    assert.equal(SESSION_DEFAULTS.turnTimeoutMs, 60 * 60 * 1000);
    assert.equal(SESSION_DEFAULTS.maxConcurrency, 8);
  });
});
