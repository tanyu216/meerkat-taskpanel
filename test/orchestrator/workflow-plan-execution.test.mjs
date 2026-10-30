/**
 * The board → loop seam, end to end.
 *
 * The planner (`domain/workflow.mjs`) and the executor (`src/orchestrator/runners.mjs`)
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
import { runWorkflowTick } from "../../src/orchestrator/runners.mjs";

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
      // The reviewer ran something: an APPROVE with no command anchor is
      // refused as `verdict_unsupported`.
      evidence: [{ kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 }],
      author: { id: "jobs", display_name: "jobs", kind: "agent" },
    },
  };
}

/** Run the planner, wire the plan, run the executor with recording fakes. */
async function throughBothHalves(input, overrides = {}) {
  const plan = planWorkflowTick({ ...input, config: CONFIG, now: NOW });
  const wirePlan = workflowToWire(plan);
  const order = [];
  const appends = [];
  const metas = [];
  const result = await runWorkflowTick({
    plan: wirePlan,
    config: { workflow: true, maxActions: 20, reviewAgingMs: 60 * 60_000 },
    dryRun: false,
    // Landing runs before a card reaches `done`; the real adapter merges the
    // lane branch. These cases record its place in the sequence.
    land:
      overrides.land ??
      (async (action) => (order.push(`land:${action.original_ref}`), { ok: true })),
    createReview: async (action) => (order.push(`createReview:${action.idem}`), { ok: true, ref: "PROJ-0003" }),
    createFixChild: async (action) => (order.push(`createFixChild:${action.original_ref}`), { ok: true, ref: "PROJ-0004" }),
    linkFixChild: async (epic, child) => (order.push(`linkFixChild:${epic}:${child}`), { ok: true }),
    move: async (ref, to) => (order.push(`move:${ref}:${to}`), { ok: true }),
    comment: async (ref, { kind }) => (order.push(`comment:${ref}:${kind}`), { ok: true }),
    setMeta: async (ref, meta) => (
      metas.push({ ref, meta }),
      order.push(`setMeta:${ref}:${JSON.stringify(meta)}`),
      { ok: true }
    ),
    appendAcceptance: async (ref, items) => {
      appends.push({ ref, items });
      order.push(`appendAcceptance:${ref}:${items.length}`);
      return { ok: true };
    },
    notify: () => {},
    now: () => NOW,
    log: () => {},
  });
  return { plan, wirePlan, order, result, appends, metas };
}

const APPROVE_ORDER = [
  "land:PROJ-0001",
  'setMeta:PROJ-0001:{"accepted_by":"loop-review","accepted_round":"1"}',
  "comment:PROJ-0001:note",
  "move:PROJ-0001:done",
  "comment:PROJ-0002:note",
  "move:PROJ-0002:done",
];

// The must-fix append sits **after** the move to `in_progress` (the round bump
// is what unlocks the baseline) and **before** the card leaves for `todo`.
const REJECT_TASK_ORDER = [
  'setMeta:PROJ-0001:{"rework_round":"2"}',
  "comment:PROJ-0001:change",
  "move:PROJ-0001:in_progress",
  "appendAcceptance:PROJ-0001:1",
  "move:PROJ-0001:todo",
  "comment:PROJ-0002:note",
  "move:PROJ-0002:done",
];

