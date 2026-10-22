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
  parseReviewVerdict,
  planAutoAccept,
  planReviewDispatch,
  planReviewOutcomes,
  planReviewOutcomes as outcomes,
  planWorkflowTick,
  reviewIdemKey,
  reviewOf,
  reviewRequired,
  reviewRoundOf,
  reworkIdemKey,
  roundOf,
} from "../../../src/core/domain/workflow.mjs";
import { acceptanceAllows, acceptanceScopeOf } from "../../../src/core/domain/status.mjs";
import { TASKD_KIND } from "../../../src/foundation/constants.mjs";

const NOW = "2026-10-19T10:00:00.000Z";

function card(fields = {}) {
  const identifier = fields.identifier ?? "T-1";
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
    // Most fixtures describe a card that is dispatched for review. A test for
    // the no-review path sets `review_required: false` explicitly.
    review_required: true,
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
    review_required: false,
    meta: { review_of: "T-1", flow: "B", review_round: 1 },
    ...fields,
  });
}

/** The author a verdict report must carry to be the configured reviewer's. */
const REVIEWER_REPORT = {
  author: { id: "agent-jobs", display_name: "jobs", kind: "agent" },
  author_id: "agent-jobs",
};

const CONFIG = { reviewer: "jobs", maxActions: 20, autoAcceptReviews: true };

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
    ]);
  });

  it("uses the three-item checklist on an epic, where the children stand in for the list", () => {
    const result = planReviewDispatch({
      tasks: [card({ kind: "epic", acceptance: ["container goal"] })],
      config: CONFIG,
    });
    const action = result.actions[0];
    assert.equal(action.acceptance[0], "container goal");
    assert.match(action.acceptance[1], /Every child of T-1/);
    assert.equal(action.acceptance.length, 4);
  });

  it("tells the reviewer when the original's acceptance list was worker-derived", () => {
    const action = planReviewDispatch({ tasks: [card()], config: CONFIG }).actions[0];
    assert.match(action.description, /acceptance_derived/);
    assert.match(action.description, /narrowed/);
    assert.match(action.description, /REJECT/);
    assert.equal(action.acceptance.length, 2, "the generic review checklist is unchanged");
  });

  it("never reviews a review card, a flow-B card, or a card not in review", () => {
    const result = planReviewDispatch({
      tasks: [
        reviewCard(),
        card({ identifier: "T-3", meta: { flow: "B" } }),
        card({ identifier: "T-4", status: "in_progress" }),
      ],
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
    assert.deepEqual(result.actions, []);
    assert.equal(result.alerts[0].type, "verdict_incomplete");
    assert.deepEqual(result.alerts[0].missing, ["b"]);
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
    assert.deepEqual(missing.actions, []);
    assert.equal(missing.alerts[0].type, "verdict_incomplete");
    assert.equal(missing.alerts[0].reason, "rollup_unverified");

    const stale = planReviewOutcomes({
      tasks: [epic, child, review],
      verdicts: { "T-2": approve },
      reportsByRef: { "E-1": { is_rollup: true, acceptance: [] } },
      config: CONFIG,
    });
    assert.deepEqual(stale.actions, []);
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

  it("alerts and moves nothing when the verdict cannot be read", () => {
    for (const verdicts of [{}, { "T-2": { ok: false, reason: "no_verdict" } }]) {
      const result = outcomes({ tasks: [card(), reviewCard()], verdicts, config: CONFIG });
      assert.deepEqual(result.actions, []);
      assert.deepEqual(result.alerts.map((alert) => alert.type), ["verdict_unreadable"]);
    }
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

  it("still applies the verdict with auto-accept off, but leaves the review card to a human", () => {
    const result = outcomes({
      tasks: [card(), reviewCard()],
      verdicts: { "T-2": approve },
      config: { ...CONFIG, autoAcceptReviews: false },
    });
    assert.deepEqual(types(result), ["approve"]);
    assert.equal(result.actions[0].closeReview, false);
    assert.deepEqual(result.alerts.map((alert) => alert.type), ["review_awaiting_human_acceptance"]);

    const stale = outcomes({
      tasks: [card({ delivery_round: 2 }), reviewCard()],
      verdicts: {},
      config: { ...CONFIG, autoAcceptReviews: false },
    });
    assert.deepEqual(stale.actions, []);
    assert.deepEqual(stale.alerts.map((alert) => alert.type), ["review_stale_round"]);
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

  it("warns when agent-only cannot close review cards", () => {
    const result = planWorkflowTick({
      tasks: [card(), reviewCard()],
      verdicts: {},
      config: { ...CONFIG, acceptancePolicy: "agent-only", autoAcceptReviews: false },
      now: NOW,
    });
    assert.deepEqual(result.alerts.find((alert) => alert.type === "review_cards_unclosable"), {
      type: "review_cards_unclosable",
      reason: "agent_only_without_auto_accept",
      policy: "agent-only",
      autoAcceptReviews: false,
      reviews: 1,
      dedupKey: "review_cards_unclosable|agent-only|auto_accept_off",
    });
  });

  it("does not warn for other policies, auto-accept on, or no open review", () => {
    for (const config of [
      { ...CONFIG, acceptancePolicy: "both", autoAcceptReviews: false },
      { ...CONFIG, acceptancePolicy: "human-only", autoAcceptReviews: false },
      { ...CONFIG, acceptancePolicy: "agent-only", autoAcceptReviews: true },
    ]) {
      const result = planWorkflowTick({ tasks: [card(), reviewCard()], verdicts: {}, config, now: NOW });
      assert.equal(
        result.alerts.some((alert) => alert.type === "review_cards_unclosable"),
        false,
        JSON.stringify(config),
      );
    }

    const closed = planWorkflowTick({
      tasks: [card(), reviewCard({ status: "done" })],
      verdicts: {},
      config: { ...CONFIG, acceptancePolicy: "agent-only", autoAcceptReviews: false },
      now: NOW,
    });
    assert.equal(closed.alerts.some((alert) => alert.type === "review_cards_unclosable"), false);
  });
});

describe("acceptance policy (human-only holds a top-level approval)", () => {
  const verdict = { ok: true, verdict: "APPROVE", findings: "", report: REVIEWER_REPORT };

  const plan = (config, fields = {}) =>
    planReviewOutcomes({
      tasks: [card({ parent_id: null, ...fields }), reviewCard()],
      verdicts: { "T-2": verdict },
      config: { ...CONFIG, ...config },
      now: NOW,
    });

  it("reads the structural review marker before the meta fallback", () => {
    assert.equal(isReviewCard({ review_of_id: "id-T-1" }), true);
    assert.equal(isReviewCard({ review_of_id: "id-T-1", meta: {} }), true);
    assert.equal(reviewRoundOf({ review_round: 3, meta: { review_round: 9 } }), 3, "the column wins");
    assert.equal(reviewRoundOf({ review_round: null, meta: { review_round: 9 } }), 9, "meta is the fallback");
  });

  it("both (the default) approves the original itself", () => {
    assert.deepEqual(types(plan({})), ["approve"]);
    assert.deepEqual(types(plan({ acceptancePolicy: "both" })), ["approve"]);
    assert.deepEqual(types(plan({ acceptancePolicy: "agent-only" })), ["approve"]);
  });

  it("human-only holds a top-level original, and closes only the review card", () => {
    const result = plan({ acceptancePolicy: "human-only" });
    assert.deepEqual(types(result), ["approve_hold"]);
    const action = result.actions[0];
    assert.equal(action.originalRef, "T-1");
    assert.equal(action.reviewRef, "T-2");
    assert.equal(action.round, 1);
    assert.equal(action.acceptedBy, LOOP_ACCEPTOR);
    assert.equal(action.held, false);
    const tick = planWorkflowTick({
      tasks: [card({ parent_id: null }), reviewCard()],
      verdicts: { "T-2": verdict },
      config: { ...CONFIG, acceptancePolicy: "human-only" },
      now: NOW,
    });
    assert.equal(tick.summary.held, 1);
    assert.equal(tick.summary.approved, 1, "a held approval still counts as an approval");
  });

  it("reports a held approval that is already on the card", () => {
    const result = plan({ acceptancePolicy: "human-only" }, {
      meta: { review_verdict: "approve", review_verdict_round: "1" },
    });
    assert.equal(result.actions[0].held, true, "the executor must not rewrite the marker");
  });

  it("human-only still closes a child original automatically", () => {
    assert.deepEqual(types(plan({ acceptancePolicy: "human-only" }, { parent_id: "id-epic" })), ["approve"]);
  });

  it("human-only obeys autoAcceptReviews for the review card only", () => {
    const result = plan({ acceptancePolicy: "human-only", autoAcceptReviews: false });
    assert.deepEqual(types(result), ["approve_hold"]);
    assert.equal(result.actions[0].closeReview, false);
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

describe("planReviewDispatch — review_required and project reviewers", () => {
  it("skips a card that does not require review", () => {
    const result = planReviewDispatch({
      tasks: [card({ review_required: false })],
      config: CONFIG,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, []);
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

  it("reads the decision from the integer column too", () => {
    assert.equal(reviewRequired({ review_required: true }), true);
    assert.equal(reviewRequired({ review_required: 1 }), true);
    assert.equal(reviewRequired({ review_required: 0 }), false);
    assert.equal(reviewRequired({}), false);
  });
});

describe("planAutoAccept — no review required", () => {
  const autoCard = (fields = {}) =>
    card({ review_required: false, status: "in_review", ...fields });

  it("auto-accepts a delivered card that does not require review", () => {
    const result = planAutoAccept({ tasks: [autoCard()], config: { ...CONFIG, acceptancePolicy: "both" } });
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
      tasks: [card({ review_required: true })],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.deepEqual(result.actions, []);
  });

  it("lets an active review block, and a canceled review release, the card", () => {
    const active = planAutoAccept({
      tasks: [autoCard(), reviewCard({ status: "in_review" })],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.deepEqual(active.actions, []);

    const canceled = planAutoAccept({
      tasks: [autoCard(), reviewCard({ status: "canceled" })],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.deepEqual(canceled.actions.map((action) => action.type), ["auto_accept"]);
  });

  it("skips a human-only top-level card, but still accepts a child", () => {
    const top = planAutoAccept({
      tasks: [autoCard()],
      config: { ...CONFIG, acceptancePolicy: "human-only" },
    });
    assert.deepEqual(top.actions, []);
    assert.equal(top.alerts[0].type, "auto_accept_skipped");
    assert.equal(top.alerts[0].reason, "human_only");

    const child = planAutoAccept({
      tasks: [autoCard({ parent_id: "E-1" })],
      config: { ...CONFIG, acceptancePolicy: "human-only" },
    });
    assert.deepEqual(child.actions.map((action) => action.type), ["auto_accept"]);
  });

  it("is not gated by autoAcceptReviews (that flag closes review cards)", () => {
    const result = planAutoAccept({
      tasks: [autoCard()],
      config: { ...CONFIG, acceptancePolicy: "both", autoAcceptReviews: false },
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["auto_accept"]);
  });

  it("marks a crash-recovery marker as held", () => {
    const result = planAutoAccept({
      tasks: [
        autoCard({
          meta: { accepted_by: LOOP_AUTO_ACCEPTOR, accepted_round: "1" },
        }),
      ],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.equal(result.actions[0].held, true);
  });

  it("accepts nothing on a truncated board", () => {
    const result = planAutoAccept({
      tasks: [autoCard()],
      config: { ...CONFIG, acceptancePolicy: "both" },
      boardTruncated: true,
    });
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.alerts, [{ type: "auto_accept_skipped", reason: "board_truncated" }]);
  });

  it("excludes review cards and flow-B cards", () => {
    const result = planAutoAccept({
      tasks: [reviewCard({ status: "in_review", review_required: false })],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.deepEqual(result.actions, []);
  });

  it("lets exactly the scopes acceptanceAllows names for taskd — one matrix, not two", () => {
    // The auto-accept gate and the board's own `assertAcceptance` must agree on
    // who may accept. If one grows a special case the other lacks, a card the
    // planner releases is refused at the write, or one it holds is writable.
    for (const policy of ["human-only", "both", "agent-only"]) {
      for (const parent_id of [null, "E-1"]) {
        const task = autoCard({ parent_id });
        const scope = acceptanceScopeOf({ hasParent: parent_id !== null, reviewCard: false });
        const planned = planAutoAccept({
          tasks: [task],
          config: { ...CONFIG, acceptancePolicy: policy },
        });
        assert.equal(
          planned.actions.length === 1,
          acceptanceAllows(TASKD_KIND, policy, scope),
          `policy=${policy} parent=${parent_id}: plan and assertAcceptance disagree`,
        );
      }
    }
  });

  it("requires a current-round report to cover a non-empty baseline", () => {
    const baseline = ["a", "b"];
    const noReport = planAutoAccept({
      tasks: [autoCard({ acceptance: baseline })],
      config: { ...CONFIG, acceptancePolicy: "both" },
    });
    assert.deepEqual(noReport.actions, []);
    assert.equal(noReport.alerts[0].reason, "acceptance_unverified");

    const incomplete = planAutoAccept({
      tasks: [autoCard({ acceptance: baseline })],
      reportsByRef: { "T-1": { acceptance: [{ text: "a", status: "met" }] } },
      config: { ...CONFIG, acceptancePolicy: "both" },
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
      config: { ...CONFIG, acceptancePolicy: "both" },
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
    const config = { ...CONFIG, acceptancePolicy: "both" };

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
      tasks: [card({ identifier: "T-1", review_required: false })],
      config: { ...CONFIG, acceptancePolicy: "both" },
      now: NOW,
    });
    assert.deepEqual(types(result), ["auto_accept"]);
    assert.equal(result.summary.autoAccepted, 1);
    assert.equal(result.summary.dispatched, 0);
  });

  it("does not dispatch a card that auto-accept already handled", () => {
    const result = planWorkflowTick({
      tasks: [card({ identifier: "T-1", review_required: false })],
      config: { ...CONFIG, acceptancePolicy: "both" },
      now: NOW,
    });
    assert.deepEqual(result.actions.map((action) => action.type), ["auto_accept"]);
  });
});
