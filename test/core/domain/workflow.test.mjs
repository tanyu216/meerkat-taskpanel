/**
 * The workflow sub-pass (`src/core/domain/workflow.mjs`) — the loop's orchestration
 * decisions, proven without a board.
 *
 * The properties that matter, and why they are counter-proofs rather than
 * smoke tests:
 *
 *   * **one review card per (original, round)** — a re-delivery is a new round
 *     and must be reviewed again; a stale review card must not silence it;
 *   * **the reviewer reports, the loop moves** — no plan action moves a card
 *     without a readable verdict, and an unreadable one is an alarm;
 *   * **fail-safe** — an unseen original, a stale round or a conflicting
 *     verdict produces an alert and no write;
 *   * **`autoAcceptReviews` gates only the review card** — the verdict on the
 *     original is always applied;
 *   * **bounded** — one pass performs at most `maxActions` writes.
 *
 * Pure: no clock, no board, no filesystem.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_EPIC_GRACE_MS,
  LOOP_ACCEPTOR,
  LOOP_AUTO_ACCEPTOR,
  classifyReconcileActions,
  flowOf,
  isReviewCard,
  isSelfReview,
  mustFixItems,
  parseReviewVerdict,
  planAutoAccept,
  planReviewDispatch,
  planReviewOutcomes,
  planReviewOutcomes as outcomes,
  planWorkflowTick,
  reviewIdemKey,
  reviewOf,
  reviewRoundOf,
  reworkIdemKey,
  roundOf,
} from "../../../src/core/domain/workflow.mjs";

const NOW = "2026-10-19T10:00:00.000Z";

function card(fields = {}) {
  const identifier = fields.identifier ?? "T-1";
  // 0038 — the planner reads `acceptance_mode`. Most fixtures describe a card
  // that is dispatched for review.
  return {
    id: `id-${identifier}`,
    identifier,
    title: "Do the thing",
    status: "in_review",
    kind: "task",
    project_id: "proj",
    assignee_id: "agent-1",
    assignee: { id: "agent-1", display_name: "linus", kind: "agent" },
    delivery_round: 1,
    status_changed_at: "2026-10-19T09:00:00.000Z",
    created_at: "2026-10-18T09:00:00.000Z",
    acceptance_mode: fields.acceptance_mode ?? "agent",
    parent_id: null,
    meta: {},
    ...fields,
  };
}

function reviewCard(fields = {}) {
  return card({
    identifier: "T-2",
    title: "Review T-1",
    status: "in_review",
    delivery_round: 0,
    assignee_id: "agent-jobs",
    assignee: { id: "agent-jobs", display_name: "jobs", kind: "agent" },
    acceptance_mode: "off",
    meta: { review_of: "T-1", flow: "B", review_round: 1 },
    ...fields,
  });
}

/**
 * A review card whose identity lives only in the structural columns — the shape
 * a raw insert (or a board assembled without the meta mirror) produces. The
 * planners must resolve the original through the id index, not the meta.
 */
function columnOnlyReview(fields = {}) {
  return card({
    identifier: "T-2",
    title: "Review T-1",
    status: "in_review",
    delivery_round: 0,
    assignee_id: "agent-jobs",
    assignee: { id: "agent-jobs", display_name: "jobs", kind: "agent" },
    acceptance_mode: "off",
    review_of_id: "id-T-1",
    review_round: 1,
    meta: { flow: "B" },
    ...fields,
  });
}

/** The author a verdict report must carry to be the configured reviewer's. */
const REVIEWER_REPORT = {
  evidence: [{ kind: "command", cmd: "node --test test/thing.test.mjs", exit_code: 0 }],
  author: { id: "agent-jobs", display_name: "jobs", kind: "agent" },
  author_id: "agent-jobs",
};

const CONFIG = { reviewer: "jobs", maxActions: 20 };

const types = (result) => result.actions.map((action) => action.type);

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe("workflow predicates", () => {
  it("reads flow, review target, round and review round", () => {
    assert.equal(flowOf({}), "A", "an absent flow is A — the fail-safe direction");
    assert.equal(flowOf({ meta: { flow: "b" } }), "B");
    assert.equal(isReviewCard({}), false);
    assert.equal(isReviewCard({ meta: { review_of: "T-1" } }), true);
    assert.equal(isReviewCard({ meta: { review_of: "   " } }), false);
    assert.equal(reviewOf({ meta: { review_of: " T-1 " } }), "T-1");
    assert.equal(roundOf({}), 0);
    assert.equal(roundOf({ delivery_round: "3" }), 3);
    assert.equal(reviewRoundOf({ meta: { review_round: "4" } }), 4);
    assert.equal(reviewRoundOf({ meta: { review_round: "four" } }), null);
  });

  it("builds one deterministic idempotency key per original per round", () => {
    assert.equal(reviewIdemKey("T-1", 2), "loop-review|T-1|r2");
    assert.equal(reworkIdemKey("T-1", 2), "loop-rework|T-1|r2");
  });

  it("treats the assignee/claimer as the card's own author (self-review)", () => {
    const original = card({ identifier: "T-1" });
    assert.equal(isSelfReview(original, "linus"), true, "the assignee's display name");
    assert.equal(isSelfReview(original, "AGENT-1"), true, "the assignee's id, case-insensitively");
    assert.equal(isSelfReview(original, "jobs"), false);
    assert.equal(isSelfReview(card({ claimed_by: "linus" }), "linus"), true, "the claimant counts too");
    assert.equal(isSelfReview(original, ""), false);
  });
});

// ---------------------------------------------------------------------------
// The verdict protocol
// ---------------------------------------------------------------------------

describe("parseReviewVerdict", () => {
  it("reads APPROVE / REJECT from the first line, case- and space-insensitively", () => {
    const reports = [{ round: 1, conclusion: "verdict: approve\nthe acceptance list is covered", leftovers: "" }];
    const parsed = parseReviewVerdict(reports, 1);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verdict, "APPROVE");
    assert.match(parsed.findings, /acceptance list is covered/);

    assert.equal(parseReviewVerdict([{ round: 1, conclusion: "  VERDICT :  reject  \nnope" }], 1).verdict, "REJECT");
  });

  it("carries the findings and the report's leftovers into one bounded comment", () => {
    const parsed = parseReviewVerdict(
      [{ round: 1, conclusion: "VERDICT: REJECT\n- gate untested", leftovers: "missing e2e" }],
      1,
    );
    assert.equal(parsed.verdict, "REJECT");
    assert.match(parsed.findings, /gate untested/);
    assert.match(parsed.findings, /missing e2e/);

    const huge = parseReviewVerdict([{ round: 1, conclusion: `VERDICT: REJECT\n${"x".repeat(10_000)}` }], 1);
    assert.ok(huge.findings.length <= 4_000);
    assert.match(huge.findings, /…$/);
  });

  it("uses only the report for the round under review, and the last one", () => {
    const reports = [
      { round: 1, conclusion: "VERDICT: REJECT" },
      { round: 2, conclusion: "VERDICT: APPROVE" },
    ];
    assert.equal(parseReviewVerdict(reports, 2).verdict, "APPROVE");
    assert.equal(parseReviewVerdict(reports, 1).verdict, "REJECT");
    assert.equal(parseReviewVerdict(reports, 3).ok, false);
    assert.equal(parseReviewVerdict(reports, 3).reason, "no_report");
    assert.equal(
      parseReviewVerdict(
        [
          { round: 2, conclusion: "VERDICT: REJECT" },
          { round: 2, conclusion: "VERDICT: APPROVE" },
        ],
        2,
      ).verdict,
      "APPROVE",
      "a second delivery supersedes the first",
    );
    // A legacy review card with no recorded round reads the latest report.
    assert.equal(parseReviewVerdict(reports, null).verdict, "APPROVE");
  });

  it("refuses a report with no verdict line", () => {
    assert.equal(parseReviewVerdict([{ round: 1, conclusion: "looks fine to me" }], 1).reason, "no_verdict");
    assert.equal(parseReviewVerdict([], 1).reason, "no_report");
    assert.equal(parseReviewVerdict(null, 1).reason, "no_report");
  });
});