const REJECT_EPIC_ORDER = [
  "createFixChild:PROJ-0001",
  "linkFixChild:PROJ-0001:PROJ-0004",
  'setMeta:PROJ-0001:{"rework_round":"2"}',
  "comment:PROJ-0001:change",
  "move:PROJ-0001:in_progress",
  "appendAcceptance:PROJ-0001:1",
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
      "land:PROJ-0001",
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
    name: "approve (acceptance marker already landed)",
    tasks: (() => {
      const original = card({ meta: { accepted_by: "loop-review", accepted_round: "1" } });
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("APPROVE") },
    expectedAction: "approve",
    expectedOrder: [
      "land:PROJ-0001",
      "move:PROJ-0001:done",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ],
  },
  {
    name: "create_review (epic dispatch)",
    tasks: [card({ kind: "epic" })],
    expectedAction: "create_review",
    expectedOrder: ["createReview:loop-review|PROJ-0001|r1"],
  },
  {
    name: "approve (epic, on a faithful rollup)",
    tasks: (() => {
      const original = card({ kind: "epic" });
      const child = card({
        id: "T-3",
        identifier: "PROJ-0003",
        status: "done",
        parent_id: original.id,
        acceptance_mode: "off",
      });
      const review = reviewCard(original);
      return [original, child, review];
    })(),
    verdicts: { "PROJ-0002": verdict("APPROVE") },
    reportsByRef: {
      "PROJ-0001": {
        is_rollup: true,
        acceptance: [{ ref: "PROJ-0003", status: "met", note: "done" }],
        evidence: [{ kind: "commit", sha: "abc1234" }],
      },
    },
    expectedAction: "approve",
    expectedOrder: APPROVE_ORDER,
  },
  {
    name: "record_verdict (human approve)",
    tasks: (() => {
      const original = card({ acceptance_mode: "human" });
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("APPROVE") },
    expectedAction: "record_verdict",
    expectedOrder: [
      'setMeta:PROJ-0001:{"review_verdict":"approve","review_verdict_round":"1"}',
      "comment:PROJ-0001:note",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ],
  },
  {
    name: "record_verdict (human approve, marker already applied)",
    tasks: (() => {
      const original = card({
        acceptance_mode: "human",
        meta: { review_verdict: "approve", review_verdict_round: "1" },
      });
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("APPROVE") },
    expectedAction: "record_verdict",
    expectedOrder: ["comment:PROJ-0002:note", "move:PROJ-0002:done"],
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
    name: "reject_task (rework marker already applied)",
    tasks: (() => {
      const original = card({ meta: { rework_round: "2" } });
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: { "PROJ-0002": verdict("REJECT", "the acceptance list is missing a case") },
    expectedAction: "reject_task",
    expectedOrder: [
      "move:PROJ-0001:in_progress",
      "appendAcceptance:PROJ-0001:1",
      "move:PROJ-0001:todo",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ],
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
    expectedOrder: [
      "appendAcceptance:PROJ-0001:1",
      "move:PROJ-0001:todo",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ],
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
  {
    name: "reopen_review (verdict unreadable)",
    tasks: (() => {
      const original = card();
      const review = reviewCard(original);
      return [original, review];
    })(),
    verdicts: {},
    expectedAction: "reopen_review",
    expectedOrder: [
      "comment:PROJ-0002:note",
      `setMeta:PROJ-0002:{"review_retry":"1","review_reopen_at":"${NOW}"}`,
      "move:PROJ-0002:in_progress",
      "move:PROJ-0002:todo",
    ],
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

  it("keeps the card out of done when the lane branch cannot be merged", async () => {
    const original = card();
    const review = reviewCard(original);
    const landing = [];
    const { order, result } = await throughBothHalves(
      { tasks: [original, review], verdicts: { "PROJ-0002": verdict("APPROVE") } },
      {
        land: async (action) => (
          landing.push(action.original_ref),
          { ok: false, error: "WORKSPACE_MERGE_CONFLICT: conflict" }
        ),
      },
    );
    assert.equal(result.failed, 1);
    assert.deepEqual(landing, ["PROJ-0001"], "landing is attempted first");
    assert.deepEqual(order, [], "no acceptance write happens before the landing");
  });

  it("a refused `done` is routed back for a new round instead of retried for ever", async () => {
    const deps = (record) => ({
      config: { workflow: true, maxActions: 20, reviewAgingMs: 60 * 60_000 },
      dryRun: false,
      land: async () => ({ ok: true }),
      createReview: async () => ({ ok: true }),
      createFixChild: async () => ({ ok: true }),
      linkFixChild: async () => ({ ok: true }),
      move: async (ref, to) => (record.push(`move:${ref}:${to}`), { ok: true }),
      comment: async (ref, { kind }) => (record.push(`comment:${ref}:${kind}`), { ok: true }),
      setMeta: async (ref, meta) => (record.push(`setMeta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
      appendAcceptance: async () => ({ ok: true }),
      notify: () => {},
      now: () => NOW,
      log: () => {},
    });

    const original = card();
    const review = reviewCard(original);
    const plan = planWorkflowTick({
      tasks: [original, review],
      verdicts: { "PROJ-0002": verdict("APPROVE") },
      config: CONFIG,
      now: NOW,
    });

    // The live failure: the board's acceptance gate refuses the `done` move
    // because the delivery report cannot close the card. Retrying the same move
    // changes nothing — the report binds its round — so the refusal is routed
    // back to the worker as a new round, and the review card is closed.
    const first = [];
    const notes = [];
    const blockedRun = await runWorkflowTick({
      ...deps(first),
      plan: workflowToWire(plan),
      move: async (ref, to) => {
        first.push(`move:${ref}:${to}`);
        if (ref === "PROJ-0001" && to === "done") {
          return {
            ok: false,
            error: "PROJ-0001: 1 blocking acceptance item(s) for delivery round 1",
            code: "ACCEPTANCE_INCOMPLETE",
            details: {
              identifier: "PROJ-0001",
              round: 1,
              blocking: [{ text: "the gate has run", status: "partial" }],
              unsupported: [],
            },
          };
        }
        return { ok: true };
      },
      notify: (alert) => notes.push(alert),
    });
    assert.equal(blockedRun.failed, 0, "a routed refusal is not a failure");
    assert.equal(blockedRun.blocked, 1);
    assert.deepEqual(first, [
      'setMeta:PROJ-0001:{"accepted_by":"loop-review","accepted_round":"1"}',
      "comment:PROJ-0001:note",
      "move:PROJ-0001:done",
      "comment:PROJ-0001:change",
      "move:PROJ-0001:in_progress",
      "move:PROJ-0001:todo",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ]);
    assert.deepEqual(notes.map((alert) => alert.type), ["acceptance_blocked"]);
  });

  it("routes a refused auto_accept the same way, with no review card to close", async () => {
    const record = [];
    const plan = planWorkflowTick({
      tasks: [card({ acceptance_mode: "off" })],
      config: CONFIG,
      now: NOW,
    });
    const result = await runWorkflowTick({
      plan: workflowToWire(plan),
      config: { workflow: true, maxActions: 20, reviewAgingMs: 60 * 60_000 },
      dryRun: false,
      land: async () => ({ ok: true }),
      move: async (ref, to) => {
        record.push(`move:${ref}:${to}`);
        return ref === "PROJ-0001" && to === "done"
          ? { ok: false, error: "PROJ-0001: 1 blocking", code: "ACCEPTANCE_INCOMPLETE", details: {} }
          : { ok: true };
      },
      comment: async (ref, { kind }) => (record.push(`comment:${ref}:${kind}`), { ok: true }),
      setMeta: async (ref, meta) => (record.push(`setMeta:${ref}:${JSON.stringify(meta)}`), { ok: true }),
      notify: () => {},
      now: () => NOW,
      log: () => {},
    });

    assert.equal(result.failed, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(record.slice(-3), [
      "comment:PROJ-0001:change",
      "move:PROJ-0001:in_progress",
      "move:PROJ-0001:todo",
    ]);
  });

  it("records the commit the acceptance landed, in the same meta write", async () => {
    const original = card();
    const review = reviewCard(original);
    const { metas } = await throughBothHalves(
      { tasks: [original, review], verdicts: { "PROJ-0002": verdict("APPROVE") } },
      { land: async () => ({ ok: true, sha: "abc1234" }) },
    );

    assert.deepEqual(metas[0], {
      ref: "PROJ-0001",
      meta: {
        accepted_by: "loop-review",
        accepted_round: "1",
        landed_sha: "abc1234",
        landed_at: NOW,
      },
    });
  });

  it("writes no landing marker when there was no lane to merge", async () => {
    const original = card();
    const review = reviewCard(original);
    const { metas } = await throughBothHalves(
      { tasks: [original, review], verdicts: { "PROJ-0002": verdict("APPROVE") } },
      { land: async () => ({ ok: true }) },
    );

    assert.deepEqual(metas[0].meta, { accepted_by: "loop-review", accepted_round: "1" });
    assert.equal("landed_sha" in metas[0].meta, false, "absent means unknown, not unlanded");
  });

  it("dispatches a delivered human card through the same create_review action", async () => {
    const { plan, order } = await throughBothHalves({
      tasks: [card({ acceptance_mode: "human" })],
      verdicts: {},
    });
    assert.deepEqual(plan.actions.map((action) => action.type), ["create_review"]);
    assert.deepEqual(order, ["createReview:loop-review|PROJ-0001|r1"]);
  });

  it("dispatches a delivered human epic, and applies its verdict without moving it", async () => {
    const original = card({ kind: "epic", acceptance_mode: "human" });
    const child = card({
      id: "T-3",
      identifier: "PROJ-0003",
      status: "done",
      parent_id: original.id,
      acceptance_mode: "off",
    });
    const dispatch = await throughBothHalves({ tasks: [original], verdicts: {} });
    assert.deepEqual(dispatch.plan.actions.map((action) => action.type), ["create_review"]);
    assert.deepEqual(dispatch.order, ["createReview:loop-review|PROJ-0001|r1"]);

    const applied = await throughBothHalves({
      tasks: [original, child, reviewCard(original)],
      verdicts: { "PROJ-0002": verdict("APPROVE") },
      reportsByRef: {
        "PROJ-0001": {
          is_rollup: true,
          acceptance: [{ ref: "PROJ-0003", status: "met", note: "done" }],
          evidence: [{ kind: "commit", sha: "abc1234" }],
        },
      },
    });
    assert.deepEqual(applied.plan.actions.map((action) => action.type), ["record_verdict"]);
    assert.deepEqual(applied.order, [
      'setMeta:PROJ-0001:{"review_verdict":"approve","review_verdict_round":"1"}',
      "comment:PROJ-0001:note",
      "comment:PROJ-0002:note",
      "move:PROJ-0002:done",
    ]);
  });

  it("sends the reviewer's numbered items, and nothing when the baseline already carries them", async () => {
    const original = card();
    const listed = await throughBothHalves({
      tasks: [original, reviewCard(original)],
      verdicts: { "PROJ-0002": verdict("REJECT", "1. add the e2e case\n2. fix the round guard") },
    });
    assert.deepEqual(listed.appends, [
      { ref: "PROJ-0001", items: ["add the e2e case", "fix the round guard"] },
    ]);

    const pointer =
      "Every finding in the PROJ-0002 review of round 1 is resolved or explicitly deferred";
    const retried = card({ acceptance: [pointer] });
    const already = await throughBothHalves({
      tasks: [retried, reviewCard(retried)],
      verdicts: { "PROJ-0002": verdict("REJECT", "the prose has no list") },
    });
    assert.deepEqual(already.appends, [], "a retried pass appends nothing twice");
  });

  it("keeps every planner action's fields inside the frozen plan shape", () => {
    // The contract snapshot freezes these field sets. A live planner action that
    // grows a field the snapshot does not know is exactly the drift the
    // hand-built fixture cannot catch.
    const frozen = {
      create_review: ["type", "original_ref", "project_id", "reviewer", "round", "idem", "target", "title", "description", "acceptance"],
      auto_accept: ["type", "original_ref", "round", "accepted_by", "held"],
      approve: ["type", "review_status", "review_ref", "original_ref", "round", "close_review", "accepted_by", "held"],
      record_verdict: ["type", "review_status", "review_ref", "original_ref", "round", "reason", "close_review", "held"],
      reject_task: ["type", "review_status", "review_ref", "original_ref", "round", "rework_round", "findings", "must_fix", "close_review", "held"],
      reject_epic: [
        "type", "review_status", "review_ref", "original_ref", "round", "rework_round",
        "project_id", "assignee_id", "original_title", "acceptance_mode", "findings", "must_fix", "close_review", "held",
      ],
      reject_task_finish: ["type", "review_status", "review_ref", "original_ref", "round", "must_fix", "close_review"],
      reopen_review: ["type", "review_status", "review_ref", "original_ref", "round", "retry", "reason"],
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
