/**
 * Step 8: the claim decision (I1/I2), pure and clock-injected.
 *
 * T-20261009-230500-claimassignee tightened what a claim means on the execution
 * side: a card routed to someone (`assignee`) may only be claimed by that
 * someone; an unassigned card is an open pool; a takeover is either the
 * documented `--allow-steal` or a claim stale for more than six hours — and both
 * are audited.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  CLAIM_ACTIONS,
  assertClaimable,
  decideClaim,
  explainLostClaim,
  isAssignee,
} from "../../../src/core/domain/claim.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

const NOW = "2026-10-08T00:10:00.000Z";
const FRESH = "2026-10-08T00:05:00.000Z"; // 5 minutes old
const MID = "2026-10-07T23:00:00.000Z"; // 70 minutes old — past fresh, before 6h
const VERY_STALE = "2026-10-07T12:00:00.000Z"; // 12h10m old — past the 6h window
const AT_THE_EDGE = "2026-10-08T00:00:00.000Z"; // exactly HEARTBEAT_FRESH_MS old

/** The dictionary entry `linus` — what `resolveAssignee` returns for the card. */
const LINUS = { id: "dict-linus", displayName: "Linus", normalizedName: "linus", kind: "agent" };
const resolveLinus = () => LINUS;
/** A card with no assignee resolves to `null` — an open pool. */
const resolveNone = () => null;

const task = (overrides = {}) => ({
  id: "task-1",
  identifier: "PROJ-0001",
  status: "todo",
  kind: "task",
  assigneeId: null,
  claimedBy: null,
  heartbeatAt: null,
  ...overrides,
});

describe("domain/claim — isAssignee", () => {
  it("treats an unassigned card as open to everyone", () => {
    assert.equal(isAssignee(task(), "anyone", resolveNone), true);
    assert.equal(isAssignee(task(), "anyone", null), true);
  });

  it("matches the actor against the dictionary entry, normalised", () => {
    const assigned = task({ assigneeId: "dict-linus" });
    assert.equal(isAssignee(assigned, "linus", resolveLinus), true, "lowercase actor vs display Linus");
    assert.equal(isAssignee(assigned, " LINUS ", resolveLinus), true, "trim + case fold");
    assert.equal(isAssignee(assigned, "dict-linus", resolveLinus), true, "the dictionary id also names it");
    assert.equal(isAssignee(assigned, "elon", resolveLinus), false);
  });
});

describe("domain/claim — decide", () => {
  it("takes an unclaimed, unassigned todo task", () => {
    assert.deepEqual(decideClaim(task(), { actor: "linus", now: NOW, resolveAssignee: resolveNone }), {
      action: CLAIM_ACTIONS.TAKE,
      code: null,
    });
  });

  it("lets the assignee claim their own card (normalised identity)", () => {
    const verdict = decideClaim(task({ assigneeId: "dict-linus" }), {
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveLinus,
    });
    assert.equal(verdict.action, CLAIM_ACTIONS.TAKE);
    assert.equal(verdict.code, null);
  });

  it("refuses a card assigned to somebody else (not_assignee)", () => {
    const verdict = decideClaim(task({ assigneeId: "dict-linus" }), {
      actor: "elon",
      now: NOW,
      resolveAssignee: resolveLinus,
    });
    assert.equal(verdict.action, CLAIM_ACTIONS.INVALID);
    assert.equal(verdict.code, "not_assignee");
    assert.match(verdict.reason, /Linus|assignee/);
  });

  it("takes somebody else's card with allowSteal, recording who it came from", () => {
    const verdict = decideClaim(task({ assigneeId: "dict-linus" }), {
      actor: "elon",
      now: NOW,
      resolveAssignee: resolveLinus,
      allowSteal: true,
    });
    assert.equal(verdict.action, CLAIM_ACTIONS.TAKE);
    assert.equal(verdict.code, null);
    assert.equal(verdict.steal, true);
    assert.equal(verdict.stolenFrom, "Linus");
  });

  it("refuses an epic — a grouping card is never claimed", () => {
    for (const resolveAssignee of [resolveNone, resolveLinus]) {
      const verdict = decideClaim(task({ kind: "epic", assigneeId: "dict-linus" }), {
        actor: "linus",
        now: NOW,
        resolveAssignee,
        allowSteal: true,
      });
      assert.equal(verdict.action, CLAIM_ACTIONS.INVALID);
      assert.equal(verdict.code, "not_claimable");
    }
  });

  it("refuses backlog and every other non-todo status", () => {
    for (const status of ["backlog", "in_review", "blocked", "done", "canceled"]) {
      const verdict = decideClaim(task({ status }), { actor: "linus", now: NOW, resolveAssignee: resolveNone });
      assert.equal(verdict.action, CLAIM_ACTIONS.INVALID, status);
      assert.equal(verdict.code, "INVALID_TRANSITION", status);
    }
  });
});

