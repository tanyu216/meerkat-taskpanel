/**
 * B09 · the drawer's property-edit rules (TP-0075 round 2).
 *
 * The board's people rows do not all stay editable for a card's whole life:
 * Terry's ruling of 2026-11-04 makes the assignee settle once work starts —
 * it may be changed only while the card is `backlog` or `todo` — and the
 * reporter is never editable in the drawer at all (it is decided at creation).
 *
 * The judgement is a pure status predicate so the truth table is asserted
 * without a browser; the rendered `disabled`/read-only shapes are the browser
 * leg's job (`web/scripts/dom-smoke.mjs`, run by `blocks.dom.test.mjs`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ASSIGNEE_EDITABLE_STATUSES, assigneeEditable } from "../../web/src/lib/detail-edit.js";

describe("web/detail-edit — the assignee's edit window", () => {
  it("allows exactly the two not-yet-started stages", () => {
    assert.deepEqual([...ASSIGNEE_EDITABLE_STATUSES], ["backlog", "todo"]);
    assert.equal(assigneeEditable("backlog"), true);
    assert.equal(assigneeEditable("todo"), true);
  });

  it("closes the row once the card is in flight, parked or finished", () => {
    for (const status of ["in_progress", "in_review", "blocked", "done", "canceled", "awaiting"]) {
      assert.equal(assigneeEditable(status), false, `${status} must be read-only`);
    }
  });

  it("treats a missing or unknown status as read-only", () => {
    for (const status of [undefined, null, "", "nonsense", 0]) {
      assert.equal(assigneeEditable(status), false, `${JSON.stringify(status)} must be read-only`);
    }
  });
});
