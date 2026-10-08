/**
 * Step 2: the state machine, exhaustively.
 *
 * The expected whitelist below is written out independently of
 * `domain/status.mjs` (literal pairs, not a re-export) so a typo in the module
 * is a red test rather than a self-fulfilling assertion. All 7 × 7 = 49 pairs
 * are walked — that count is asserted so a future status cannot sneak in
 * without extending the table.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { STATUS, STATUSES } from "../../../src/core/domain/enums.mjs";
import {
  ALLOWED_TRANSITIONS,
  CLAIMABLE_STATUS,
  ROUND_BUMPING_EXITS,
  TERMINAL_STATUSES,
  allowedTargets,
  assertTransition,
  bumpsDeliveryRound,
  canTransition,
  isClaimable,
  isKnownStatus,
  isTerminalStatus,
  requiresReport,
  transitionReasonCode,
} from "../../../src/core/domain/status.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

/** F1 ruling, option A — transcribed from the card, not from the module. */
const EXPECTED_ALLOWED = {
  backlog: ["todo", "canceled"],
  todo: ["backlog", "in_progress", "blocked", "canceled"],
  in_progress: ["in_review", "blocked", "todo", "canceled"],
  in_review: ["done", "in_progress", "blocked"],
  blocked: ["todo", "in_progress", "in_review", "canceled"],
  done: [],
  canceled: [],
};

const ALL_PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to]));

describe("domain/status — the whitelist table", () => {
  it("has exactly 7 statuses and therefore exactly 49 ordered pairs", () => {
    assert.equal(STATUSES.length, 7);
    assert.equal(ALL_PAIRS.length, 49);
  });

  it("walks all 49 pairs against the F1 ruling", () => {
    assert.equal(ALL_PAIRS.length, 49);
    for (const [from, to] of ALL_PAIRS) {
      const expected = EXPECTED_ALLOWED[from].includes(to);
      assert.equal(
        canTransition(from, to),
        expected,
        `${from} → ${to} should be ${expected ? "allowed" : "rejected"}`,
      );
    }
  });

  it("never allows a self-transition and never allows a no-op out of a status", () => {
    for (const status of STATUSES) {
      assert.equal(canTransition(status, status), false, `${status} → ${status}`);
    }
  });

  it("makes done reachable ONLY from in_review", () => {
    const into = STATUSES.filter((from) => canTransition(from, STATUS.DONE));
    assert.deepEqual(into, [STATUS.IN_REVIEW]);
  });

  it("keeps both in_review exits that start a new delivery round (F3)", () => {
    assert.deepEqual([...ROUND_BUMPING_EXITS].sort(), ["blocked", "in_progress"]);
    assert.deepEqual(allowedTargets(STATUS.IN_REVIEW), ["done", "in_progress", "blocked"]);
    for (const [from, to] of ALL_PAIRS) {
      const expected = from === STATUS.IN_REVIEW && ROUND_BUMPING_EXITS.includes(to);
      assert.equal(bumpsDeliveryRound(from, to), expected, `bump ${from} → ${to}`);
    }
  });

  it("exposes the same table through ALLOWED_TRANSITIONS", () => {
    for (const status of STATUSES) {
      assert.deepEqual([...ALLOWED_TRANSITIONS[status]], EXPECTED_ALLOWED[status]);
      assert.deepEqual([...allowedTargets(status)], EXPECTED_ALLOWED[status]);
    }
    assert.deepEqual([...allowedTargets("nonsense")], []);
  });
});

describe("domain/status — terminals, claimability, gate", () => {
  it("marks done/canceled terminal and nothing else", () => {
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ["canceled", "done"]);
    for (const status of STATUSES) {
      assert.equal(isTerminalStatus(status), TERMINAL_STATUSES.includes(status), status);
    }
    assert.deepEqual(STATUSES.filter((s) => allowedTargets(s).length === 0), ["done", "canceled"]);
  });

  it("only todo is claimable, and only in_review demands a report", () => {
    assert.equal(CLAIMABLE_STATUS, "todo");
    assert.deepEqual(STATUSES.filter(isClaimable), ["todo"]);
    assert.deepEqual(STATUSES.filter(requiresReport), ["in_review"]);
  });

  it("recognises known statuses case-sensitively", () => {
    for (const status of STATUSES) assert.equal(isKnownStatus(status), true, status);
    for (const bad of ["", "READY", "Todo", "ready", "failed", null, 42]) {
      assert.equal(isKnownStatus(bad), false, String(bad));
    }
  });
});

describe("domain/status — rejection codes", () => {
  it("maps every rejected pair to the trigger's reason code", () => {
    let rejected = 0;
    for (const [from, to] of ALL_PAIRS) {
      const reason = transitionReasonCode(from, to);
      if (canTransition(from, to)) {
        assert.equal(reason, null, `${from} → ${to}`);
        continue;
      }
      rejected += 1;
      assert.equal(reason, isTerminalStatus(from) ? "TERMINAL_STATE" : "INVALID_TRANSITION");
    }
    assert.equal(rejected, 49 - 17, "49 pairs minus the 17 whitelisted ones");
  });

  it("assertTransition returns the target or throws a DomainError with that code", () => {
    assert.equal(assertTransition("todo", "in_progress"), "in_progress");

    assert.throws(
      () => assertTransition("done", "todo"),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "TERMINAL_STATE");
        assert.equal(err.http, 409);
        assert.deepEqual(err.details.allowed, []);
        return true;
      },
    );

    assert.throws(
      () => assertTransition("backlog", "done"),
      (err) => {
        assert.equal(err.code, "INVALID_TRANSITION");
        assert.deepEqual(err.details.allowed, ["todo", "canceled"]);
        return true;
      },
    );

    assert.throws(
      () => assertTransition("nope", "todo"),
      (err) => {
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.http, 400);
        return true;
      },
    );
  });
});
