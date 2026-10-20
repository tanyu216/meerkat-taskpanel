/**
 * The board's workflow tick (`commands/workflow.mjs`): the snapshot assembly
 * around the pure decision module. The decisions themselves are covered by
 * `test/core/domain/workflow.test.mjs`; here the seam is the use-case — does it
 * read the board's cards and reports, map them to the planner's wire shape, and
 * return the plan the loop executes?
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../src/core/commands/index.mjs";
import { createRepositories } from "../../../src/core/storage/repositories/index.mjs";
import { cleanupTempDirs, withBoard } from "../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const HUMAN = { kind: "human", id: "Terry" };
const WORKER = { kind: "agent", id: "linus" };
const REVIEWER = { kind: "agent", id: "jobs" };

const DELIVERY = {
  conclusion: "The thing is done.",
  acceptance: [{ text: "the thing works", status: "met" }],
  evidence: [{ kind: "commit", sha: "abc1234" }],
  author: WORKER,
};

const VERDICT = {
  conclusion: "VERDICT: APPROVE",
  acceptance: [{ text: "the evidence matches", status: "met" }],
  evidence: [{ kind: "path", path: "src/thing.mjs" }],
  author: REVIEWER,
};

function board(fn, { acceptancePolicy } = {}) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({
      db,
      repos,
      ...(acceptancePolicy === undefined ? {} : { acceptancePolicy }),
    });
    const commands = createCommands(ctx);
    commands.createProject({ id: "proj", name: "Project", actor: HUMAN });
    return fn({ db, repos, ctx, commands });
  });
}

/** A delivered card and a review card carrying an APPROVE verdict for it. */
function seed(commands) {
  const original = commands.createTask({
    projectId: "proj",
    title: "Do the thing",
    assignee: "linus",
    actor: HUMAN,
  });
  commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
  commands.deliver({ taskId: original.id, report: DELIVERY, actor: WORKER });

  const review = commands.createTask({
    projectId: "proj",
    title: "Review Do the thing",
    assignee: "jobs",
    reviewOf: original.identifier,
    reviewRound: 1,
    meta: { flow: "B" },
    actor: HUMAN,
  });
  commands.moveStatus({ id: review.id, to: "in_progress", actor: REVIEWER });
  commands.deliver({ taskId: review.id, report: VERDICT, actor: REVIEWER });

  return { original, review };
}

describe("commands/workflowTick — the board's plan", () => {
  it("returns the approve plan for a reviewed delivery", async () => {
    await board(({ commands }) => {
      const { original, review } = seed(commands);
      const result = commands.workflowTick({ reviewer: "jobs" });

      assert.equal(result.workflow.actions.length, 1);
      assert.equal(result.workflow.actions[0].type, "approve");
      assert.equal(result.workflow.actions[0].originalRef, original.identifier);
      assert.equal(result.workflow.actions[0].reviewRef, review.identifier);
      assert.equal(result.workflow.actions[0].acceptedBy, "loop-review");
      assert.equal(result.workflow.summary.approved, 1);
    });
  });

  it("uses the board's acceptance policy, not a loop-supplied one", async () => {
    await board(
      ({ commands }) => {
        seed(commands);
        const result = commands.workflowTick({ reviewer: "jobs" });
        assert.equal(result.workflow.actions[0].type, "approve_hold");
        assert.equal(result.workflow.actions[0].held, false);
        assert.equal(result.workflow.summary.held, 1);
      },
      { acceptancePolicy: () => "human-only" },
    );
  });

  it("returns a plan with no actions when nobody delivered", async () => {
    await board(({ commands }) => {
      commands.createTask({ projectId: "proj", title: "Not started", actor: HUMAN });
      const result = commands.workflowTick({ reviewer: "jobs" });
      assert.deepEqual(result.workflow.actions, []);
      assert.equal(result.workflow.summary.actions, 0);
    });
  });

  it("dispatches nothing when the snapshot is bounded below the board", async () => {
    await board(({ commands }) => {
      seed(commands);
      // Two cards on the board, a read capped at one: the planner must treat
      // the missing rows as unknown and refuse to dispatch on a partial view.
      const result = commands.workflowTick({ reviewer: "jobs", boardLimit: 1 });
      assert.deepEqual(result.workflow.actions, []);
      assert.ok(
        result.workflow.alerts.some(
          (alert) => alert.type === "dispatch_skipped" && alert.reason === "board_truncated",
        ),
        JSON.stringify(result.workflow.alerts),
      );
    });
  });
});