// ---------------------------------------------------------------------------
// Reconcile classification
// ---------------------------------------------------------------------------

describe("classifyReconcileActions", () => {
  const action = (reason, extra = {}) => ({ epic: "E-1", status: "todo", action: "none", reason, ...extra });

  it("records start/close as changes and does not notify", () => {
    const { alerts, changes } = classifyReconcileActions(
      [
        { epic: "E-1", status: "todo", action: "start", reason: "child_in_progress", child: "T-1" },
        { epic: "E-2", status: "in_progress", action: "close", reason: "all_children_terminal", children: 2 },
      ],
      { now: NOW },
    );
    assert.deepEqual(alerts, []);
    assert.deepEqual(changes, [
      { epic: "E-1", action: "start", reason: "child_in_progress", child: "T-1" },
      { epic: "E-2", action: "close", reason: "all_children_terminal" },
    ]);
  });

  it("stays quiet for normal in-flight verdicts", () => {
    const { alerts, changes } = classifyReconcileActions(
      ["children_unfinished", "no_child_started", "awaiting_acceptance"].map((reason) => action(reason)),
      { now: NOW },
    );
    assert.deepEqual(alerts, []);
    assert.deepEqual(changes, []);
  });

  it("alerts on verdicts a human has to look at, naming blocking children", () => {
    const blocking = [{ identifier: "T-3", status: "todo" }];
    const { alerts } = classifyReconcileActions(
      [action("no_delivery_evidence", { blocking }), action("no_child_done"), action("dangling_child_edge")],
      { now: NOW },
    );
    assert.deepEqual(alerts.map((alert) => alert.reason), [
      "no_delivery_evidence",
      "no_child_done",
      "dangling_child_edge",
    ]);
    assert.deepEqual(alerts[0].blocking, blocking);
  });

  it("alerts on an empty epic only after the grace period", () => {
    const byRef = new Map([["E-1", { identifier: "E-1", created_at: new Date(Date.parse(NOW) - 1_000).toISOString() }]]);
    assert.deepEqual(classifyReconcileActions([action("empty_epic")], { byRef, now: NOW }).alerts, []);

    const old = new Map([
      ["E-1", { identifier: "E-1", created_at: new Date(Date.parse(NOW) - EMPTY_EPIC_GRACE_MS - 1).toISOString() }],
    ]);
    assert.deepEqual(
      classifyReconcileActions([action("empty_epic")], { byRef: old, now: NOW }).alerts.map((a) => a.reason),
      ["empty_epic"],
    );

    // An epic the snapshot did not include is not silently excused.
    assert.equal(classifyReconcileActions([action("empty_epic")], { now: NOW }).alerts.length, 1);
  });

  it("surfaces an unknown reason rather than dropping it", () => {
    assert.deepEqual(
      classifyReconcileActions([action("something_new")], { now: NOW }).alerts.map((a) => a.reason),
      ["something_new"],
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("planReviewDispatch", () => {
  it("creates one review card for a delivered flow-A card", () => {
    const result = planReviewDispatch({ tasks: [card()], config: CONFIG });
    assert.deepEqual(types(result), ["create_review"]);
    const action = result.actions[0];
    assert.equal(action.originalRef, "T-1");
    assert.equal(action.projectId, "proj");
    assert.equal(action.reviewer, "jobs");
    assert.equal(action.round, 1);
    assert.equal(action.idem, "loop-review|T-1|r1");
    assert.equal(action.target, "review:T-1:r1");
    assert.match(action.title, /^Review T-1: /);
    assert.match(action.description, /VERDICT: APPROVE/);
    assert.match(action.description, /Do not move the original card/);
    assert.deepEqual(action.acceptance, [
      "The delivery report is consistent with its evidence anchors",
      "The comment trail has no unresolved decision/defect entry",
      "Every requirement in the original description, comments and plan is covered by an acceptance item or explicitly deferred with a recorded decision",
      "The delivery matches .meerkat/T-1/plan.md, or every deviation is recorded and justified",
    ]);
  });

  it("carries the original's frozen baseline into the review card's own baseline", () => {
    const result = planReviewDispatch({
      tasks: [card({ acceptance: ["cli works", "gate visible"] })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions[0].acceptance, [
      "cli works",
      "gate visible",
      "The delivery report is consistent with its evidence anchors",
      "The comment trail has no unresolved decision/defect entry",
      "Every requirement in the original description, comments and plan is covered by an acceptance item or explicitly deferred with a recorded decision",
      "The delivery matches .meerkat/T-1/plan.md, or every deviation is recorded and justified",
    ]);
  });

  it("uses the larger checklist on an epic, where the children stand in for the list", () => {
    const result = planReviewDispatch({
      tasks: [card({ kind: "epic", acceptance: ["container goal"] })],
      config: CONFIG,
    });
    const action = result.actions[0];
    assert.equal(action.acceptance[0], "container goal");
    assert.match(action.acceptance[1], /Every child of T-1/);
    assert.equal(action.acceptance.length, 7);
    assert.ok(action.acceptance.some((text) => /Every child's scope and plan/.test(text)));
  });

  it("tells the reviewer to run the unconditional omission check", () => {
    const action = planReviewDispatch({ tasks: [card()], config: CONFIG }).actions[0];
    assert.match(action.description, /Omission check/);
    assert.match(action.description, /narrowed acceptance list/);
    assert.match(action.description, /REJECT/);
    assert.match(action.description, /plan\.md \(the worker's plan\)/);
    assert.match(action.description, /absence alone is not a reject/);
    assert.equal(action.acceptance.length, 4, "the generic review checklist now includes coverage");
  });

  it("names the project's declared gate, and says so when there is none", () => {
    const declared = planReviewDispatch({
      tasks: [card()],
      config: { ...CONFIG, projectGates: { proj: "npm run verify:docker" } },
    }).actions[0];
    assert.match(declared.description, /Declared gate: npm run verify:docker/);

    const none = planReviewDispatch({ tasks: [card()], config: CONFIG }).actions[0];
    assert.match(none.description, /No gate is declared/i);
    assert.match(none.description, /n\/a — none declared/);
  });

  it("never reviews a review card or a card not in review", () => {
    const result = planReviewDispatch({
      tasks: [
        reviewCard(),
        card({ identifier: "T-4", status: "in_progress" }),
      ],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, []);
  });

  it("does not let a patchable meta.flow exempt a card from review", () => {
    // `flow` is a loop label, not the predicate. A card whose meta says B but
    // which carries no structural marker is still reviewable — otherwise one
    // meta write would bypass the independent review.
    const result = planReviewDispatch({
      tasks: [card({ identifier: "T-3", meta: { flow: "B" } })],
      config: CONFIG,
    });
    assert.deepEqual(types(result), ["create_review"]);
  });

  it("resolves a column-only review card through the id index", () => {
    // No `meta.review_of`: the marker is the only identity. The planner must
    // still see that this round is already covered, not dispatch a second card.
    const result = planReviewDispatch({
      tasks: [card(), columnOnlyReview({ status: "in_progress" })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, []);
  });

  it("waits for an active review card, and recreates after a canceled one", () => {
    const active = planReviewDispatch({
      tasks: [card(), reviewCard({ status: "in_progress" })],
      config: CONFIG,
    });
    assert.deepEqual(active.actions, []);

    const canceled = planReviewDispatch({
      tasks: [card(), reviewCard({ status: "canceled" })],
      config: CONFIG,
    });
    assert.deepEqual(types(canceled), ["create_review"], "a terminal review card releases the key");
  });

  it("reviews a new round even when a review card for the old round exists", () => {
    const result = planReviewDispatch({
      tasks: [card({ delivery_round: 2 }), reviewCard({ status: "done", meta: { review_of: "T-1", flow: "B", review_round: 1 } })],
      config: CONFIG,
    });
    assert.deepEqual(types(result), ["create_review"]);
    assert.equal(result.actions[0].round, 2);
    assert.equal(result.actions[0].idem, "loop-review|T-1|r2");
  });

  it("alerts instead of re-creating when a done review card left the original open", () => {
    const result = planReviewDispatch({
      tasks: [card(), reviewCard({ status: "done" })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["review_done_but_original_open"]);
  });

  it("treats a review card written before review_round as covering every round", () => {
    const legacy = reviewCard({ status: "todo", meta: { review_of: "T-1", flow: "B" } });
    assert.deepEqual(planReviewDispatch({ tasks: [card(), legacy], config: CONFIG }).actions, []);
  });

  it("refuses a self-review and says why", () => {
    const result = planReviewDispatch({
      tasks: [card({ assignee: { id: "jobs", display_name: "jobs", kind: "agent" } })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["self_review_not_independent"]);
  });

  it("dispatches nothing over a truncated board read", () => {
    const result = planReviewDispatch({ tasks: [card()], config: CONFIG, boardTruncated: true });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, [{ type: "dispatch_skipped", reason: "board_truncated" }]);
  });

  it("reports an unconfigured reviewer once, with the size of the backlog", () => {
    const result = planReviewDispatch({ tasks: [card()], config: { ...CONFIG, reviewer: null } });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, [
      {
        type: "dispatch_skipped",
        reason: "reviewer_not_configured",
        waiting: 1,
        projects: [{ project: "proj", waiting: 1 }],
      },
    ]);
    assert.deepEqual(planReviewDispatch({ tasks: [], config: { ...CONFIG, reviewer: null } }).alerts, []);
  });

  it("orders oldest-first and honours the write cap", () => {
    const tasks = [
      card({ identifier: "T-1", status_changed_at: "2026-10-19T09:30:00.000Z" }),
      card({ identifier: "T-2", status_changed_at: "2026-10-19T08:00:00.000Z" }),
      card({ identifier: "T-3", status_changed_at: "2026-10-19T09:00:00.000Z" }),
    ];
    const result = planReviewDispatch({ tasks, config: { ...CONFIG, maxActions: 2 } });
    assert.deepEqual(result.actions.map((action) => action.originalRef), ["T-2", "T-3"]);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["dispatch_capped"]);
  });

  it("is deterministic on a tie", () => {
    const tasks = [
      card({ identifier: "T-2", status_changed_at: NOW }),
      card({ identifier: "T-1", status_changed_at: NOW }),
    ];
    assert.deepEqual(
      planReviewDispatch({ tasks, config: CONFIG }).actions.map((action) => action.originalRef),
      ["T-1", "T-2"],
    );
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("planReviewOutcomes", () => {
  const approve = { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT };
  const reject = { ok: true, verdict: "REJECT", findings: "- the gate is untested", report: REVIEWER_REPORT };

  it("applies a verdict from a review whose identity is only in the column", () => {
    // Without the id index, `reviewOf` would return null and the outcome would
    // be `original_unseen`: the exact column-only hole this reader closes.
    const result = planReviewOutcomes({
      tasks: [card(), columnOnlyReview()],
      verdicts: { "T-2": approve },
      config: CONFIG,
    });
    assert.deepEqual(types(result), ["approve"]);
    assert.equal(result.actions[0].originalRef, "T-1");
  });

  it("approves the original and closes the review card", () => {
    const result = planReviewOutcomes({ tasks: [card(), reviewCard()], verdicts: { "T-2": approve }, config: CONFIG });
    assert.deepEqual(result.actions, [
      { type: "approve", reviewStatus: "in_review", reviewRef: "T-2", originalRef: "T-1", round: 1, closeReview: true, acceptedBy: LOOP_ACCEPTOR },
    ]);
    assert.deepEqual(result.alerts, []);
  });

  it("does not approve when the verdict's report misses a baseline criterion", () => {
    const original = card({ acceptance: ["a", "b"] });
    const verdict = {
      ...approve,
      report: { ...REVIEWER_REPORT, acceptance: [{ text: "a", status: "met" }] },
    };
    const result = planReviewOutcomes({
      tasks: [original, reviewCard()],
      verdicts: { "T-2": verdict },
      config: CONFIG,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(result.actions[0].reason, "acceptance_incomplete");
    assert.equal(result.alerts[0].type, "verdict_incomplete");
    assert.deepEqual(result.alerts[0].missing, ["b"]);
  });

  it("does not approve a met criterion that names no anchor", () => {
    const original = card({ acceptance: ["a"] });
    const verdict = {
      ...approve,
      report: {
        ...REVIEWER_REPORT,
        acceptance: [{ text: "a", status: "met", note: "looks right" }],
      },
    };
    const result = planReviewOutcomes({
      tasks: [original, reviewCard()],
      verdicts: { "T-2": verdict },
      config: CONFIG,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(result.actions[0].reason, "evidence_missing");
    assert.equal(result.alerts[0].type, "verdict_unsupported");
    assert.deepEqual(result.alerts[0].unsupported, ["a"]);
  });

  it("does not approve when the reviewer ran nothing", () => {
    const verdict = {
      ...approve,
      report: { ...REVIEWER_REPORT, evidence: [{ kind: "path", path: "src/thing.mjs" }] },
    };
    const result = planReviewOutcomes({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": verdict },
      config: CONFIG,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(result.actions[0].reason, "no_command_evidence");
    assert.equal(result.alerts[0].type, "verdict_unsupported");
  });

  it("does not approve an epic whose rollup is missing or stale", () => {
    const epic = card({ kind: "epic", identifier: "E-1" });
    const child = card({ identifier: "T-9", status: "done", parent_id: "id-E-1" });
    const review = reviewCard({ meta: { review_of: "E-1", flow: "B", review_round: 1 } });

    const missing = planReviewOutcomes({
      tasks: [epic, child, review],
      verdicts: { "T-2": approve },
      config: CONFIG,
    });
    assert.deepEqual(missing.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(missing.alerts[0].type, "verdict_incomplete");
    assert.equal(missing.alerts[0].reason, "rollup_unverified");

    const stale = planReviewOutcomes({
      tasks: [epic, child, review],
      verdicts: { "T-2": approve },
      reportsByRef: { "E-1": { is_rollup: true, acceptance: [] } },
      config: CONFIG,
    });
    assert.deepEqual(stale.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(stale.alerts[0].reason, "rollup_stale");
    assert.deepEqual(stale.alerts[0].missingChildren, ["T-9"]);

    const ok = planReviewOutcomes({
      tasks: [epic, child, review],
      verdicts: { "T-2": approve },
      reportsByRef: {
        "E-1": {
          is_rollup: true,
          acceptance: [{ text: "child done", status: "met", ref: "T-9" }],
        },
      },
      config: CONFIG,
    });
    assert.deepEqual(ok.actions.map((action) => action.type), ["approve"]);
  });

  it("rejects a task through in_review → in_progress → todo, carrying the findings", () => {
    const result = outcomes({ tasks: [card(), reviewCard()], verdicts: { "T-2": reject }, config: CONFIG });
    assert.deepEqual(types(result), ["reject_task"]);
    assert.equal(result.actions[0].findings, "- the gate is untested");
    assert.equal(result.actions[0].closeReview, true);
    assert.equal(result.actions[0].reworkRound, 2, "the round the card is on after leaving in_review");
  });

  it("recovers a reject already marked on the original (held)", () => {
    const result = outcomes({
      tasks: [card({ meta: { rework_round: "2" } }), reviewCard()],
      verdicts: { "T-2": reject },
      config: CONFIG,
    });
    assert.deepEqual(types(result), ["reject_task"]);
    assert.equal(result.actions[0].held, true, "the move is retried; the rejection is not re-posted");
  });

  it("does not hold a reject whose marker names another round", () => {
    const result = outcomes({
      tasks: [card({ meta: { rework_round: "3" } }), reviewCard()],
      verdicts: { "T-2": reject },
      config: CONFIG,
    });
    assert.equal(result.actions[0].held, undefined);
  });

  it("carries the reviewer's numbered must-fix list into the reject action", () => {
    const findings = [
      "VERDICT: REJECT",
      "",
      "1. `src/a.mjs:10` — the guard reads the old round",
      "- [ ] the e2e case for a canceled child is missing",
      "",
      "Prose that is not a list stays out.",
      "- a plain bullet is context, not a must-fix",
    ].join("\n");
    assert.deepEqual(mustFixItems(findings), [
      "`src/a.mjs:10` — the guard reads the old round",
      "the e2e case for a canceled child is missing",
    ]);
    const result = outcomes({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": { ok: true, verdict: "REJECT", findings, report: REVIEWER_REPORT } },
      config: CONFIG,
    });
    assert.deepEqual(result.actions[0].mustFix, mustFixItems(findings));
  });

  it("bounds the must-fix list and falls back to a pointer when there is none", () => {
    const many = Array.from({ length: 13 }, (_, index) => `${index + 1}. fix ${index + 1}`).join("\n");
    assert.equal(mustFixItems(many).length, 10, "at most ten items cross into the baseline");
    assert.ok(mustFixItems(`1. ${"x".repeat(500)}`)[0].length <= 400, "one item is bounded");

    const prose = outcomes({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": { ok: true, verdict: "REJECT", findings: "The gate needs work", report: REVIEWER_REPORT } },
      config: CONFIG,
    });
    assert.equal(prose.actions[0].mustFix.length, 1);
    assert.match(prose.actions[0].mustFix[0], /round 1/);
    assert.match(prose.actions[0].mustFix[0], /T-2/);
  });

  it("rejects an epic by first creating a fix child, so reconcile cannot re-close it", () => {
    const epic = card({ kind: "epic", identifier: "E-1" });
    const review = reviewCard({ meta: { review_of: "E-1", flow: "B", review_round: 1 } });
    const result = outcomes({ tasks: [epic, review], verdicts: { "T-2": reject }, config: CONFIG });
    assert.deepEqual(types(result), ["reject_epic"]);
    assert.equal(result.actions[0].projectId, "proj");
    assert.equal(result.actions[0].assigneeId, "agent-1");
    assert.match(result.actions[0].findings, /gate is untested/);
  });

  it("finishes the two-step rework after a crash", () => {
    // The rejection bumped the delivery round (1 → 2) before the loop died, so
    // the marker is the *new* round and matches the card's current one.
    const inProgress = card({ status: "in_progress", delivery_round: 2, meta: { rework_round: 2 } });
    assert.deepEqual(types(outcomes({ tasks: [inProgress, reviewCard()], verdicts: { "T-2": reject }, config: CONFIG })), [
      "reject_task_finish",
    ]);

    const todo = card({ status: "todo", delivery_round: 2, meta: { rework_round: 2 } });
    assert.deepEqual(types(outcomes({ tasks: [todo, reviewCard()], verdicts: { "T-2": reject }, config: CONFIG })), [
      "close_review",
    ]);
    assert.equal(
      outcomes({ tasks: [todo, reviewCard()], verdicts: { "T-2": reject }, config: CONFIG }).actions[0].reason,
      "rework_applied",
    );
  });

  it("closes the review card when the original was already done (crash recovery)", () => {
    const done = card({ status: "done" });
    const result = outcomes({ tasks: [done, reviewCard()], verdicts: { "T-2": approve }, config: CONFIG });
    assert.deepEqual(types(result), ["close_review"]);
    assert.equal(result.actions[0].reason, "already_approved");
  });

  it("does not close a review card whose round no longer matches", () => {
    const current = card({ delivery_round: 2 });
    const result = outcomes({ tasks: [current, reviewCard()], verdicts: { "T-2": approve }, config: CONFIG });
    assert.deepEqual(types(result), ["close_review"]);
    assert.equal(result.actions[0].reason, "round_mismatch");
    assert.equal(result.actions[0].round, 1, "the review card's own round");
  });

  it("cleans up around a canceled original without touching the original", () => {
    const canceled = card({ status: "canceled" });
    const result = outcomes({ tasks: [canceled, reviewCard({ status: "todo" })], verdicts: {}, config: CONFIG });
    assert.deepEqual(types(result), ["cancel_review"]);
    assert.equal(result.actions[0].reason, "original_canceled");
  });

  it("reopens a review card whose verdict cannot be read, within the bound", () => {
    for (const [verdicts, reason] of [
      [{}, "not_read"],
      [{ "T-2": { ok: false, reason: "no_verdict" } }, "no_verdict"],
    ]) {
      const result = outcomes({ tasks: [card(), reviewCard()], verdicts, config: CONFIG });
      assert.deepEqual(result.actions.map((action) => action.type), ["reopen_review"]);
      assert.equal(result.actions[0].retry, 1);
      assert.equal(result.actions[0].reason, reason);
      assert.equal(result.actions[0].reviewStatus, "in_review");
      assert.deepEqual(result.alerts.map((alert) => alert.type), ["verdict_unreadable"]);
    }
  });

  it("does not reopen a review whose original is already done", () => {
    const result = outcomes({
      tasks: [card({ status: "done" }), reviewCard()],
      verdicts: {},
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["verdict_unreadable"]);
  });

  it("stops reopening at the bound and leaves the card to a human", () => {
    const review = reviewCard({
      meta: { review_of: "T-1", flow: "B", review_round: 1, review_retry: "2" },
    });
    const result = outcomes({ tasks: [card(), review], verdicts: {}, config: CONFIG });
    assert.deepEqual(result.actions, []);
    assert.ok(result.alerts.some((alert) => alert.type === "review_retries_exhausted"));
  });

  it("finishes an interrupted reopen without touching a re-claimed card", () => {
    const interrupted = reviewCard({
      status: "in_progress",
      heartbeat_at: "2026-10-19T09:00:00.000Z",
      meta: {
        review_of: "T-1",
        flow: "B",
        review_round: 1,
        review_retry: "1",
        review_reopen_at: "2026-10-19T10:00:00.000Z",
      },
    });
    const result = outcomes({
      tasks: [card(), interrupted],
      verdicts: {},
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["reopen_review"]);
    assert.equal(result.actions[0].reviewStatus, "in_progress");
    assert.equal(result.actions[0].reason, "reopen_interrupted");

    const reclaimed = reviewCard({
      status: "in_progress",
      heartbeat_at: "2026-10-19T11:00:00.000Z",
      meta: {
        review_of: "T-1",
        flow: "B",
        review_round: 1,
        review_retry: "1",
        review_reopen_at: "2026-10-19T10:00:00.000Z",
      },
    });
    assert.deepEqual(
      outcomes({ tasks: [card(), reclaimed], verdicts: {}, config: CONFIG, now: NOW }).actions,
      [],
      "a fresh heartbeat means someone re-claimed it after the marker",
    );
  });

  it("says nothing while the reviewer has not delivered yet", () => {
    const pending = reviewCard({ status: "in_progress" });
    assert.deepEqual(outcomes({ tasks: [card(), pending], verdicts: {}, config: CONFIG }).alerts, []);
  });

  it("alerts on an original the snapshot does not contain", () => {
    const result = outcomes({ tasks: [reviewCard()], verdicts: { "T-2": approve }, config: CONFIG });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["original_unseen"]);
  });

  it("keeps original_unseen exact when the snapshot is complete", () => {
    const [alert] = outcomes({ tasks: [reviewCard()], verdicts: { "T-2": approve }, config: CONFIG }).alerts;
    assert.equal(alert.type, "original_unseen");
    assert.equal(alert.reason, undefined);
    assert.equal(alert.undecidable, undefined);
    assert.equal(alert.dedupKey, "original_unseen|T-2|T-1");
  });

  it("marks original_unseen undecidable on a truncated snapshot", () => {
    const [alert] = outcomes({
      tasks: [reviewCard()],
      verdicts: { "T-2": approve },
      config: CONFIG,
      boardTruncated: true,
    }).alerts;
    assert.equal(alert.type, "original_unseen");
    assert.equal(alert.reason, "board_truncated");
    assert.equal(alert.undecidable, true);
    assert.notEqual(alert.dedupKey, "original_unseen|T-2|T-1");
  });

  it("forwards boardTruncated into outcomes", () => {
    const tick = planWorkflowTick({
      tasks: [reviewCard()],
      config: CONFIG,
      boardTruncated: true,
    });
    const alert = tick.alerts.find((entry) => entry.type === "original_unseen");
    assert.equal(alert.reason, "board_truncated");
    assert.equal(alert.undecidable, true);
  });

  it("alerts on a conflicting verdict instead of acting on a done card", () => {
    const result = outcomes({ tasks: [card({ status: "done" }), reviewCard()], verdicts: { "T-2": reject }, config: CONFIG });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["verdict_conflict"]);
  });

  it("alerts on an original in a state the plan does not cover", () => {
    const blocked = card({ status: "blocked" });
    const result = outcomes({ tasks: [blocked, reviewCard()], verdicts: { "T-2": approve }, config: CONFIG });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["original_unexpected_status"]);
  });

  it("refuses a verdict report written by somebody other than the reviewer", () => {
    const result = planReviewOutcomes({
      tasks: [card(), reviewCard()],
      verdicts: {
        "T-2": {
          ok: true,
          verdict: "APPROVE",
          findings: "",
          report: { author: { id: "linus", display_name: "linus", kind: "agent" }, author_id: "linus" },
        },
      },
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["review_report_not_by_reviewer"]);
    assert.equal(result.alerts[0].expected, "jobs");
    assert.equal(result.alerts[0].author, "linus");
  });

  it("reports a review card that has produced no verdict for too long", () => {
    const stale = reviewCard({ status: "todo", status_changed_at: "2026-10-19T08:00:00.000Z" });
    const reported = planReviewOutcomes({ tasks: [card(), stale], verdicts: {}, config: CONFIG, now: NOW });
    assert.deepEqual(reported.alerts.map((alert) => alert.type), ["review_aging"]);
    assert.equal(reported.alerts[0].thresholdMs, 3_600_000);

    const fresh = reviewCard({ status: "todo", status_changed_at: "2026-10-19T09:30:00.000Z" });
    assert.deepEqual(planReviewOutcomes({ tasks: [card(), fresh], verdicts: {}, config: CONFIG, now: NOW }).alerts, []);

    // A configured threshold is honoured.
    assert.deepEqual(
      planReviewOutcomes({
        tasks: [card(), fresh],
        verdicts: {},
        config: { ...CONFIG, reviewAgingMs: 5 * 60_000 },
        now: NOW,
      }).alerts.map((alert) => alert.type),
      ["review_aging"],
    );
  });

  it("always closes the review card it dispatched", () => {
    const result = outcomes({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": approve },
      config: CONFIG,
    });
    assert.deepEqual(types(result), ["approve"]);
    assert.equal(result.actions[0].closeReview, true);
    assert.deepEqual(result.alerts.map((alert) => alert.type), []);

    const stale = outcomes({
      tasks: [card({ delivery_round: 2 }), reviewCard()],
      verdicts: {},
      config: CONFIG,
    });
    assert.deepEqual(types(stale), ["close_review"]);
    assert.equal(stale.actions[0].reason, "round_mismatch");
  });

  it("never touches a review card that is already terminal", () => {
    for (const status of ["done", "canceled"]) {
      const result = outcomes({
        tasks: [card(), reviewCard({ status })],
        verdicts: { "T-2": approve },
        config: CONFIG,
      });
      assert.deepEqual(result.actions, []);
      assert.deepEqual(result.alerts, []);
    }
  });

  it("records the loop's own acceptance marker as a constant the SLA pass shares", () => {
    assert.equal(LOOP_ACCEPTOR, "loop-review");
  });
});

// ---------------------------------------------------------------------------
// The whole pass
// ---------------------------------------------------------------------------

describe("planWorkflowTick", () => {
  it("runs outcomes before dispatch, so a card approved this tick is not re-dispatched", () => {
    const result = planWorkflowTick({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT } },
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(types(result), ["approve"]);
    assert.deepEqual(result.summary, {
      reconciled: 0,
      approved: 1,
      held: 0,
      rejected: 0,
      dispatched: 0,
      autoAccepted: 0,
      closed: 0,
      actions: 1,
      alerts: 0,
    });
  });

  it("includes reconcile notices and container changes", () => {
    const result = planWorkflowTick({
      tasks: [card({ status: "in_progress" })],
      reconcileActions: [
        { epic: "E-1", status: "todo", action: "start", reason: "child_in_progress", child: "T-1" },
        { epic: "E-2", status: "in_progress", action: "none", reason: "no_delivery_evidence" },
      ],
      config: { ...CONFIG, reviewer: null },
      now: NOW,
    });
    assert.deepEqual(result.changes, [{ epic: "E-1", action: "start", reason: "child_in_progress", child: "T-1" }]);
    assert.deepEqual(result.alerts.map((alert) => alert.reason ?? alert.type), ["no_delivery_evidence"]);
  });

  it("caps the total number of actions in one pass", () => {
    const tasks = Array.from({ length: 5 }, (_, index) =>
      card({ identifier: `T-${index + 1}`, status_changed_at: `2026-10-19T0${index}:00:00.000Z` }),
    );
    const result = planWorkflowTick({ tasks, config: { ...CONFIG, maxActions: 3 }, now: NOW });
    assert.equal(result.actions.length, 3);
    assert.equal(result.summary.dispatched, 3);
  });

  it("reports a combined outcome+dispatch overflow once", () => {
    const tasks = [
      card(),
      reviewCard(),
      card({ identifier: "T-3", status_changed_at: "2026-10-19T09:00:00.000Z" }),
      card({ identifier: "T-4", status_changed_at: "2026-10-19T10:00:00.000Z" }),
    ];
    const result = planWorkflowTick({
      tasks,
      verdicts: { "T-2": { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT } },
      config: { ...CONFIG, maxActions: 2 },
      now: NOW,
    });
    assert.equal(result.actions.length, 2);
    assert.deepEqual(result.actions.map((action) => action.type), ["approve", "create_review"]);
    assert.deepEqual(result.alerts.find((alert) => alert.type === "actions_capped"), {
      type: "actions_capped",
      cap: 2,
      dropped: 1,
      outcomes: 1,
      autoAccept: 0,
      dispatch: 2,
      dedupKey: "actions_capped|2",
    });
    assert.equal(result.alerts.some((alert) => alert.type === "dispatch_capped"), false);
    assert.equal(result.summary.actions, 2);
    assert.equal(result.summary.alerts, result.alerts.length);
  });

  it("keeps dispatch_capped as a separate finding when dispatch alone overflows", () => {
    const tasks = [
      card(),
      reviewCard(),
      card({ identifier: "T-3", status_changed_at: "2026-10-19T09:00:00.000Z" }),
      card({ identifier: "T-4", status_changed_at: "2026-10-19T10:00:00.000Z" }),
      card({ identifier: "T-5", status_changed_at: "2026-10-19T11:00:00.000Z" }),
    ];
    const result = planWorkflowTick({
      tasks,
      verdicts: { "T-2": { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT } },
      config: { ...CONFIG, maxActions: 2 },
      now: NOW,
    });
    assert.equal(result.actions.length, 2);
    assert.ok(result.alerts.some((alert) => alert.type === "dispatch_capped"));
    assert.ok(result.alerts.some((alert) => alert.type === "actions_capped"));
    assert.equal(result.summary.alerts, result.alerts.length);
  });

  it("never invents a review_cards_unclosable alert — the loop can always close", () => {
    const result = planWorkflowTick({
      tasks: [card(), reviewCard()],
      verdicts: {},
      config: CONFIG,
      now: NOW,
    });
    assert.equal(result.alerts.some((alert) => alert.type === "review_cards_unclosable"), false);
  });
});

describe("acceptance modes (the card decides who closes)", () => {
  const verdict = { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT };

  const plan = (fields = {}) =>
    planReviewOutcomes({
      tasks: [card({ parent_id: null, ...fields }), reviewCard()],
      verdicts: { "T-2": verdict },
      config: CONFIG,
      now: NOW,
    });

  it("reads the structural review marker before the meta fallback", () => {
    assert.equal(isReviewCard({ review_of_id: "id-T-1" }), true);
    assert.equal(isReviewCard({ review_of_id: "id-T-1", meta: {} }), true);
    assert.equal(reviewRoundOf({ review_round: 3, meta: { review_round: 9 } }), 3, "the column wins");
    assert.equal(reviewRoundOf({ review_round: null, meta: { review_round: 9 } }), 9, "meta is the fallback");
  });

  it("approves an agent original and closes the review card", () => {
    const result = plan({ acceptance_mode: "agent" });
    assert.deepEqual(types(result), ["approve"]);
    const action = result.actions[0];
    assert.equal(action.originalRef, "T-1");
    assert.equal(action.reviewRef, "T-2");
    assert.equal(action.round, 1);
    assert.equal(action.acceptedBy, LOOP_ACCEPTOR);
    assert.equal(action.closeReview, true);
    assert.equal(action.held, undefined, "a fresh card carries no acceptance marker");
  });

  it("recovers an agent acceptance already written to the original (held)", () => {
    const result = plan({
      acceptance_mode: "agent",
      meta: { accepted_by: LOOP_ACCEPTOR, accepted_round: "1" },
    });
    assert.deepEqual(types(result), ["approve"]);
    assert.equal(
      result.actions[0].held,
      true,
      "the marker is on the card: only land/move/close remain",
    );
  });

  it("does not treat another round's acceptance marker as held", () => {
    const result = plan({
      acceptance_mode: "agent",
      meta: { accepted_by: LOOP_ACCEPTOR, accepted_round: "0" },
    });
    assert.equal(result.actions[0].held, undefined);
  });

  it("records an APPROVE on a human original, closes the review card, and leaves the original", () => {
    const result = plan({ acceptance_mode: "human" });
    assert.deepEqual(types(result), ["record_verdict"]);
    const action = result.actions[0];
    assert.equal(action.originalRef, "T-1");
    assert.equal(action.reviewRef, "T-2");
    assert.equal(action.round, 1);
    assert.equal(action.reason, "verdict_recorded");
    assert.equal(action.closeReview, true);
    assert.equal(action.acceptedBy, undefined, "the loop does not accept a human card");
  });

  it("recovers a human verdict already recorded on the original (held)", () => {
    const result = planReviewOutcomes({
      tasks: [
        card({
          acceptance_mode: "human",
          meta: { review_verdict: "approve", review_verdict_round: "1" },
        }),
        reviewCard(),
      ],
      verdicts: { "T-2": verdict },
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(types(result), ["record_verdict"]);
    assert.equal(result.actions[0].held, true, "the writes are skipped and only the close runs");
  });

  it("rejects a human original onto the rework path", () => {
    const result = planReviewOutcomes({
      tasks: [card({ acceptance_mode: "human" }), reviewCard()],
      verdicts: {
        "T-2": {
          ok: true,
          verdict: "REJECT",
          findings: "1. still missing the e2e case",
          report: { author: REVIEWER_REPORT.author },
        },
      },
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(types(result), ["reject_task"]);
    assert.equal(result.actions[0].originalRef, "T-1");
  });

  it("records an ad-hoc review on an off original without moving it", () => {
    assert.deepEqual(types(plan({ acceptance_mode: "off" })), ["close_review"]);
  });
});

// ---------------------------------------------------------------------------
// Containers are reviewed too (round 2)
// ---------------------------------------------------------------------------

describe("epics are reviewed like any other card", () => {
  const verdict = { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT };
  const epicCard = (fields = {}) => card({ identifier: "E-1", kind: "epic", ...fields });
  /** A terminal child so the current-round rollup is faithful. */
  const doneChild = (epic) =>
    card({ identifier: "T-3", status: "done", parent_id: epic.id, acceptance_mode: "off" });
  const epicReview = () =>
    reviewCard({ meta: { review_of: "E-1", flow: "B", review_round: 1 } });
  const rollup = (child) => ({
    is_rollup: true,
    acceptance: [{ ref: child.identifier, status: "met", note: "done" }],
    evidence: [{ kind: "commit", sha: "abc1234" }],
  });

  it("dispatches an agent-mode epic exactly as a task", () => {
    const result = planReviewDispatch({ tasks: [epicCard({ acceptance_mode: "agent" })], config: CONFIG });
    assert.deepEqual(types(result), ["create_review"]);
    assert.equal(result.actions[0].originalRef, "E-1");
    const task = planReviewDispatch({ tasks: [card()], config: CONFIG });
    assert.equal(result.actions[0].reviewer, task.actions[0].reviewer);
  });

  it("dispatches a human-mode epic exactly as an agent-mode one", () => {
    const human = planReviewDispatch({ tasks: [epicCard({ acceptance_mode: "human" })], config: CONFIG });
    const agent = planReviewDispatch({ tasks: [epicCard({ acceptance_mode: "agent" })], config: CONFIG });
    assert.deepEqual(types(human), ["create_review"]);
    assert.deepEqual(human.actions, agent.actions);
  });

  it("still dispatches nothing for an explicit off epic", () => {
    const result = planReviewDispatch({ tasks: [epicCard({ acceptance_mode: "off" })], config: CONFIG });
    assert.deepEqual(result.actions, []);
  });

  it("approves an epic only on a faithful current-round rollup", () => {
    const epic = epicCard({ acceptance_mode: "agent" });
    const child = doneChild(epic);
    const plan = (reportsByRef) =>
      planReviewOutcomes({
        tasks: [epic, child, epicReview()],
        verdicts: { "T-2": verdict },
        reportsByRef,
        config: CONFIG,
        now: NOW,
      });

    const result = plan({ "E-1": rollup(child) });
    assert.deepEqual(types(result), ["approve"]);
    assert.equal(result.actions[0].originalRef, "E-1");
    assert.equal(result.actions[0].acceptedBy, LOOP_ACCEPTOR);

    const unverified = plan({});
    assert.equal(unverified.actions.some((action) => action.type === "approve"), false);
    assert.ok(unverified.alerts.some((alert) => alert.type === "verdict_incomplete"));
  });

  it("records a human epic's APPROVE and leaves the container open for the person", () => {
    const epic = epicCard({ acceptance_mode: "human" });
    const child = doneChild(epic);
    const result = planReviewOutcomes({
      tasks: [epic, child, epicReview()],
      verdicts: { "T-2": verdict },
      reportsByRef: { "E-1": rollup(child) },
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(types(result), ["record_verdict"]);
    assert.equal(result.actions[0].originalRef, "E-1");
    assert.equal(result.actions[0].acceptedBy, undefined);
  });

  it("rejects an epic onto the fix-child path", () => {
    const epic = epicCard({ acceptance_mode: "agent" });
    const child = doneChild(epic);
    const result = planReviewOutcomes({
      tasks: [epic, child, epicReview()],
      verdicts: {
        "T-2": { ok: true, verdict: "REJECT", findings: "1. a child is missing", report: { author: REVIEWER_REPORT.author } },
      },
      reportsByRef: { "E-1": rollup(child) },
      config: CONFIG,
      now: NOW,
    });
    assert.deepEqual(types(result), ["reject_epic"]);
    assert.equal(result.actions[0].originalRef, "E-1");
    assert.equal(result.actions[0].acceptanceMode, "off", "the fix child is never reviewed or handed to a person");
  });
});

// ---------------------------------------------------------------------------
// De-duplication keys
// ---------------------------------------------------------------------------

describe("workflow alert dedup keys", () => {
  const unreadable = (verdicts = {}) =>
    outcomes({
      tasks: [card(), reviewCard()],
      verdicts,
      config: CONFIG,
      now: NOW,
    }).alerts.find((alert) => alert.type === "verdict_unreadable");

  it("is stable for the same state", () => {
    assert.equal(unreadable().dedupKey, unreadable().dedupKey);
  });

  it("changes when the unreadable reason changes", () => {
    const missing = unreadable();
    const noVerdict = unreadable({ "T-2": { ok: false, reason: "no_verdict" } });
    assert.notEqual(missing.dedupKey, noVerdict.dedupKey);
  });

  it("changes when the review card's status or audited round changes", () => {
    const aging = (status, round) =>
      outcomes({
        tasks: [
          card({ delivery_round: round }),
          reviewCard({ status, meta: { review_of: "T-1", flow: "B", review_round: round } }),
        ],
        verdicts: {},
        config: CONFIG,
        now: "2026-10-23T10:00:00.000Z",
      }).alerts.find((alert) => alert.type === "review_aging");
    assert.ok(aging("todo", 1));
    assert.notEqual(aging("todo", 1).dedupKey, aging("blocked", 1).dedupKey);
    assert.notEqual(aging("todo", 1).dedupKey, aging("todo", 2).dedupKey);
  });

  it("keys a reconcile alert by its blocking set, order-insensitively", () => {
    const reconcile = (blocking) =>
      classifyReconcileActions([
        { epic: "E-1", reason: "no_delivery_evidence", action: "none", blocking },
      ]).alerts[0];
    const one = reconcile([{ identifier: "T-1" }]);
    const same = reconcile([{ identifier: "T-1" }]);
    const two = reconcile([{ identifier: "T-1" }, { identifier: "T-2" }]);
    const reversed = reconcile([{ identifier: "T-2" }, { identifier: "T-1" }]);
    assert.equal(one.dedupKey, same.dedupKey);
    assert.equal(two.dedupKey, reversed.dedupKey);
    assert.notEqual(one.dedupKey, two.dedupKey);
  });
});

// ---------------------------------------------------------------------------
// 0031 — review decision, per-project reviewer, auto-accept
// ---------------------------------------------------------------------------

describe("planReviewDispatch — acceptance mode and project reviewers", () => {
  it("skips a card that does not require review", () => {
    const result = planReviewDispatch({
      tasks: [card({ acceptance_mode: "off" })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, []);
  });

  it("dispatches a human card exactly as an agent card", () => {
    const human = planReviewDispatch({
      tasks: [card({ acceptance_mode: "human" })],
      config: CONFIG,
    });
    const agent = planReviewDispatch({
      tasks: [card({ acceptance_mode: "agent" })],
      config: CONFIG,
    });
    assert.deepEqual(types(human), ["create_review"]);
    assert.deepEqual(human.actions, agent.actions, "the mode selects the closer, not the review");
  });

  it("does not dispatch a human card whose current round already has a done review", () => {
    const result = planReviewDispatch({
      tasks: [card({ acceptance_mode: "human" }), reviewCard({ status: "done" })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, [], "no second review loop");
    assert.deepEqual(
      result.alerts.map((alert) => alert.type),
      ["review_awaiting_human_acceptance"],
      "a finished review waiting on a person is the designed state, not a finding",
    );
  });

  it("resolves project.reviewer ?? the deployment reviewer per card", () => {
    const result = planReviewDispatch({
      tasks: [
        card({ identifier: "T-1", project_id: "p1" }),
        card({ identifier: "T-2", project_id: "p2" }),
        card({ identifier: "T-3", project_id: "p3" }),
      ],
      config: {
        ...CONFIG,
        reviewer: "jobs",
        projectReviewers: { p1: "alice", p2: " " },
      },
    });
    const byRef = Object.fromEntries(result.actions.map((action) => [action.originalRef, action.reviewer]));
    assert.equal(byRef["T-1"], "alice", "the project override wins");
    assert.equal(byRef["T-2"], "jobs", "a blank override falls back to the deployment reviewer");
    assert.equal(byRef["T-3"], "jobs");
  });

  it("aggregates the unconfigured-reviewer alert by project", () => {
    const result = planReviewDispatch({
      tasks: [
        card({ identifier: "T-1", project_id: "p1" }),
        card({ identifier: "T-2", project_id: "p1" }),
        card({ identifier: "T-3", project_id: "p2" }),
      ],
      config: { ...CONFIG, reviewer: null, projectReviewers: { p2: "bob" } },
    });
    assert.deepEqual(result.alerts, [
      {
        type: "dispatch_skipped",
        reason: "reviewer_not_configured",
        waiting: 2,
        projects: [{ project: "p1", waiting: 2 }],
      },
    ]);
    assert.deepEqual(result.actions.map((action) => action.originalRef), ["T-3"]);
  });

  it("uses the effective reviewer for the self-review guard", () => {
    const result = planReviewDispatch({
      tasks: [card({ identifier: "T-1", project_id: "p1" })],
      config: { ...CONFIG, reviewer: "jobs", projectReviewers: { p1: "linus" } },
    });
    assert.deepEqual(result.actions, []);
    assert.equal(result.alerts[0].type, "self_review_not_independent");
    assert.equal(result.alerts[0].reviewer, "linus");
  });

});

describe("planAutoAccept — no review required", () => {
  const autoCard = (fields = {}) =>
    card({ acceptance_mode: "off", status: "in_review", ...fields });

  it("auto-accepts a delivered card that does not require review", () => {
    const result = planAutoAccept({ tasks: [autoCard()], config: { ...CONFIG } });
    assert.deepEqual(result.actions, [
      {
        type: "auto_accept",
        originalRef: "T-1",
        round: 1,
        acceptedBy: LOOP_AUTO_ACCEPTOR,
        held: false,
      },
    ]);
    assert.deepEqual(result.alerts, []);
  });

  it("never auto-accepts a card that requires review", () => {
    const result = planAutoAccept({
      tasks: [card({ acceptance_mode: "agent" })],
      config: { ...CONFIG },
    });
    assert.deepEqual(result.actions, []);
  });

  it("lets an active review block, and a canceled review release, the card", () => {
    const active = planAutoAccept({
      tasks: [autoCard(), reviewCard({ status: "in_review" })],
      config: { ...CONFIG },
    });
    assert.deepEqual(active.actions, []);

    const canceled = planAutoAccept({
      tasks: [autoCard(), reviewCard({ status: "canceled" })],
      config: { ...CONFIG },
    });
    assert.deepEqual(canceled.actions.map((action) => action.type), ["auto_accept"]);
  });

  it("auto-accepts only off cards, regardless of scope", () => {
    for (const mode of ["agent", "human"]) {
      const planned = planAutoAccept({
        tasks: [autoCard({ acceptance_mode: mode })],
        config: CONFIG,
      });
      assert.deepEqual(planned.actions, [], mode);
    }
    for (const parent_id of [null, "E-1"]) {
      const planned = planAutoAccept({
        tasks: [autoCard({ parent_id })],
        config: CONFIG,
      });
      assert.deepEqual(
        planned.actions.map((action) => action.type),
        ["auto_accept"],
        `parent=${parent_id}`,
      );
    }
  });

  it("marks a crash-recovery marker as held", () => {
    const result = planAutoAccept({
      tasks: [
        autoCard({
          meta: { accepted_by: LOOP_AUTO_ACCEPTOR, accepted_round: "1" },
        }),
      ],
      config: { ...CONFIG },
    });
    assert.equal(result.actions[0].held, true);
  });

  it("accepts nothing on a truncated board", () => {
    const result = planAutoAccept({
      tasks: [autoCard()],
      config: { ...CONFIG },
      boardTruncated: true,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, [{ type: "auto_accept_skipped", reason: "board_truncated" }]);
  });

  it("excludes review cards (the structural marker, not meta.flow)", () => {
    const result = planAutoAccept({
      tasks: [reviewCard({ status: "in_review", acceptance_mode: "off" })],
      config: { ...CONFIG },
    });
    assert.deepEqual(result.actions, []);
  });

  it("plans exactly the cards the write gate will accept", () => {
    // One rule, not a matrix: the planner releases an `off` card and the board
    // accepts it; agent/human cards are never released.
    for (const mode of ["off", "agent", "human"]) {
      const task = autoCard({ acceptance_mode: mode });
      const planned = planAutoAccept({ tasks: [task], config: CONFIG });
      assert.equal(
        planned.actions.length === 1,
        mode === "off",
        `mode=${mode}: plan and the gate must agree`,
      );
    }
  });

  it("requires a current-round report to cover a non-empty baseline", () => {
    const baseline = ["a", "b"];
    const noReport = planAutoAccept({
      tasks: [autoCard({ acceptance: baseline })],
      config: { ...CONFIG },
    });
    assert.deepEqual(noReport.actions, []);
    assert.equal(noReport.alerts[0].reason, "acceptance_unverified");

    const incomplete = planAutoAccept({
      tasks: [autoCard({ acceptance: baseline })],
      reportsByRef: { "T-1": { acceptance: [{ text: "a", status: "met" }] } },
      config: { ...CONFIG },
    });
    assert.deepEqual(incomplete.actions, []);
    assert.equal(incomplete.alerts[0].reason, "acceptance_incomplete");
    assert.deepEqual(incomplete.alerts[0].missing, ["b"]);

    const complete = planAutoAccept({
      tasks: [autoCard({ acceptance: baseline })],
      reportsByRef: {
        "T-1": {
          acceptance: [
            { text: "a", status: "met" },
            { text: "b", status: "met" },
          ],
        },
      },
      config: { ...CONFIG },
    });
    assert.deepEqual(complete.actions.map((action) => action.type), ["auto_accept"]);
  });

  it("requires a current-round rollup that names every child before accepting an epic", () => {
    const epic = autoCard({ identifier: "E-1", kind: "epic" });
    const children = [
      card({ identifier: "T-2", status: "done", parent_id: "id-E-1" }),
      card({ identifier: "T-3", status: "canceled", parent_id: "id-E-1" }),
    ];
    const tasks = [epic, ...children];
    const config = { ...CONFIG };

    const missing = planAutoAccept({ tasks, config });
    assert.deepEqual(missing.actions, []);
    assert.equal(missing.alerts[0].reason, "rollup_unverified");

    const unmarked = planAutoAccept({
      tasks,
      reportsByRef: { "E-1": { acceptance: [] } },
      config,
    });
    assert.equal(unmarked.alerts[0].reason, "rollup_unverified", "content without the marker is not a rollup");

    const stale = planAutoAccept({
      tasks,
      reportsByRef: {
        "E-1": { is_rollup: true, acceptance: [{ text: "done", status: "met", ref: "T-2" }] },
      },
      config,
    });
    assert.deepEqual(stale.actions, []);
    assert.equal(stale.alerts[0].reason, "rollup_stale");
    assert.deepEqual(stale.alerts[0].missingChildren, ["T-3"]);

    const complete = planAutoAccept({
      tasks,
      reportsByRef: {
        "E-1": {
          is_rollup: true,
          acceptance: [
            { text: "done", status: "met", ref: "T-2" },
            { text: "dropped", status: "not_applicable", note: "scope withdrawn", ref: "T-3" },
          ],
        },
      },
      config,
    });
    assert.deepEqual(complete.actions.map((action) => action.type), ["auto_accept"]);
  });
});

describe("planWorkflowTick — auto-accept ordering", () => {
  it("runs auto-accept after outcomes and before dispatch, and reports the count", () => {
    const result = planWorkflowTick({
      tasks: [card({ identifier: "T-1", acceptance_mode: "off" })],
      config: { ...CONFIG },
      now: NOW,
    });
    assert.deepEqual(types(result), ["auto_accept"]);
    assert.equal(result.summary.autoAccepted, 1);
    assert.equal(result.summary.dispatched, 0);
  });

  it("does not dispatch a card that auto-accept already handled", () => {
    const result = planWorkflowTick({
      tasks: [card({ identifier: "T-1", acceptance_mode: "off" })],
      config: { ...CONFIG },
      now: NOW,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["auto_accept"]);
  });
});
