/**
 * The question lane's settle rules — one reader for the ladder's middle rung.
 *
 * A question is **open** while the card is still `in_progress` and the card has
 * not changed status since the question was written. A director `note` alone is
 * not a settle: the card must be released back to the queue. These predicates
 * are shared by the orchestrator (native lane), the CLI's `issue wait`, and the
 * SLA patrol, so they live in `foundation` (the orchestrator may import only
 * foundation).
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  answeredByHuman,
  classifyQuestionOutcome,
  isQuestionAnswered,
  isQuestionComment,
  newestQuestion,
  questionOpen,
  releasedAfterQuestion,
} from "../../src/foundation/question-settle.mjs";

const question = (createdAt) => ({
  id: "q1",
  kind: "question",
  body: "Why?",
  created_at: createdAt,
});
const human = (id, extra = {}) => ({
  id,
  kind: "discuss",
  author_kind: "human",
  body: "Because.",
  ...extra,
});
const agent = (id, extra = {}) => ({
  id,
  kind: "note",
  author_kind: "agent",
  body: "decision: because",
  ...extra,
});
const task = (status, changedAt) => ({ status, status_changed_at: changedAt });

describe("foundation/question-settle — released after the question", () => {
  it("is released only when the card changed status after the question", () => {
    assert.equal(releasedAfterQuestion(task("in_progress", "2026-01-01T00:00:00Z"), question("2026-01-01T00:05:00Z")), false);
    assert.equal(releasedAfterQuestion(task("in_progress", "2026-01-01T00:10:00Z"), question("2026-01-01T00:05:00Z")), true);
    assert.equal(releasedAfterQuestion(task("todo", "2026-01-01T00:10:00Z"), question("2026-01-01T00:05:00Z")), true);
  });

  it("accepts the camelCase task/question shape too", () => {
    assert.equal(
      releasedAfterQuestion(
        { status: "in_progress", statusChangedAt: "2026-01-01T00:10:00Z" },
        { id: "q1", createdAt: "2026-01-01T00:05:00Z" },
      ),
      true,
    );
  });

  it("never claims a release it cannot read", () => {
    assert.equal(releasedAfterQuestion(task("in_progress", null), question("2026-01-01T00:05:00Z")), false);
    assert.equal(releasedAfterQuestion(task("in_progress", "2026-01-01T00:10:00Z"), null), false);
    assert.equal(releasedAfterQuestion(task("in_progress", "not-a-time"), question("2026-01-01T00:05:00Z")), false);
  });
});

describe("foundation/question-settle — open while the card is in progress", () => {
  it("is open only for an in_progress card that has not been released", () => {
    const q = question("2026-01-01T00:05:00Z");
    assert.equal(questionOpen(task("in_progress", "2026-01-01T00:01:00Z"), q), true);
    assert.equal(questionOpen(task("in_progress", "2026-01-01T00:10:00Z"), q), false);
    for (const status of ["todo", "awaiting", "in_review", "blocked", "done", "canceled"]) {
      assert.equal(questionOpen(task(status, "2026-01-01T00:01:00Z"), q), false, status);
    }
    assert.equal(questionOpen(task("in_progress", "2026-01-01T00:01:00Z"), null), false);
  });
});

describe("foundation/question-settle — classify the outcome", () => {
  it("keeps a note-only director turn unsettled", () => {
    const comments = [agent("n1"), question("2026-01-01T00:05:00Z")];
    const outcome = classifyQuestionOutcome({
      task: task("in_progress", "2026-01-01T00:01:00Z"),
      comments,
    });
    assert.equal(outcome.status, "in_progress");
    assert.equal(outcome.answered, false);
    assert.equal(outcome.released, false);
    assert.equal(outcome.escalated, false);
    assert.equal(outcome.settled, false);
  });

  it("records a human answer, but does not settle an unreleased card", () => {
    const comments = [human("h1"), question("2026-01-01T00:05:00Z")];
    const outcome = classifyQuestionOutcome({
      task: task("in_progress", "2026-01-01T00:01:00Z"),
      comments,
    });
    assert.equal(outcome.answered, true);
    assert.equal(outcome.released, false);
    assert.equal(outcome.settled, false, "the director must still release the card");
  });

  it("settles a released card and an escalation", () => {
    const comments = [agent("n1"), question("2026-01-01T00:05:00Z")];
    const released = classifyQuestionOutcome({
      task: task("todo", "2026-01-01T00:10:00Z"),
      comments,
    });
    assert.equal(released.released, true);
    assert.equal(released.settled, true);

    const escalated = classifyQuestionOutcome({
      task: task("awaiting", "2026-01-01T00:10:00Z"),
      comments,
    });
    assert.equal(escalated.escalated, true);
    assert.equal(escalated.settled, true);
  });

  it("finds the question by id when several exist", () => {
    const older = { ...question("2026-01-01T00:01:00Z"), id: "q-old" };
    const newer = { ...question("2026-01-01T00:05:00Z"), id: "q-new" };
    const outcome = classifyQuestionOutcome({
      task: task("in_progress", "2026-01-01T00:02:00Z"),
      comments: [agent("n1"), newer, older],
      questionId: "q-old",
    });
    assert.equal(outcome.question.id, "q-old");
    assert.equal(outcome.answered, false, "the agent note is newer than q-old but is still a note");
  });

  it("reads the wire comment order: newest first", () => {
    const comments = [human("h1"), question("2026-01-01T00:05:00Z")];
    assert.equal(newestQuestion(comments).id, "q1");
    assert.equal(answeredByHuman(comments, newestQuestion(comments)), true);
    assert.equal(isQuestionComment(comments[1]), true);
    assert.equal(isQuestionComment(comments[0]), false);
  });

  it("treats any newer non-question comment as an answer (the wait's rule)", () => {
    const q = question("2026-01-01T00:05:00Z");
    assert.equal(isQuestionAnswered([agent("n1"), q], q), true, "a director note answers");
    assert.equal(isQuestionAnswered([human("h1"), q], q), true, "a human comment answers");
    assert.equal(isQuestionAnswered([{ ...question("2026-01-01T00:10:00Z"), id: "q2" }, q], q), false, "a second question is not an answer");
    assert.equal(isQuestionAnswered([q], q), false);
    assert.equal(isQuestionAnswered([], q), false);
    // A comment *older* than the question (after it in the newest-first list)
    // must not count.
    assert.equal(isQuestionAnswered([q, agent("old")], q), false);
  });
});
