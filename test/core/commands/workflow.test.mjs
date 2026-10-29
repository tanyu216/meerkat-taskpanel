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
  acceptance: [{ text: "the thing works", status: "met", note: "ran it (evidence[1])" }],
  evidence: [{ kind: "commit", sha: "abc1234" }],
  author: WORKER,
};

const VERDICT = {
  conclusion: "VERDICT: APPROVE",
  acceptance: [{ text: "the evidence matches", status: "met", note: "evidence[2] — the run" }],
  evidence: [
    { kind: "path", path: "src/thing.mjs" },
    { kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 },
  ],
  author: REVIEWER,
};

function board(fn) {
  return withBoard(({ db }) => {
    const repos = createRepositories(db);
    const ctx = createContext({ db, repos });
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
    // 0038 — the project defaults to `auto`, so a creator must say what this
    // card needs. This fixture is the reviewed path.
    acceptanceMode: "agent",
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
        acceptanceMode: "agent",
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

  it("reads the card's acceptance mode, not a loop-supplied policy", async () => {
    await board(({ commands }) => {
      const { original } = seed(commands);
      const result = commands.workflowTick({ reviewer: "jobs" });
      assert.equal(result.workflow.actions[0].type, "approve");
      assert.equal(commands.getTask({ id: original.id }).acceptanceMode, "agent");
      assert.equal(result.workflow.summary.held, 0);
    });
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
  function deliverPlain(commands, projectId = "proj", acceptanceMode = "off") {
    const task = commands.createTask({
      projectId,
      title: "Do the thing",
      assignee: "linus",
      acceptanceMode,
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
        acceptance: "agent",
        reviewer: "bob",
        actor: HUMAN,
      });
      const task = commands.createTask({
        projectId: "p2",
        title: "Needs review",
        assignee: "linus",
        actor: HUMAN,
      });
      assert.equal(task.acceptanceMode, "agent");
      commands.moveStatus({ id: task.id, to: "in_progress", actor: WORKER });
      commands.deliver({ taskId: task.id, report: DELIVERY, actor: WORKER });

      const result = commands.workflowTick({ reviewer: "jobs" });
      const dispatch = result.workflow.actions.find((action) => action.type === "create_review");
      assert.ok(dispatch, "the required card is dispatched");
      assert.equal(dispatch.reviewer, "bob");
    });
  });

  it("gives the review card requirement, plan and omission items, within the 64 cap", async () => {
    await board(({ commands }) => {
      commands.createProject({
        id: "p2",
        name: "P2",
        acceptance: "agent",
        reviewer: "bob",
        actor: HUMAN,
      });
      const items = Array.from({ length: 60 }, (_, index) => `criterion ${index}`);
      const task = commands.createTask({
        projectId: "p2",
        title: "Needs review",
        assignee: "linus",
        meta: { acceptance: items },
        actor: HUMAN,
      });
      commands.moveStatus({ id: task.id, to: "in_progress", actor: WORKER });
      commands.deliver({
        taskId: task.id,
        report: {
          conclusion: "done",
          acceptance: items.map((text) => ({ text, status: "met", note: "ran it (evidence[1])" })),
          evidence: [{ kind: "commit", sha: "abc1234" }],
          author: WORKER,
        },
        actor: WORKER,
      });

      const dispatch = commands
        .workflowTick({ reviewer: "jobs" })
        .workflow.actions.find((action) => action.type === "create_review");
      assert.ok(dispatch, "the required card is dispatched");
      assert.match(dispatch.description, /Reference material/);
      assert.match(dispatch.description, /Omission check/);
      assert.match(dispatch.description, /\.meerkat\/[^/]+\//);
      assert.match(dispatch.description, /plan\.md \(the worker's plan\)/);
      assert.match(dispatch.description, /absence alone is not a reject/);
      assert.equal(dispatch.acceptance.length, 64, "the review card stays inside the 64-item cap");
      assert.ok(
        dispatch.acceptance.includes("The delivery report is consistent with its evidence anchors"),
      );
      assert.ok(
        dispatch.acceptance.some((text) => /Every requirement in the original description/.test(text)),
      );
      assert.ok(dispatch.acceptance.some((text) => /plan\.md/.test(text)));
    });
  });

  it("carries a rejection's must-fix items into the next round's baseline and review card", async () => {
    await board(({ commands }) => {
      const original = commands.createTask({
        projectId: "proj",
        title: "Do the thing",
        assignee: "linus",
        acceptanceMode: "agent",
        meta: { acceptance: ["the thing works"] },
        actor: HUMAN,
      });
      commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
      commands.deliver({
        taskId: original.id,
        report: {
          ...DELIVERY,
          acceptance: [{ text: "the thing works", status: "met", note: "evidence[1] — ran it" }],
        },
        actor: WORKER,
      });

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
      commands.deliver({
        taskId: review.id,
        report: {
          conclusion: "VERDICT: REJECT\n\n1. add the e2e case for a canceled child",
          acceptance: [{ text: "the evidence matches", status: "not_met" }],
          evidence: [{ kind: "path", path: "src/thing.mjs" }],
          leftovers: "the e2e case for a canceled child is missing",
          author: REVIEWER,
        },
        actor: REVIEWER,
      });

      const rejected = commands
        .workflowTick({ reviewer: "jobs" })
        .workflow.actions.find((action) => action.type === "reject_task");
      assert.ok(rejected, "the delivery is rejected");
      assert.deepEqual(rejected.mustFix, ["add the e2e case for a canceled child"]);

      // The executor's writes: the round bump unlocks the baseline, then the
      // must-fix items land, then the card is released to the pool.
      commands.moveStatus({ id: original.id, to: "in_progress", actor: WORKER });
      commands.updateTask({ id: original.id, acceptance: rejected.mustFix, actor: { kind: "taskd", id: "loop" } });
      commands.moveStatus({ id: original.id, to: "todo", actor: WORKER });
      // The executor closes the review card last; without it the next tick
      // would still treat this original as handled by the outcome.
      commands.moveStatus({ id: review.id, to: "done", actor: { kind: "taskd", id: "loop" } });
      assert.deepEqual(commands.getTask({ id: original.id }).acceptance, [
        "the thing works",
        "add the e2e case for a canceled child",
      ]);

      commands.claim({ id: original.id, actor: WORKER });
      commands.deliver({
        taskId: original.id,
        report: {
          ...DELIVERY,
          acceptance: [
            { text: "the thing works", status: "met", note: "evidence[1] — ran it" },
            { text: "add the e2e case for a canceled child", status: "met", note: "evidence[2] — the new test" },
          ],
          evidence: [
            { kind: "commit", sha: "abc1234" },
            { kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 },
          ],
        },
        actor: WORKER,
      });

      const dispatch = commands
        .workflowTick({ reviewer: "jobs" })
        .workflow.actions.find((action) => action.type === "create_review");
      assert.ok(dispatch, "round 2 is dispatched for review");
      assert.ok(
        dispatch.acceptance.includes("add the e2e case for a canceled child"),
        "the next review card owes an answer to the last round's finding",
      );

      // And an APPROVE that ignores it is refused at acceptance, not merely
      // noted: the carried item is an ordinary criterion of both baselines.
      const finding = "add the e2e case for a canceled child";
      const review2 = commands.createTask({
        projectId: "proj",
        title: "Review round 2",
        assignee: "jobs",
        reviewOf: original.identifier,
        reviewRound: 2,
        meta: { flow: "B", acceptance: dispatch.acceptance },
        actor: HUMAN,
      });
      commands.moveStatus({ id: review2.id, to: "in_progress", actor: REVIEWER });
      commands.deliver({
        taskId: review2.id,
        report: {
          conclusion: "VERDICT: APPROVE\n\nEverything else checks out.",
          acceptance: dispatch.acceptance
            .filter((text) => text !== finding)
            .map((text) => ({ text, status: "met", note: "evidence[2] — the run" })),
          evidence: [
            { kind: "commit", sha: "abc1234" },
            { kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 },
          ],
          author: REVIEWER,
        },
        actor: REVIEWER,
      });
      assert.throws(
        () => commands.moveStatus({ id: original.id, to: "done", actor: { kind: "taskd", id: "loop" } }),
        (err) =>
          err.code === "ACCEPTANCE_INCOMPLETE" &&
          err.details.missing.some((item) => item.text === finding),
        "an APPROVE that drops the last round's finding does not accept the card",
      );
    });
  });

  it("keeps an archived project's reviewer — its in-flight cards still dispatch", async () => {
    await board(({ db, commands }) => {
      commands.createProject({
        id: "p2",
        name: "P2",
        acceptance: "agent",
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

  it("leaves a human-accepted card for the human", async () => {
    await board(({ commands }) => {
      const task = deliverPlain(commands, "proj", "human");
      const result = commands.workflowTick({ reviewer: "jobs" });
      assert.equal(result.workflow.actions.some((item) => item.type === "auto_accept"), false);
      assert.equal(
        result.workflow.alerts.some((alert) => alert.type === "auto_accept_skipped"),
        false,
      );
      assert.equal(commands.getTask({ id: task.id }).acceptanceMode, "human");
      // Round 2 — review is not gated by the mode: the human card is dispatched.
      const dispatch = result.workflow.actions.find((item) => item.type === "create_review");
      assert.ok(dispatch, JSON.stringify(result.workflow));
      assert.equal(dispatch.originalRef, task.identifier);
    });
  });
});

describe("commands/workflowTick — containers are reviewed too (round 2)", () => {
  /**
   * A done child, then an epic attached to it afterwards. The child's own move
   * cannot close the container (no edge yet), so the next `workflowTick` is what
   * rolls the epic up — the one-pass reconcile-then-snapshot path.
   */
  function doneChild(commands, title) {
    const child = commands.createTask({
      projectId: "proj",
      title,
      assignee: "linus",
      acceptanceMode: "off",
      actor: HUMAN,
    });
    commands.claim({ id: child.id, actor: WORKER });
    commands.deliver({ taskId: child.id, report: DELIVERY, actor: WORKER });
    commands.moveStatus({ id: child.id, to: "done", actor: WORKER });
    return child;
  }

  function lateEpic(commands, child, extra = {}) {
    const epic = commands.createTask({
      projectId: "proj",
      title: "Container",
      kind: "epic",
      actor: HUMAN,
      ...extra,
    });
    commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: HUMAN });
    return epic;
  }

  it("rolls a finished epic up and dispatches its review in the same tick", async () => {
    await board(({ commands }) => {
      const child = doneChild(commands, "Child");
      const epic = lateEpic(commands, child);
      assert.equal(commands.getTask({ id: epic.id }).acceptanceMode, "agent");

      const result = commands.workflowTick({ reviewer: "jobs" });

      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");
      const dispatch = result.workflow.actions.find(
        (item) => item.type === "create_review" && item.originalRef === epic.identifier,
      );
      assert.ok(dispatch, `a finished epic must be dispatched in the same pass: ${JSON.stringify(result.workflow)}`);
      assert.equal(dispatch.round, 1);
      assert.equal(
        result.workflow.actions.some((item) => item.type === "auto_accept" && item.originalRef === epic.identifier),
        false,
        "an unmarked epic is reviewed, not auto-accepted",
      );
    });
  });

  it("keeps an explicit off epic on the auto-accept path", async () => {
    await board(({ commands }) => {
      const child = doneChild(commands, "Child");
      const epic = lateEpic(commands, child, { acceptanceMode: "off" });

      const result = commands.workflowTick({ reviewer: "jobs" });

      assert.equal(commands.getTask({ id: epic.id }).status, "in_review");
      const action = result.workflow.actions.find(
        (item) => item.type === "auto_accept" && item.originalRef === epic.identifier,
      );
      assert.ok(action, JSON.stringify(result.workflow));
      assert.equal(
        result.workflow.actions.some(
          (item) => item.type === "create_review" && item.originalRef === epic.identifier,
        ),
        false,
      );
    });
  });
});
