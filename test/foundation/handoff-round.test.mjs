/**
 * The handoff-round marker: one value, many spellings.
 *
 * The loop's triage prompt tells the director to record the created refs in the
 * marker's value (`handoff_consumed_round=3 (TP-0082)`), while every reader used
 * to run `Number(value)`. A value that carried its refs therefore read as NaN and
 * an already-consumed handoff was reported unconsumed. These cases pin the one
 * reading: the value starts with the round; anything after it is annotation.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markerMatches, markerRound } from "../../src/foundation/handoff-round.mjs";

describe("handoff round marker", () => {
  it("reads a bare round as a number or a string", () => {
    assert.equal(markerRound(3), 3);
    assert.equal(markerRound("3"), 3);
    assert.equal(markerRound(" 3 "), 3);
    assert.equal(markerRound("0"), 0);
  });

  it("reads the round when the value carries its annotation after it", () => {
    assert.equal(markerRound("3 (TP-0082)"), 3);
    assert.equal(markerRound("3 — TP-0082, TP-0090"), 3);
    assert.equal(markerRound(12), 12);
  });

  it("does not read a longer number, a decimal or an embedded round", () => {
    assert.equal(markerRound("13"), 13, "a two-digit round is its own round");
    assert.equal(markerRound("3.5"), null);
    assert.equal(markerRound("3x"), null);
    assert.equal(markerRound("round 3"), null);
    assert.equal(markerRound("r3 (TP-0082)"), null);
  });

  it("treats a missing, empty or negative value as no marker", () => {
    for (const value of [undefined, null, "", "   ", -1, "-3", 1.5, {}, []]) {
      assert.equal(markerRound(value), null, JSON.stringify(value));
    }
  });

  it("matches only the marker for the same round", () => {
    assert.equal(markerMatches("3 (TP-0082)", 3), true);
    assert.equal(markerMatches(3, "3"), true);
    assert.equal(markerMatches("3 (TP-0082)", 4), false);
    assert.equal(markerMatches("3 (TP-0082)", undefined), false);
    assert.equal(markerMatches(undefined, 3), false);
    assert.equal(markerMatches("13", 3), false);
  });
});
