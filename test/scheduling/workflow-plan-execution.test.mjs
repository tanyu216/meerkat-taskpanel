/**
 * The board → loop seam, end to end.
 *
 * The planner (`domain/workflow.mjs`) and the executor (`scripts/loop/runners.mjs`)
 * are each tested well on their own, but their tests meet in the middle only by
 * convention: the planner's tests hand-build wire tasks, the executor's tests
 * hand-build snake_case actions, and the API contract fixture is a third
 * hand-built plan. A rename on either side can therefore leave both suites
 * green. This file drives one seam through both halves:
 *
 *   planWorkflowTick → workflowToWire → runWorkflowTick
 *
 * Every action type the planner can emit has a row in `SCENARIOS`; the fake
 * `move` / `comment` / `setMeta` / `createReview` / `createFixChild` record the
 * write order, so "the loop recognizes the plan" is asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planWorkflowTick } from "../../src/core/domain/workflow.mjs";
import { workflowToWire } from "../../src/foundation/wire.mjs";
import { runWorkflowTick } from "../../scripts/loop/runners.mjs";

const NOW = "2026-10-08T00:05:00.000Z";
const CONFIG = Object.freeze({ reviewer: "jobs", maxActions: 20, reviewAgingMs: 60 * 60_000 });

/** A wire task with the fields the planner reads. */
function card(overrides = {}) {
  return {
    id: "T-1",
    identifier: "PROJ-0001",
    project_id: "proj",
    title: "A card",
    status: "in_review",
    kind: "task",
    acceptance_mode: "agent",
    delivery_round: 1,
    meta: {},
    acceptance: [],
    assignee: { id: "linus", display_name: "linus", kind: "agent" },
    status_changed_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

/** A flow-B review card auditing `original` at `auditedRound`. */
function reviewCard(original, overrides = {}) {
  return card({
    id: "T-2",
    identifier: "PROJ-0002",
    status: "in_review",
    acceptance_mode: "off",
    delivery_round: 1,
    review_of_id: original.id,
    review_round: original.delivery_round,
    meta: { flow: "B", review_of: original.identifier, review_round: original.delivery_round },
    assignee: { id: "jobs", display_name: "jobs", kind: "agent" },
    ...overrides,
  });
}

/** The parsed verdict the board hands the planner for a review card. */
function verdict(word, findings = "") {
  return {
    ok: true,
    verdict: word,
    findings,
    report: {
      conclusion: `VERDICT: ${word}\n${findings}`,
      acceptance: [],
      evidence: [],
      author: { id: "jobs", display_name: "jobs", kind: "agent" },
    },
  };
}

/** Run the planner, wire the plan, run the executor with recording fakes. */
async function throughBothHalves(input) {
  const plan = planWorkflowTick({ ...input, config: CONFIG, now: NOW });
  const wirePlan = workflowToWire(plan);
  const order = [];
  const result = await runWorkflowTick({
    plan: wirePlan,
    config: { workflow: true, maxActions: 20, reviewAgingMs: 60 * 60_000 },
    dryRun: false,
    createReview: async (action) => (order.push(`createReview:${action.idem}`), { ok: true, ref: "PROJ-0003" }),
    createFixChild: async (action) => (order.push(`createFixChild:${action.original_ref}`), { ok: true, ref: "PROJ-0004" }),
    linkFixChild: async (epic, child) => (order.push(`linkFixChild:${epic}:${child}`), { ok: true }),
    move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
    comment: async (ref, { kind }) => (order.push(`comment:${ref}:${kind}`), { ok: true }),
    setMeta: async (ref, meta) => (order.push(`setMeta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
    notify: () => {},
    log: () => {},
  });
  return { plan, wirePlan, order, result };
}

const APPROVE_ORDER = [
  "comment:PROJ-0001:note",
  'setMeta:PROJ-0001:{"accepted_by":"loop-review","accepted_round":"1"}',
  "move:PROJ-0001:done",
  "comment:PROJ-0002:note",
  "move:PROJ-0002:done",
];

const REJECT_TASK_ORDER = [
  "comment:PROJ-0001:change",
  'setMeta:PROJ-0001:{"rework_round":"2"}',
  "move:PROJ-0001:in_progress",
  "move:PROJ-0001:todo",
  "comment:PROJ-0002:note",
  "move:PROJ-0002:done",
];

const REJECT_EPIC_ORDER = [
  "createFixChild:PROJ-0001",
  "linkFixChild:PROJ-0001:PROJ-0004",
  "comment:PROJ-0001:change",
  'setMeta:PROJ-0001:{"rework_round":"2"}',
  "move:PROJ-0001:in_progress",
  "comment:PROJ-0002:note",
  "move:PROJ-0002:done",
];

/**
 * One row per action type. `expectedAction` is the planner's action; `expectedOrder`
 * is the executor's write sequence (the "review card last" protocol).
 */
const SCENARIOS = [
  {
    name: "create_review (dispatch)",
    tasks: [card({ meta: {} })],
    expectedAction: "create_review",
    expectedOrder: ["createReview:loop-review|PROJ-0001|r1"],
  },
  {
    name: "auto_accept (off card)",
    tasks: [card({ acceptance_mode: "off" })],
    expectedAction: "auto_accept",
    expectedOrder: [
      'setMeta:PROJ-0001:{"accepted_by":"loop-auto","accepted_round":"1","auto_accepted":"1"}',
      "comment:PROJ-0001:note",
      "move:PROJ-0001:done",
    ],
  },
  {
    name: "approve",
    tasks: (() => {
      const original = card();
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("APPROVE") },
    expectedAction: "approve",
    expectedOrder: APPROVE_ORDER,
  },
  {
    name: "reject_task",
    tasks: (() => {
      const original = card();
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("REJECT", "the acceptance list is missing a case") },
    expectedAction: "reject_task",
    expectedOrder: REJECT_TASK_ORDER,
  },
  {
    name: "reject_epic",
    tasks: (() => {
      const original = card({ kind: "epic" });
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("REJECT", "a child is missing") },
    expectedAction: "reject_epic",
    expectedOrder: REJECT_EPIC_ORDER,
  },
  {
    name: "reject_task_finish (crash after the rework marker)",
    tasks: (() => {
      const original = card({ status: "in_progress", delivery_round: 2, meta: { rework_round: "2" } });
      const review = reviewCard(original, { review_round: 1 });
      return [original, review];
    })(),
    expectedAction: "reject_task_finish",
    expectedOrder: ["move:PROJ-0001:todo", "comment:PROJ-0002:note", "move:PROJ-0002:done"],
  },
  {
    name: "close_review (round mismatch)",
    tasks: (() => {
      const original = card({ delivery_round: 2 });
      const review = reviewCard(original, { review_round: 1 });
      return [original, review];
    })(),
    expectedAction: "close_review",
    expectedOrder: ["comment:PROJ-0002:note", "move:PROJ-0002:done"],
  },
  {
    name: "cancel_review (original canceled)",
    tasks: (() => {
      const original = card({ status: "canceled" });
      const review = reviewCard(original);
      return [original, review];
    })(),
    expectedAction: "cancel_review",
    expectedOrder: ["comment:PROJ-0002:note", "move:PROJ-0002:in_progress", "move:PROJ-0002:canceled"],
  },
];

describe("workflow plan → execution", () => {
  for (const scenario of SCENARIOS) {
    it(`plans and executes ${scenario.name} without a renamed field`, async () => {
      const { plan, wirePlan, order, result } = await throughBothHalves({
        tasks: scenario.tasks,
        verdicts: scenario.verdicts ?? {},
        reportsByRef: scenario.reportsByRef ?? {},
      });

      assert.deepEqual(
        plan.actions.map((action) => action.type),
        [scenario.expectedAction],
        `the planner must emit exactly the expected action (got ${JSON.stringify(plan.actions.map((a) => a.type))})`,
      );
      // The wire plan is what the loop actually reads: assert the field names it
      // depends on survived the camelCase → snake_case boundary.
      assert.ok(
        wirePlan.actions[0].type === scenario.expectedAction,
        `the wired plan keeps the action type (got ${wirePlan.actions[0].type})`,
      );
      assert.equal(result.failed, 0, `the executor must recognize the action: ${JSON.stringify(result)}`);
      assert.equal(result.executed, 1);
      assert.deepEqual(order, scenario.expectedOrder, "the executor's write order is the review-card-last protocol");
    });
  }

  it("keeps every planner action's fields inside the frozen plan shape", () => {
    // The contract snapshot freezes these field sets. A live planner action that
    // grows a field the snapshot does not know is exactly the drift the
    // hand-built fixture cannot catch.
    const frozen = {
      create_review: ["type", "original_ref", "project_id", "reviewer", "round", "idem", "target", "title", "description", "acceptance"],
      auto_accept: ["type", "original_ref", "round", "accepted_by", "held"],
      approve: ["type", "review_status", "review_ref", "original_ref", "round", "close_review", "accepted_by", "held"],
      reject_task: ["type", "review_status", "review_ref", "original_ref", "round", "rework_round", "findings", "close_review"],
      reject_epic: [
        "type", "review_status", "review_ref", "original_ref", "round", "rework_round",
        "project_id", "assignee_id", "original_title", "acceptance_mode", "findings", "close_review",
      ],
      reject_task_finish: ["type", "review_status", "review_ref", "original_ref", "round", "close_review"],
      close_review: ["type", "review_status", "review_ref", "original_ref", "round", "reason", "close_review"],
      cancel_review: ["type", "review_status", "review_ref", "original_ref", "reason"],
    };
    for (const scenario of SCENARIOS) {
      const plan = planWorkflowTick({
        tasks: scenario.tasks,
        verdicts: scenario.verdicts ?? {},
        reportsByRef: scenario.reportsByRef ?? {},
        config: CONFIG,
        now: NOW,
      });
      const wired = workflowToWire(plan);
      for (const action of wired.actions) {
        const allowed = frozen[action.type];
        assert.ok(allowed, `the snapshot must know the action type ${action.type}`);
        const extra = Object.keys(action).filter((key) => !allowed.includes(key));
        assert.deepEqual(extra, [], `${action.type} grew field(s) the frozen plan shape does not name: ${extra.join(", ")}`);
      }
    }
  });
});
