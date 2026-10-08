/**
 * Step 9: comments — the append-only record, and the human decision trail (I4/I5).
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  COMMENT_COLUMNS,
  commentFromRow,
  commentToRow,
  isCommentKind,
  isDecisionComment,
  normalizeCommentCreate,
  normalizeRefs,
} from "../../../src/core/domain/comment.mjs";
import { COMMENT_KINDS } from "../../../src/core/domain/enums.mjs";

const NOW = "2026-10-08T00:00:00.000Z";
const create = (input = {}) =>
  normalizeCommentCreate(
    { body: "noted", kind: "note", author: { kind: "agent", id: "linus" }, ...input },
    { now: NOW, id: "c1", taskId: "task-1" },
  );

describe("domain/comment — create", () => {
  it("accepts the six kinds and defaults to note", () => {
    assert.deepEqual([...COMMENT_KINDS], ["discuss", "decision", "confirm", "change", "note", "defect"]);
    for (const kind of COMMENT_KINDS) {
      assert.equal(create({ kind }).kind, kind);
      assert.equal(isCommentKind(kind), true);
    }
    assert.equal(create({ kind: undefined }).kind, "note");
    assert.equal(isCommentKind("shout"), false);
  });

  it("requires a body, a known kind and a named author", () => {
    assert.throws(() => create({ body: "  " }), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.equal(err.details.field, "body");
      return true;
    });
    assert.throws(() => create({ kind: "shout" }), (err) => err.details.allowed.length === 6);
    assert.throws(() => create({ author: { kind: "ghost", id: "x" } }), (err) => err.details.field === "author.kind");
    assert.throws(() => create({ author: { kind: "human", id: "" } }), (err) => err.details.field === "author.id");
  });

  it("fills the bookkeeping fields", () => {
    const comment = create({ agentSession: "seg2", refs: ["PROJ-0001"], sourceSeq: 3 });
    assert.equal(comment.taskId, "task-1");
    assert.equal(comment.version, 1);
    assert.equal(comment.createdAt, NOW);
    assert.equal(comment.agentSession, "seg2");
    assert.deepEqual(comment.refs, ["PROJ-0001"]);
    assert.equal(comment.sourceSeq, 3, "the import sequence number is kept for idempotency");
  });
});

describe("domain/comment — refs", () => {
  it("accepts arrays, JSON and single strings", () => {
    assert.deepEqual(normalizeRefs(["a", " b ", ""]), ["a", "b"]);
    assert.deepEqual(normalizeRefs('["a","b"]'), ["a", "b"]);
    assert.deepEqual(normalizeRefs("PROJ-0001"), ["PROJ-0001"]);
    assert.deepEqual(normalizeRefs(null), []);
    assert.throws(() => normalizeRefs(42), (err) => err.details.field === "refs");
  });
});

describe("domain/comment — decisions and row mapping", () => {
  it("recognises a human decision on the record (I5)", () => {
    const decision = create({ kind: "confirm", author: { kind: "human", id: "Terry" } });
    assert.equal(isDecisionComment(decision), true);
    assert.equal(isDecisionComment(create({ kind: "confirm" })), false, "an agent's confirm is not a human decision");
    assert.equal(isDecisionComment(create({ kind: "note", author: { kind: "human", id: "Terry" } })), false);
    for (const kind of ["decision", "change"]) {
      assert.equal(isDecisionComment(create({ kind, author: { kind: "human", id: "T" } })), true, kind);
    }
  });

  it("round-trips a comment through a row, and ignores what it cannot map", () => {
    const comment = create({ refs: ["PROJ-0001"] });
    const row = commentToRow(comment);
    assert.deepEqual(Object.keys(row).sort(), [...COMMENT_COLUMNS].sort());
    assert.equal(row.refs_json, '["PROJ-0001"]');
    assert.deepEqual(commentFromRow(row), comment);
    assert.equal(commentFromRow(null), null);
    assert.deepEqual(commentToRow({ unknown: 1 }), {});
  });
});
