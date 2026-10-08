/**
 * Step 2: priority parsing and sorting.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { PRIORITIES } from "../../../src/core/domain/enums.mjs";
import {
  DEFAULT_PRIORITY,
  PRIORITY_RANK,
  comparePriority,
  isPriority,
  parsePriority,
  priorityRank,
} from "../../../src/core/domain/priority.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

describe("domain/priority", () => {
  it("parses canonical values and defaults on empty-ish input", () => {
    assert.equal(DEFAULT_PRIORITY, "medium");
    for (const p of PRIORITIES) assert.equal(parsePriority(p), p, p);
    assert.equal(parsePriority("  Urgent "), "urgent", "case + whitespace normalised");
    assert.equal(parsePriority(null), "medium");
    assert.equal(parsePriority(undefined), "medium");
    assert.equal(parsePriority(""), "medium");
    assert.equal(parsePriority(null, { fallback: null }), null, "explicit fallback");
    assert.equal(parsePriority("", { fallback: null }), null);
  });

  it("rejects unknown or non-string values with VALIDATION_FAILED", () => {
    assert.throws(() => parsePriority("blocker"), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details.allowed, [...PRIORITIES]);
      return true;
    });
    assert.throws(() => parsePriority(3), (err) => err.code === "VALIDATION_FAILED");
    assert.throws(() => parsePriority({}), DomainError);
  });

  it("recognises only the four canonical priorities", () => {
    assert.deepEqual(PRIORITIES.filter(isPriority), [...PRIORITIES]);
    assert.equal(isPriority("URGENT"), false);
    assert.equal(isPriority(1), false);
  });

  it("sorts most urgent first and is deterministic on ties", () => {
    const shuffled = ["low", "urgent", "medium", "high", "low"];
    assert.deepEqual([...shuffled].sort(comparePriority), [
      "urgent",
      "high",
      "medium",
      "low",
      "low",
    ]);
    assert.equal(comparePriority("high", "high"), 0);
    assert.ok(PRIORITY_RANK.urgent > PRIORITY_RANK.high);
    assert.ok(comparePriority("low", "urgent") > 0, "low sorts after urgent");
  });

  it("ranks unknown values as medium so rollups never explode", () => {
    assert.equal(priorityRank("urgent"), 3);
    assert.equal(priorityRank("nonsense"), PRIORITY_RANK.medium);
    assert.equal(priorityRank(undefined), PRIORITY_RANK.medium);
  });
});
