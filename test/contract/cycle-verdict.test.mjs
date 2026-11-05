/**
 * The settled ladder is a contract: four names, one fixed precedence.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CYCLE_LEVELS, cycleVerdict } from "../../src/foundation/cycle-status.mjs";

describe("settled ladder contract", () => {
  it("pins the four settled levels and their precedence", () => {
    assert.deepEqual(CYCLE_LEVELS, ["terminal", "settled", "needs_human", "in_flight"]);

    const representatives = [
      [{ cardStatus: "done" }, "terminal"],
      [{ cardStatus: "in_review", rowStatus: "done" }, "settled"],
      [{ cardStatus: "in_progress", rowStatus: "failed" }, "needs_human"],
      [{ cardStatus: "in_progress", rowStatus: "pending" }, "in_flight"],
    ];
    for (const [input, level] of representatives) {
      assert.equal(cycleVerdict(input).level, level, JSON.stringify(input));
    }

    // The order is the contract, not a coincidence: a terminal card is terminal
    // whatever its row says, a finished row is settled even with spent counters,
    // and a spent counter outranks a still-queued row.
    assert.equal(
      cycleVerdict({ cardStatus: "done", rowStatus: "failed", attempts: 99 }).level,
      "terminal",
    );
    assert.equal(
      cycleVerdict({ cardStatus: "in_review", rowStatus: "done", attempts: 99 }).level,
      "settled",
    );
    assert.equal(
      cycleVerdict({ cardStatus: "in_progress", rowStatus: "pending", attempts: 3 }).level,
      "needs_human",
    );
  });
});
