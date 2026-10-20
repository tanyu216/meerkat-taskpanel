/**
 * The `awaiting` rules that are neither a transition nor a column default.
 *
 * Three things are asserted here, and each is a card requirement rather than a
 * nicety:
 *
 *   * the entry **reason** is an enumeration (`E1..E5`), never free text —
 *     design §2.1, "machine-checkable by construction";
 *   * the **payload** is the triggering human comment, and the first sentence
 *     is cut at the sentence-final punctuation the design names — §2.2;
 *   * **resume is human-only and idempotent** (card D/F2): an agent comment
 *     never resumes the card, and the *same* human comment never resumes it
 *     twice, because the caller's cursor is compared by identity and the
 *     decision is pure.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { AWAITING_REASONS, STATUSES } from "../../../src/core/domain/enums.mjs";
import {
  assertAwaitingReason,
  firstSentence,
  isAwaitingReason,
  isConsumed,
  isHumanComment,
  payloadOf,
  resumeDecision,
} from "../../../src/core/domain/awaiting.mjs";
import { DomainError } from "../../../src/foundation/errors.mjs";

const human = (id, body = "请问这一版的范围可以确认吗？后面还有一句。", extra = {}) => ({
  id,
  body,
  authorKind: "human",
  authorId: "terry",
  createdAt: "2026-10-12T00:00:00.000Z",
  ...extra,
});
const agent = (id, body = "我觉得没问题") => ({ id, body, authorKind: "agent", authorId: "linus" });

describe("domain/awaiting — the entry reason is an enumeration (§2.1)", () => {
  it("accepts every reason in the vocabulary and nothing else", () => {
    for (const reason of AWAITING_REASONS) {
      assert.equal(isAwaitingReason(reason), true, reason);
      assert.equal(assertAwaitingReason(reason), reason);
    }
    for (const bad of ["", "E0", "E6", "e1", "scope change", "E1 ", null, undefined, 42, {}]) {
      assert.equal(isAwaitingReason(bad), false, String(bad));
    }
  });

  it("refuses a missing reason rather than defaulting one", () => {
    // An unlabelled entry is the payload-less black box §2.1 calls a defect —
    // so the refusal is explicit, and it names the vocabulary.
    assert.throws(
      () => assertAwaitingReason(undefined),
      (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.deepEqual(err.details.allowed, AWAITING_REASONS);
        assert.match(err.message, /E1/);
        return true;
      },
    );
  });

  it("keeps the vocabulary closed and derived from the one enum", () => {
    assert.deepEqual([...AWAITING_REASONS], ["E1", "E2", "E3", "E4", "E5"]);
    assert.equal(AWAITING_REASONS.includes("awaiting"), false);
    assert.equal(STATUSES.includes("awaiting"), true);
  });
});

describe("domain/awaiting — the payload is the human comment (§2.2)", () => {
  it("reads the newest *human* comment, ignoring agent commentary", () => {
    assert.equal(payloadOf({ comments: [] }), null);
    assert.equal(payloadOf({}), null);
    assert.equal(isHumanComment(agent("a1")), false);
    assert.equal(isHumanComment(human("h1")), true);
    const comments = [agent("a1"), human("h1"), agent("a2")];
    assert.equal(payloadOf({ comments }).id, "h1");
    // An agent comment written *after* the human one does not take the payload
    // away — the human's question is still the question.
    assert.equal(payloadOf({ comments: [human("h1"), agent("a2"), agent("a3")] }).id, "h1");
  });

  it("cuts the first sentence at the design's punctuation or the first newline", () => {
    assert.equal(firstSentence("第一句。第二句"), "第一句。");
    assert.equal(firstSentence("First one. Second one"), "First one.");
    assert.equal(firstSentence("Really? Yes"), "Really?");
    assert.equal(firstSentence("等等！后面"), "等等！");
    assert.equal(firstSentence("line one\nline two"), "line one");
    assert.equal(firstSentence("no punctuation at all"), "no punctuation at all");
    assert.equal(firstSentence(""), "");
    assert.equal(firstSentence(null), "");
    assert.equal(firstSentence("  padded.  more  "), "padded.");
  });
});

describe("domain/awaiting — resume is human-only and idempotent (card D/F2)", () => {
  it("never resumes on an agent comment", () => {
    const decision = resumeDecision({ task: { status: "awaiting" }, comments: [agent("a1")], cursor: null });
    assert.equal(decision.resume, false);
    assert.equal(decision.reason, "not_human");
    // ...and the cursor does not move, so the agent comment cannot swallow a
    // later human one.
    assert.equal(decision.nextCursor, null);
  });

  it("does not resume twice on the same human comment", () => {
    const comments = [human("h1")];
    const first = resumeDecision({ task: { status: "awaiting" }, comments, cursor: null });
    assert.equal(first.resume, true);
    assert.equal(first.reason, "human_reply");
    assert.equal(first.nextCursor, "h1");

    // The replay: same board, the cursor the caller persisted.
    const second = resumeDecision({ task: { status: "awaiting" }, comments, cursor: first.nextCursor });
    assert.equal(second.resume, false);
    assert.equal(second.reason, "already_consumed");
    assert.equal(second.nextCursor, "h1", "a replay must leave the cursor where it was");

    // A third read of the same pair is identical to the second — the decision
    // is a pure function of its inputs, which is what makes the path idempotent
    // rather than merely "usually fine".
    assert.deepEqual(resumeDecision({ task: { status: "awaiting" }, comments, cursor: "h1" }), second);
  });

  it("resumes on a *new* human comment after the consumed one", () => {
    const comments = [human("h1"), agent("a2"), human("h3")];
    const decision = resumeDecision({ task: { status: "awaiting" }, comments, cursor: "h1" });
    assert.equal(decision.resume, true);
    assert.equal(decision.comment.id, "h3");
    assert.equal(decision.nextCursor, "h3");
  });

  it("only speaks about an awaiting card", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked", "done", "canceled"]) {
      const decision = resumeDecision({ task: { status }, comments: [human("h1")], cursor: null });
      assert.equal(decision.resume, false, status);
      assert.equal(decision.reason, "not_awaiting");
    }
    assert.equal(resumeDecision({}).reason, "not_awaiting");
    assert.equal(resumeDecision({ task: { status: "awaiting" } }).reason, "no_comment");
  });

  it("compares the cursor by identity, not by inventing an order", () => {
    assert.equal(isConsumed(null, "h1"), false, "nothing consumed yet");
    assert.equal(isConsumed("h1", "h1"), true);
    assert.equal(isConsumed("h1", "h2"), false);
    assert.equal(isConsumed("h1", null), false, "an id-less comment cannot match a cursor");
    assert.equal(isConsumed(7, "7"), true, "the watermark may be numeric or textual");
  });
});
