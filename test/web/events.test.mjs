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

import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  SHUTDOWN_EVENT,
  advanceCursor,
  backoffDelay,
  detailRefetch,
  invalidatesWaitingPayload,
  isKnownEvent,
  resyncQuery,
  taskEventNeedsRefresh,
  tasklessNeedsReload,
} from "../../web/src/lib/events.js";
import { SSE_SHUTDOWN_EVENT } from "../../src/foundation/constants.mjs";

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

describe("web/events — the refresh map", () => {
  it("distinguishes a card edit from a sub-resource edit", () => {
    assert.equal(taskEventNeedsRefresh("task_updated"), true);
    assert.equal(taskEventNeedsRefresh("task_moved"), true);
    assert.equal(taskEventNeedsRefresh("task_reopened"), true);
    assert.equal(taskEventNeedsRefresh("task_resumed"), true, "a human answer re-queues the card");
    assert.equal(taskEventNeedsRefresh("comment_added"), false);
    assert.equal(taskEventNeedsRefresh("attachment_added"), false);
    assert.equal(taskEventNeedsRefresh("project_updated"), false);
  });

  it("maps each event to the drawer resources it invalidates", () => {
    assert.deepEqual(detailRefetch({ event: "comment_added" }), ["comments", "activities"]);
    assert.deepEqual(detailRefetch({ event: "relation_added" }), ["relations", "activities"]);
    assert.deepEqual(detailRefetch({ event: "report_written" }), ["reports", "activities"]);
    assert.deepEqual(detailRefetch({ event: "session_registered" }), ["sessions", "activities"]);
    assert.deepEqual(detailRefetch({ event: "attachment_removed" }), ["attachments", "activities"]);
    assert.deepEqual(detailRefetch({ event: "progress" }), ["activities"]);
    assert.deepEqual(detailRefetch({ event: "task_moved" }), ["activities"]);
    assert.deepEqual(detailRefetch({ event: "task_reopened" }), ["activities"]);
    assert.deepEqual(detailRefetch({ event: "unknown" }), ["activities"]);
    // The task row is never a drawer read: `refreshTask` owns it for both
    // surfaces, so one event costs one `GET /tasks/:ref`.
    for (const event of ["task_created", "task_updated", "report_written", "epic_auto_start", "unknown"]) {
      assert.equal(detailRefetch({ event }).includes("task"), false, event);
    }
  });

  it("invalidates the waiting payload only when the question can change", () => {
    for (const event of ["comment_added", "task_moved", "task_reopened", "task_resumed", "task_updated", "task_created", "task_archived"]) {
      assert.equal(invalidatesWaitingPayload(event), true, event);
    }
    for (const event of ["relation_added", "session_closed", "attachment_added", "project_updated"]) {
      assert.equal(invalidatesWaitingPayload(event), false, event);
    }
  });

  it("reloads shared lists for a known task-less event, and for an unknown one", () => {
    assert.equal(tasklessNeedsReload("project_updated"), true);
    assert.equal(tasklessNeedsReload("import_completed"), true);
    assert.equal(tasklessNeedsReload("brand_new_event"), true);
    assert.equal(tasklessNeedsReload("task_created"), false);
  });

  it("knows its own vocabulary but does not pretend to know another", () => {
    assert.equal(isKnownEvent("task_created"), true);
    assert.equal(isKnownEvent("task_resumed"), true, "a resume is not an unknown-event warning");
    assert.equal(isKnownEvent("attachment_added"), true);
    // The acceptance/review rows refresh the card through the same set; they
    // used to fall through the unknown-event branch.
    assert.equal(isKnownEvent("acceptance_changed"), true);
    assert.equal(isKnownEvent("acceptance_pruned"), true);
    assert.equal(isKnownEvent("review_override"), true);
    assert.equal(taskEventNeedsRefresh("acceptance_pruned"), true);
    assert.equal(taskEventNeedsRefresh("review_override"), true);
    assert.equal(isKnownEvent("brand_new_event"), false);
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

describe("web/events — the reconnect ladder (T-20261014-213238)", () => {
  it("doubles from the base and holds at the cap", () => {
    assert.equal(backoffDelay(0), RECONNECT_BASE_MS);
    assert.equal(backoffDelay(1), 2 * RECONNECT_BASE_MS);
    assert.equal(backoffDelay(2), 4 * RECONNECT_BASE_MS);
    assert.equal(backoffDelay(3), 8 * RECONNECT_BASE_MS);
    assert.equal(backoffDelay(4), 16 * RECONNECT_BASE_MS);
    assert.equal(backoffDelay(5), RECONNECT_MAX_MS, "32s is past the cap, so it holds there");
    assert.equal(backoffDelay(50), RECONNECT_MAX_MS, "a long outage does not climb forever");
  });

  it("never returns an unusable delay", () => {
    // A nonsense attempt is attempt 0, and the cap can never be below the base.
    assert.equal(backoffDelay(-1), RECONNECT_BASE_MS);
    assert.equal(backoffDelay(Number.NaN), RECONNECT_BASE_MS);
    assert.equal(backoffDelay(1.7), 2 * RECONNECT_BASE_MS);
    assert.equal(backoffDelay(3, 100, 50), 100, "a max below the base is the base");
  });

  it("scales off the injected base (the shell's knob, exercised here)", () => {
    assert.equal(backoffDelay(0, 250, 1_000), 250);
    assert.equal(backoffDelay(1, 250, 1_000), 500);
    assert.equal(backoffDelay(2, 250, 1_000), 1_000);
    assert.equal(backoffDelay(3, 250, 1_000), 1_000);
  });

  it("names the frame the server sends as it stops — spelled the same on both sides", () => {
    // The web tree and the engine are separate builds, so the client cannot
    // import the server's constant; this is the one place the two meet, and it
    // is a test rather than a comment precisely so a rename cannot half-land.
    assert.equal(SHUTDOWN_EVENT, SSE_SHUTDOWN_EVENT);
  });
});
