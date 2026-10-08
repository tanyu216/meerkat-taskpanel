/**
 * Step 8: the claim decision (I1/I2), pure and clock-injected.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { CLAIM_ACTIONS, assertClaimable, decideClaim, explainLostClaim } from "../../../src/core/domain/claim.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const NOW = "2026-10-08T00:10:00.000Z";
const FRESH = "2026-10-08T00:05:00.000Z"; // 5 minutes old
const STALE = "2026-10-07T23:00:00.000Z"; // an hour old — nobody is working on that
const AT_THE_EDGE = "2026-10-08T00:00:00.000Z"; // exactly HEARTBEAT_FRESH_MS old

const task = (overrides = {}) => ({
  id: "task-1",
  identifier: "PROJ-0001",
  status: "todo",
  claimedBy: null,
  heartbeatAt: null,
  ...overrides,
});

describe("domain/claim — decide", () => {
  it("takes an unclaimed todo task", () => {
    assert.deepEqual(decideClaim(task(), { actor: "linus", now: NOW }), {
      action: CLAIM_ACTIONS.TAKE,
      code: null,
    });
  });

  it("reuses the same actor's fresh claim without resetting anything", () => {
    const held = task({ status: "in_progress", claimedBy: "linus", heartbeatAt: FRESH });
    const verdict = decideClaim(held, { actor: "linus", now: NOW });
    assert.equal(verdict.action, CLAIM_ACTIONS.REUSE);
    assert.equal(verdict.code, null);
    assert.equal(held.heartbeatAt, FRESH, "deciding is a pure read");
  });

  it("refuses somebody else's fresh claim (I2)", () => {
    const verdict = decideClaim(
      task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH }),
      { actor: "linus", now: NOW },
    );
    assert.equal(verdict.action, CLAIM_ACTIONS.CONFLICT);
    assert.equal(verdict.code, "EXECUTION_ACTIVE");
    assert.match(verdict.reason, /elon/);
  });

  it("flags in_progress with nobody claiming it as corruption (I2)", () => {
    for (const claimedBy of [null, undefined, ""]) {
      const verdict = decideClaim(task({ status: "in_progress", claimedBy }), { actor: "linus", now: NOW });
      assert.equal(verdict.action, CLAIM_ACTIONS.CORRUPT);
      assert.equal(verdict.code, "EXECUTION_STATE_CORRUPT");
    }
  });

  it("takes over a stale claim instead of blocking forever", () => {
    const stale = task({ status: "in_progress", claimedBy: "elon", heartbeatAt: "2026-10-07T23:00:00.000Z" });
    const mine = decideClaim(stale, { actor: "elon", now: NOW });
    assert.equal(mine.action, CLAIM_ACTIONS.TAKE);
    assert.equal(mine.steal, true);

    const theirs = decideClaim(stale, { actor: "linus", now: NOW });
    assert.equal(theirs.action, CLAIM_ACTIONS.TAKE);
    assert.equal(theirs.steal, true);
    assert.match(theirs.reason, /stale/);
  });

  it("honours the freshness window the caller passes", () => {
    const held = task({ status: "in_progress", claimedBy: "elon", heartbeatAt: STALE });
    assert.equal(decideClaim(held, { actor: "linus", now: NOW }).action, CLAIM_ACTIONS.TAKE);
    assert.equal(
      decideClaim(task({ status: "in_progress", claimedBy: "elon", heartbeatAt: AT_THE_EDGE }), {
        actor: "linus",
        now: NOW,
      }).action,
      CLAIM_ACTIONS.CONFLICT,
      "the window is inclusive at exactly HEARTBEAT_FRESH_MS",
    );
    assert.equal(
      decideClaim(held, { actor: "linus", now: NOW, freshMs: 24 * 60 * 60 * 1000 }).action,
      CLAIM_ACTIONS.CONFLICT,
      "a longer window makes the same heartbeat fresh",
    );
  });

  it("refuses anything that is not claimable", () => {
    for (const status of ["backlog", "in_review", "blocked", "done", "canceled"]) {
      const verdict = decideClaim(task({ status }), { actor: "linus", now: NOW });
      assert.equal(verdict.action, CLAIM_ACTIONS.INVALID, status);
      assert.equal(verdict.code, "INVALID_TRANSITION");
    }
  });
});

describe("domain/claim — the throw and the race explainer", () => {
  it("assertClaimable passes for a take and throws with the right code otherwise", () => {
    assert.equal(assertClaimable(task(), { actor: "linus", now: NOW }).action, CLAIM_ACTIONS.TAKE);

    assert.throws(
      () => assertClaimable(task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH }), { actor: "linus", now: NOW }),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "EXECUTION_ACTIVE");
        assert.equal(err.http, 409);
        assert.equal(err.details.claimedBy, "elon");
        assert.equal(err.details.actor, "linus");
        return true;
      },
    );
    assert.throws(
      () => assertClaimable(task({ status: "in_progress" }), { actor: "linus", now: NOW }),
      (err) => err.code === "EXECUTION_STATE_CORRUPT" && err.http === 500,
    );
    assert.throws(
      () => assertClaimable(task({ status: "done" }), { actor: "linus", now: NOW }),
      (err) => err.code === "INVALID_TRANSITION",
    );
  });

  it("explains a lost CAS by re-reading the row (I1)", () => {
    const before = task();

    const gone = explainLostClaim({ before, after: null, actor: "linus", now: NOW });
    assert.equal(gone.code, "NOT_FOUND");
    assert.equal(gone.http, 404);

    const raced = explainLostClaim({
      before,
      after: task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH }),
      actor: "linus",
      now: NOW,
    });
    assert.equal(raced.code, "EXECUTION_ACTIVE");
    assert.match(raced.message, /lost the claim race/);

    const versioned = explainLostClaim({
      before,
      after: task({ status: "todo", version: 4 }),
      actor: "linus",
      now: NOW,
      ifVersion: 1,
    });
    assert.equal(versioned.code, "VERSION_CONFLICT");
    assert.deepEqual(versioned.details, { taskId: "task-1", currentVersion: 4, expectedVersion: 1 });

    const unexplained = explainLostClaim({
      before,
      after: task({ status: "todo" }),
      actor: "linus",
      now: NOW,
    });
    assert.equal(unexplained.code, "CLAIM_LOST");
  });

  it("prefers the version conflict over the claim story when both changed", () => {
    const verdict = explainLostClaim({
      before: task(),
      after: task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH, version: 9 }),
      actor: "linus",
      now: NOW,
      ifVersion: 2,
    });
    assert.equal(verdict.code, "VERSION_CONFLICT");
  });
});