describe("domain/claim — the in_progress windows", () => {
  const held = (overrides = {}) => task({ status: "in_progress", claimedBy: "elon", ...overrides });

  it("reuses the same actor's fresh claim without resetting anything", () => {
    const row = held({ claimedBy: "linus", heartbeatAt: FRESH });
    const verdict = decideClaim(row, { actor: "linus", now: NOW, resolveAssignee: resolveNone });
    assert.equal(verdict.action, CLAIM_ACTIONS.REUSE);
    assert.equal(verdict.code, null);
    assert.equal(row.heartbeatAt, FRESH, "deciding is a pure read");
  });

  it("refuses somebody else's fresh claim (I2)", () => {
    const verdict = decideClaim(held({ heartbeatAt: FRESH }), { actor: "linus", now: NOW, resolveAssignee: resolveNone });
    assert.equal(verdict.action, CLAIM_ACTIONS.CONFLICT);
    assert.equal(verdict.code, "EXECUTION_ACTIVE");
    assert.match(verdict.reason, /elon/);
  });

  it("flags in_progress with nobody claiming it as corruption (I2)", () => {
    for (const claimedBy of [null, undefined, ""]) {
      const verdict = decideClaim(task({ status: "in_progress", claimedBy }), {
        actor: "linus",
        now: NOW,
        resolveAssignee: resolveNone,
      });
      assert.equal(verdict.action, CLAIM_ACTIONS.CORRUPT);
      assert.equal(verdict.code, "EXECUTION_STATE_CORRUPT");
    }
  });

  it("only the holder may re-claim between 10 minutes and 6 hours", () => {
    const mine = decideClaim(held({ claimedBy: "linus", heartbeatAt: MID }), {
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
    });
    assert.equal(mine.action, CLAIM_ACTIONS.TAKE);
    assert.equal(mine.reclaim, true);
    assert.notEqual(mine.steal, true, "a holder's own re-claim is not an audited steal");

    const theirs = decideClaim(held({ heartbeatAt: MID }), { actor: "linus", now: NOW, resolveAssignee: resolveNone });
    assert.equal(theirs.action, CLAIM_ACTIONS.CONFLICT);
    assert.equal(theirs.code, "EXECUTION_ACTIVE");
  });

  it("anybody may take a claim older than six hours, and it is audited", () => {
    const verdict = decideClaim(held({ heartbeatAt: VERY_STALE }), {
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
    });
    assert.equal(verdict.action, CLAIM_ACTIONS.TAKE);
    assert.equal(verdict.reclaim, true);
    assert.equal(verdict.steal, true);
    assert.equal(verdict.stolenFrom, "elon");
    assert.match(verdict.reason, /stale/);
  });

  it("honours the freshness window the caller passes", () => {
    const atEdge = decideClaim(task({ status: "in_progress", claimedBy: "elon", heartbeatAt: AT_THE_EDGE }), {
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
    });
    assert.equal(atEdge.action, CLAIM_ACTIONS.CONFLICT, "the window is inclusive at exactly HEARTBEAT_FRESH_MS");

    const wider = decideClaim(held({ heartbeatAt: MID }), {
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
      freshMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(wider.action, CLAIM_ACTIONS.CONFLICT, "a longer window makes the same heartbeat fresh");
  });
});

describe("domain/claim — the throw and the race explainer", () => {
  it("assertClaimable passes for a take and throws with the right code otherwise", () => {
    assert.equal(
      assertClaimable(task(), { actor: "linus", now: NOW, resolveAssignee: resolveNone }).action,
      CLAIM_ACTIONS.TAKE,
    );

    assert.throws(
      () =>
        assertClaimable(task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH }), {
          actor: "linus",
          now: NOW,
          resolveAssignee: resolveNone,
        }),
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
      () =>
        assertClaimable(task({ status: "in_progress" }), { actor: "linus", now: NOW, resolveAssignee: resolveNone }),
      (err) => err.code === "EXECUTION_STATE_CORRUPT" && err.http === 500,
    );
    assert.throws(
      () => assertClaimable(task({ status: "done" }), { actor: "linus", now: NOW, resolveAssignee: resolveNone }),
      (err) => err.code === "INVALID_TRANSITION",
    );
  });

  it("throws not_assignee with the --allow-steal hint for somebody else's card", () => {
    assert.throws(
      () =>
        assertClaimable(task({ assigneeId: "dict-linus" }), {
          actor: "elon",
          now: NOW,
          resolveAssignee: resolveLinus,
        }),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "not_assignee");
        assert.equal(err.http, 409);
        assert.equal(err.details.assignee, "dict-linus");
        assert.match(err.hint.fix, /--allow-steal/);
        return true;
      },
    );
  });

  it("throws not_claimable for an epic", () => {
    assert.throws(
      () => assertClaimable(task({ kind: "epic" }), { actor: "linus", now: NOW, resolveAssignee: resolveNone }),
      (err) => err.code === "not_claimable" && err.http === 409,
    );
  });

  it("explains a lost CAS by re-reading the row (I1)", () => {
    const before = task();

    const gone = explainLostClaim({ before, after: null, actor: "linus", now: NOW, resolveAssignee: resolveNone });
    assert.equal(gone.code, "NOT_FOUND");
    assert.equal(gone.http, 404);

    const raced = explainLostClaim({
      before,
      after: task({ status: "in_progress", claimedBy: "elon", heartbeatAt: FRESH }),
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
    });
    assert.equal(raced.code, "EXECUTION_ACTIVE");
    assert.match(raced.message, /lost the claim race/);

    const versioned = explainLostClaim({
      before,
      after: task({ status: "todo", version: 4 }),
      actor: "linus",
      now: NOW,
      ifVersion: 1,
      resolveAssignee: resolveNone,
    });
    assert.equal(versioned.code, "VERSION_CONFLICT");
    assert.deepEqual(versioned.details, { taskId: "task-1", currentVersion: 4, expectedVersion: 1 });

    const unexplained = explainLostClaim({
      before,
      after: task({ status: "todo" }),
      actor: "linus",
      now: NOW,
      resolveAssignee: resolveNone,
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
      resolveAssignee: resolveNone,
    });
    assert.equal(verdict.code, "VERSION_CONFLICT");
  });
});
