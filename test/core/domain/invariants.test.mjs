/**
 * Step 6: the invariant registry — six entries, each naming the reason code the
 * schema and the service both raise.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  INVARIANTS,
  assertCommentAppendOnly,
  assertNotTerminal,
  invariantById,
  invariantIds,
} from "../../../src/core/domain/invariants.mjs";
import { ERROR_CODES } from "../../../src/shared/errors.mjs";

describe("domain/invariants", () => {
  it("registers exactly I1..I6", () => {
    assert.deepEqual(invariantIds(), ["I1", "I2", "I3", "I4", "I5", "I6"]);
    for (const [key, invariant] of Object.entries(INVARIANTS)) {
      assert.equal(invariant.id, key, "the key and the id must agree");
      assert.match(invariant.name, /^[a-z-]+$/);
      assert.ok(invariant.statement.length > 20, `${key} needs a real statement`);
      assert.ok(Object.hasOwn(ERROR_CODES, invariant.reason), `${key} → ${invariant.reason}`);
    }
  });

  it("maps the reason codes the acceptance criteria name", () => {
    assert.equal(INVARIANTS.I1.reason, "CLAIM_LOST");
    assert.equal(INVARIANTS.I2.reason, "EXECUTION_ACTIVE");
    assert.equal(INVARIANTS.I3.reason, "TERMINAL_STATE");
    assert.equal(INVARIANTS.I4.reason, "COMMENT_APPEND_ONLY");
    assert.equal(INVARIANTS.I5.reason, "COMMENT_APPEND_ONLY");
    assert.equal(INVARIANTS.I6.reason, "ARCHIVE_NOT_TERMINAL");
    for (const id of invariantIds()) assert.equal(invariantById(id), INVARIANTS[id]);
    assert.throws(() => invariantById("I7"), (err) => err.code === "VALIDATION_FAILED");
  });

  it("refuses to rewrite history in the JS layer too (I4)", () => {
    for (const operation of ["update", "delete"]) {
      assert.throws(() => assertCommentAppendOnly(operation, { id: "c1" }), (err) => {
        assert.equal(err.code, "COMMENT_APPEND_ONLY");
        assert.equal(err.http, 409);
        assert.equal(err.details.operation, operation);
        assert.match(err.hint.fix, /kind 'change'/);
        return true;
      });
    }
  });

  it("refuses to leave a terminal state (I3)", () => {
    assert.equal(assertNotTerminal("in_progress", "in_review"), true);
    for (const from of ["done", "canceled"]) {
      assert.throws(() => assertNotTerminal(from, "todo"), (err) => {
        assert.equal(err.code, "TERMINAL_STATE");
        assert.deepEqual(err.details, { from, to: "todo" });
        return true;
      });
    }
  });
});
