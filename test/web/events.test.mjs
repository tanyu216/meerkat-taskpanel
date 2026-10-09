/**
 * SSE client logic (F4), browser-free.
 *
 * The cursor rule and the "what does an activity mean" rule are pure functions
 * in `web/src/lib/events.js`; the `EventSource` wrapper is a thin shell. These
 * tests pin the pure half — most importantly that the cursor never moves
 * backwards, which is what makes a reconnect safe.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { advanceCursor, eventTargets, resyncQuery } from "../../web/src/lib/events.js";

describe("web/events — the cursor", () => {
  it("takes the first revision as the starting cursor", () => {
    assert.equal(advanceCursor(null, 7), 7);
    assert.equal(advanceCursor(undefined, "12"), 12);
  });

  it("never moves backwards (a replay can resend an older frame)", () => {
    assert.equal(advanceCursor(10, 9), 10);
    assert.equal(advanceCursor(10, 10), 10);
    assert.equal(advanceCursor(10, 11), 11);
  });

  it("ignores a non-numeric id rather than corrupting the cursor", () => {
    assert.equal(advanceCursor(5, "abc"), 5);
    assert.equal(advanceCursor(5, null), 5);
    assert.equal(advanceCursor(5, undefined), 5);
  });
});

describe("web/events — what an activity targets", () => {
  it("scopes a task event to that task (an incremental refresh)", () => {
    assert.deepEqual(eventTargets({ task_id: "td_1", event: "task_updated" }), { scope: "task", taskId: "td_1" });
  });

  it("scopes a task-less event to the whole board (a full reload)", () => {
    assert.deepEqual(eventTargets({ task_id: null, event: "project_updated" }), { scope: "all", taskId: null });
    assert.deepEqual(eventTargets({ event: "schema" }), { scope: "all", taskId: null });
    assert.deepEqual(eventTargets(null), { scope: "all", taskId: null });
  });
});

describe("web/events — resync query", () => {
  it("quotes the cursor back as ?after=", () => {
    assert.equal(resyncQuery(42), "?after=42");
    assert.equal(resyncQuery("42"), "?after=42");
  });

  it("omits the parameter when there is no cursor yet", () => {
    assert.equal(resyncQuery(null), "");
    assert.equal(resyncQuery(undefined), "");
    assert.equal(resyncQuery("nope"), "");
  });
});
