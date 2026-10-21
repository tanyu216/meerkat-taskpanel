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

  it("applies a verdict on a review that audits a later delivery round", async () => {
    await board(({ commands }) => {
      const original = commands.createTask({
        projectId: "proj",
        title: "Do the thing again",
        assignee: "linus",
        actor: HUMAN,
      });
      commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: original.id, report: DELIVERY, actor: WORKER });
      // A rework leaves in_review for in_progress, which starts round 2.
      commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: original.id, report: DELIVERY, actor: WORKER });

      const review = commands.createTask({
        projectId: "proj",
        title: "Review round 2",
        assignee: "jobs",
        reviewOf: original.identifier,
        reviewRound: 2,
        meta: { flow: "B" },
        actor: HUMAN,
      });
      commands.moveStatus({ id: review.id, to: "in_progress", actor: REVIEWER });
      commands.deliver({ taskId: review.id, report: VERDICT, actor: REVIEWER });

      // The review card's own round is 1; the round it audits is 2. The
      // verdict report is stamped with the card's own round.
      assert.equal(commands.getTask({ id: review.id }).deliveryRound, 1);
      assert.equal(commands.listReports({ taskId: review.id })[0].round, 1);

      const result = commands.workflowTick({ reviewer: "jobs" });
      assert.deepEqual(result.workflow.alerts, []);
      assert.equal(result.workflow.actions[0]?.type, "approve");
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

  it("surfaces the agent-only / auto-accept conflict from the board's policy", async () => {
    await board(
      ({ commands }) => {
        seed(commands);
        const result = commands.workflowTick({ reviewer: "jobs", autoAcceptReviews: false });
        const alert = result.workflow.alerts.find(
          (entry) => entry.type === "review_cards_unclosable",
        );
        assert.equal(alert.policy, "agent-only");
        assert.equal(alert.reviews, 1);
        assert.equal(alert.autoAcceptReviews, false);
      },
      { acceptancePolicy: () => "agent-only" },
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

// ---------------------------------------------------------------------------
// 0031 — project reviewers and auto-accept in the board snapshot
// ---------------------------------------------------------------------------

describe("commands/workflowTick — 0031", () => {
  function deliverPlain(commands, projectId = "proj") {
    const task = commands.createTask({
      projectId,
      title: "Do the thing",
      assignee: "linus",
      actor: HUMAN,
    });
    commands.moveStatus({ id: task.id, to: "in_progress", actor: WORKER });
    commands.deliver({ taskId: task.id, report: DELIVERY, actor: WORKER });
    return task;
  }

  it("uses a project's reviewer override in the dispatch action", async () => {
    await board(({ commands }) => {
      commands.createProject({
        id: "p2",
        name: "P2",
        reviewPolicy: "required",
        reviewer: "bob",
        actor: HUMAN,
      });
      const task = commands.createTask({
        projectId: "p2",
        title: "Needs review",
        assignee: "linus",
        actor: HUMAN,
      });
      assert.equal(task.reviewRequired, 1);
      commands.moveStatus({ id: task.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: task.id, report: DELIVERY, actor: WORKER });

      const result = commands.workflowTick({ reviewer: "jobs" });
      const dispatch = result.workflow.actions.find((action) => action.type === "create_review");
      assert.ok(dispatch, "the required card is dispatched");
      assert.equal(dispatch.reviewer, "bob");
    });
  });

  it("keeps an archived project's reviewer — its in-flight cards still dispatch", async () => {
    await board(({ db, commands }) => {
      commands.createProject({
        id: "p2",
        name: "P2",
        reviewPolicy: "required",
        reviewer: "bob",
        actor: HUMAN,
      });
      const task = commands.createTask({
        projectId: "p2",
        title: "Needs review",
        assignee: "linus",
        actor: HUMAN,
      });
      // Archive the project after the card exists: the board must still read
      // the override, or the card dispatches to the global reviewer instead.
      db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(
        "2026-10-19T10:00:00.000Z",
        "p2",
      );
      commands.moveStatus({ id: task.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: task.id, report: DELIVERY, actor: WORKER });

      const result = commands.workflowTick({ reviewer: "jobs" });
      const dispatch = result.workflow.actions.find((action) => action.type === "create_review");
      assert.ok(dispatch);
      assert.equal(dispatch.reviewer, "bob");
    });
  });

  it("plans an auto_accept for a delivered card that needs no review", async () => {
    await board(({ commands }) => {
      const task = deliverPlain(commands);
      const result = commands.workflowTick({ reviewer: "jobs" });
      const action = result.workflow.actions.find((item) => item.type === "auto_accept");
      assert.ok(action);
      assert.equal(action.originalRef, task.identifier);
      assert.equal(action.acceptedBy, "loop-auto");
      assert.equal(result.workflow.summary.autoAccepted, 1);
    });
  });

  it("leaves a human-only top-level card for the human", async () => {
    await board(
      ({ commands }) => {
        const task = deliverPlain(commands);
        const result = commands.workflowTick({ reviewer: "jobs" });
        assert.equal(result.workflow.actions.some((item) => item.type === "auto_accept"), false);
        const skipped = result.workflow.alerts.find((alert) => alert.type === "auto_accept_skipped");
        assert.ok(skipped);
        assert.equal(skipped.original, task.identifier);
        assert.equal(skipped.reason, "human_only");
      },
      { acceptancePolicy: "human-only" },
    );
  });
});
