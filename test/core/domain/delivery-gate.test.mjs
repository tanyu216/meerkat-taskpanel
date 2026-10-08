/**
 * Step 10: the delivery gate as a pure decision (card A7).
 *
 * The database refuses the same thing through `tr_deliver_gate`; this module
 * exists so the refusal arrives with a repair command attached.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  WAIVER_MIN_REASON_CHARS,
  assertDeliveryGate,
  assertWaiverRequest,
  checkDeliveryGate,
  waiverCovers,
} from "../../../src/core/domain/delivery-gate.mjs";
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

  it("leads with the compliant command and offers the audited waiver second (M2 F-B1)", () => {
    assert.throws(
      () => assertDeliveryGate({ task, reports: [], to: "in_review" }),
      (err) => {
        assert.equal(err.hint.command, "taskctl issue deliver PROJ-0007 --report-file -");
        assert.match(err.hint.alternative, /--no-report --reason/);
        assert.match(err.hint.note, /report_waived/);
        return true;
      },
    );
  });
});

describe("domain/delivery-gate — the waiver (M2 F-B1)", () => {
  const REASON = "hotfix: report follows in a change comment";

  it("accepts a waiver for the current round only, and only with a real reason", () => {
    assert.deepEqual(
      checkDeliveryGate({ task, reports: [], to: "in_review", waiver: { round: 1, reason: REASON } }),
      { ok: true, waived: true },
    );

    const round2 = { ...task, deliveryRound: 2 };
    assert.equal(
      checkDeliveryGate({ task: round2, reports: [], to: "in_review", waiver: { round: 1, reason: REASON } }).ok,
      false,
      "last round's waiver is dead once work resumes (round 2)",
    );
  });

  it("refuses a short, empty or missing reason", () => {
    for (const reason of [undefined, null, "", "   ", "short", "1234567"]) {
      assert.equal(
        checkDeliveryGate({ task, reports: [], to: "in_review", waiver: { round: 1, reason } }).ok,
        false,
        JSON.stringify(reason),
      );
    }
    // Exactly WAIVER_MIN_REASON_CHARS characters is enough — the boundary the
    // SQL trigger mirrors.
    assert.equal(
      checkDeliveryGate({ task, reports: [], to: "in_review", waiver: { round: 1, reason: "12345678" } }).ok,
      true,
    );
  });

  it("still passes on a report even when a waiver is offered", () => {
    assert.deepEqual(
      checkDeliveryGate({ task, reports: reports(1), to: "in_review", waiver: { round: 1, reason: REASON } }),
      { ok: true },
      "a report is the normal path; it is not marked waived",
    );
  });

  it("validates the waiver request before anything is written", () => {
    assert.equal(assertWaiverRequest({ reason: REASON, to: "in_review" }), REASON, "trimmed and returned");
    assert.equal(assertWaiverRequest({ reason: `  ${REASON}  `, to: "in_review" }), REASON);

    assert.throws(() => assertWaiverRequest({ reason: "short", to: "in_review" }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.equal(err.details.field, "reason");
      assert.equal(err.details.minLength, WAIVER_MIN_REASON_CHARS);
      return true;
    });
    assert.throws(() => assertWaiverRequest({ reason: REASON, to: "done" }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details.allowed, ["in_review"]);
      return true;
    });
    assert.throws(() => assertWaiverRequest({ reason: REASON, to: "in_review", hasReport: true }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.deepEqual(err.details.fields, ["noReport", "report"]);
      return true;
    });
  });

  it("pins the minimum reason length that the SQL trigger also enforces", () => {
    assert.equal(WAIVER_MIN_REASON_CHARS, 8);
    assert.equal(waiverCovers({ round: 1, reason: "1234567" }, 1), false);
    assert.equal(waiverCovers({ round: 1, reason: "12345678" }, 1), true);
    assert.equal(waiverCovers({ round: 1, reason: "x".repeat(8) }, 2), false);
    assert.equal(waiverCovers(null, 1), false);
  });
});
