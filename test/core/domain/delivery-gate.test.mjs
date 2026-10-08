/**
 * Step 10: the delivery gate as a pure decision (card A7).
 *
 * The database refuses the same thing through `tr_deliver_gate`; this module
 * exists so the refusal arrives with a repair command attached.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { assertDeliveryGate, checkDeliveryGate } from "../../../src/core/domain/delivery-gate.mjs";
import { STATUSES } from "../../../src/core/domain/enums.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const task = { id: "task-1", identifier: "PROJ-0007", deliveryRound: 1 };
const reports = (...rounds) => rounds.map((round) => ({ round }));

describe("domain/delivery-gate", () => {
  it("only ever speaks about entering in_review", () => {
    for (const to of STATUSES) {
      const verdict = checkDeliveryGate({ task, reports: [], to });
      assert.equal(verdict.ok, to !== "in_review", to);
    }
  });

  it("passes when the current round has a report", () => {
    assert.deepEqual(checkDeliveryGate({ task, reports: reports(1), to: "in_review" }), { ok: true });
    assert.deepEqual(
      checkDeliveryGate({ task: { ...task, deliveryRound: 2 }, reports: reports(1, 2), to: "in_review" }),
      { ok: true },
      "history does not hurt",
    );
  });

  it("refuses an empty report list and a round that is not the current one (F3)", () => {
    const empty = checkDeliveryGate({ task, reports: [], to: "in_review" });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "REPORT_REQUIRED");
    assert.equal(empty.round, 1);
    assert.deepEqual(empty.existingRounds, []);
    assert.equal(empty.hint.command, "taskctl issue deliver PROJ-0007 --report-file -");

    const stale = checkDeliveryGate({
      task: { ...task, deliveryRound: 2 },
      reports: reports(1, 1, 3),
      to: "in_review",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.round, 2);
    assert.deepEqual(stale.existingRounds, [1, 3], "duplicate rounds are collapsed and sorted");
  });

  it("tolerates a missing reports list", () => {
    assert.equal(checkDeliveryGate({ task, reports: undefined, to: "in_review" }).ok, false);
    assert.equal(checkDeliveryGate({ task, reports: null, to: "in_progress" }).ok, true);
  });
});

describe("domain/delivery-gate — the throw", () => {
  it("raises 422 REPORT_REQUIRED with the round, the history and the fix", () => {
    assert.throws(
      () => assertDeliveryGate({ task: { ...task, deliveryRound: 3 }, reports: reports(1, 2), to: "in_review" }),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "REPORT_REQUIRED");
        assert.equal(err.http, 422);
        assert.deepEqual(err.details, {
          taskId: "task-1",
          identifier: "PROJ-0007",
          round: 3,
          existingRounds: [1, 2],
        });
        assert.match(err.message, /round 3/);
        assert.match(err.message, /1, 2/);
        assert.equal(err.hint.command, "taskctl issue deliver PROJ-0007 --report-file -");
        return true;
      },
    );
  });

  it("says 'none' when no round has a report at all", () => {
    assert.throws(
      () => assertDeliveryGate({ task, reports: [], to: "in_review" }),
      (err) => /rounds on file: none/.test(err.message),
    );
    assert.equal(assertDeliveryGate({ task, reports: reports(1), to: "in_review" }), true);
    assert.equal(assertDeliveryGate({ task, reports: [], to: "done" }), true);
  });

  it("falls back to the internal id before an identifier exists", () => {
    assert.throws(
      () => assertDeliveryGate({ task: { id: "task-1", deliveryRound: 1 }, reports: [], to: "in_review" }),
      (err) => err.hint.command === "taskctl issue deliver task-1 --report-file -",
    );
  });

  it("never mentions a waiver (F4: the gate is hard)", () => {
    assert.throws(
      () => assertDeliveryGate({ task, reports: [], to: "in_review" }),
      (err) => {
        assert.equal(/waiv|no-report|--no-report/i.test(JSON.stringify(err.toJSON())), false);
        return true;
      },
    );
  });
});
