/**
 * The cycle verdict: one name for "is this round done?" with fixed precedence.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CYCLE_LEVELS,
  cycleVerdict,
  groupQueueRowsByCard,
  newestRow,
} from "../../src/foundation/cycle-status.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("cycle verdict", () => {
  it("pins the four levels in precedence order", () => {
    assert.deepEqual(CYCLE_LEVELS, ["terminal", "settled", "needs_human", "in_flight"]);
  });

  it("calls a terminal card terminal, whatever its row says", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "done", now: NOW }), {
      level: "terminal",
      reason: "card_terminal",
    });
    assert.deepEqual(cycleVerdict({ cardStatus: "canceled", rowStatus: "failed", now: NOW }), {
      level: "terminal",
      reason: "card_terminal",
    });
  });

  it("calls a finished row settled even when its counters are spent", () => {
    assert.deepEqual(
      cycleVerdict({
        cardStatus: "in_review",
        rowStatus: "done",
        attempts: 9,
        timeouts: 9,
        recoveries: 9,
        now: NOW,
      }),
      { level: "settled", reason: "row_done" },
    );
  });

  it("asks a human about a failed row", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "in_progress", rowStatus: "failed", now: NOW }), {
      level: "needs_human",
      reason: "row_failed",
    });
  });

  it("asks a human when an attempt bound is spent", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "in_progress", attempts: 3, now: NOW }), {
      level: "needs_human",
      reason: "handoff_attempts",
    });
    assert.deepEqual(
      cycleVerdict({ cardStatus: "in_progress", attempts: 2, maxAttempts: 2, now: NOW }),
      { level: "needs_human", reason: "handoff_attempts" },
      "the caller passes the director's tighter bound",
    );
  });

  it("asks a human when the timeout or crash budget is spent", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "in_progress", timeouts: 3, now: NOW }), {
      level: "needs_human",
      reason: "turn_timeouts",
    });
    assert.deepEqual(cycleVerdict({ cardStatus: "in_progress", recoveries: 3, now: NOW }), {
      level: "needs_human",
      reason: "crash_recoveries",
    });
  });

  it("keeps a retrying row in flight", () => {
    assert.deepEqual(
      cycleVerdict({
        cardStatus: "in_progress",
        rowStatus: "pending",
        retryAt: new Date(NOW + 60_000).toISOString(),
        now: NOW,
      }),
      { level: "in_flight", reason: "backoff" },
    );
    for (const rowStatus of ["pending", "processing", "dispatched"]) {
      assert.deepEqual(cycleVerdict({ cardStatus: "in_progress", rowStatus, now: NOW }), {
        level: "in_flight",
        reason: "queued",
      });
    }
  });

  it("treats an unparseable retry time as due, not as a backoff", () => {
    assert.deepEqual(
      cycleVerdict({ cardStatus: "in_progress", rowStatus: "pending", retryAt: "soon", now: NOW }),
      { level: "in_flight", reason: "queued" },
    );
    assert.deepEqual(
      cycleVerdict({
        cardStatus: "in_progress",
        rowStatus: "pending",
        retryAt: new Date(NOW - 60_000).toISOString(),
        now: NOW,
      }),
      { level: "in_flight", reason: "queued" },
      "a past retry time is already due",
    );
  });

  it("asks a human about a live card with no row behind it", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "todo", now: NOW }), {
      level: "needs_human",
      reason: "unclaimed",
    });
  });

  it("falls back to needs_human/unknown instead of throwing", () => {
    assert.deepEqual(cycleVerdict({ cardStatus: "todo", rowStatus: "mystery", now: NOW }), {
      level: "needs_human",
      reason: "unknown",
    });
    assert.deepEqual(cycleVerdict({ now: NOW }), { level: "needs_human", reason: "unknown" });
    assert.deepEqual(cycleVerdict(), { level: "needs_human", reason: "unknown" });
  });
});

describe("cycle grouping", () => {
  it("groups rows by card and picks the newest", () => {
    const rows = [
      { card: "T-1", status: "pending", id: "a" },
      { card: "T-2", status: "pending", id: "b" },
      { card: "T-1", status: "processing", id: "c" },
    ];
    const groups = groupQueueRowsByCard(rows);
    assert.deepEqual([...groups.keys()].sort(), ["T-1", "T-2"]);
    assert.equal(groups.get("T-1").length, 2);
    assert.equal(newestRow(groups.get("T-1")).id, "c");
  });

  it("ignores rows with no card and survives a missing list", () => {
    assert.equal(groupQueueRowsByCard([{ card: "", id: "x" }]).size, 0);
    assert.equal(groupQueueRowsByCard(null).size, 0);
    assert.equal(newestRow([]), null);
  });
});
