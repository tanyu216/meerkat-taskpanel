/**
 * The one assignee predicate the board, the waiting queue and the activity
 * feed share (`web/src/lib/assignee-filter.js`).
 *
 * The value is the board's own (`board.filters.assignee`): the four static
 * choices plus a given name. This suite pins the semantics the board already
 * had, because the other two views now inherit them:
 *
 *   * `all`/`""`/`null` is no condition;
 *   * `me` is the local human's name;
 *   * `human`/`agent` ask the **kind** question, where a platform is an agent;
 *   * anything else is a given name, compared exactly;
 *   * an unassigned actor is in **neither** the human nor the agent row.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { actorMatches } from "../../web/src/lib/assignee-filter.js";

const ME = "Terry";

describe("actorMatches — the resting values", () => {
  it("passes everything for all, the empty string and null", () => {
    for (const value of ["all", "", null, undefined]) {
      assert.equal(actorMatches(value, "linus", "claude", ME), true);
      assert.equal(actorMatches(value, "", undefined, ME), true);
    }
  });
});

describe("actorMatches — me", () => {
  it("matches the local human's own name only", () => {
    assert.equal(actorMatches("me", "Terry", "human", ME), true);
    assert.equal(actorMatches("me", "linus", "claude", ME), false);
    assert.equal(actorMatches("me", "", undefined, ME), false);
  });
});

describe("actorMatches — the two kinds", () => {
  it("reads a platform kind as an agent", () => {
    assert.equal(actorMatches("agent", "linus", "claude", ME), true);
    assert.equal(actorMatches("agent", "linus", "cursor", ME), true);
    assert.equal(actorMatches("agent", "linus", "agent", ME), true);
    assert.equal(actorMatches("agent", "terry", "human", ME), false);
    assert.equal(actorMatches("human", "terry", "human", ME), true);
    assert.equal(actorMatches("human", "linus", "claude", ME), false);
  });

  it("puts an unassigned actor in neither row", () => {
    assert.equal(actorMatches("human", "", undefined, ME), false);
    assert.equal(actorMatches("agent", "", undefined, ME), false);
  });
});

describe("actorMatches — a given name", () => {
  it("matches exactly, case-sensitively", () => {
    assert.equal(actorMatches("linus", "linus", "claude", ME), true);
    assert.equal(actorMatches("Linus", "linus", "claude", ME), false);
    assert.equal(actorMatches("linus", "alice", "claude", ME), false);
    assert.equal(actorMatches("linus", "", undefined, ME), false);
  });
});
