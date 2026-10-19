/**
 * The workflow sub-pass (`src/shared/workflow.mjs`) — the loop's orchestration
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
  classifyReconcileActions,
  flowOf,
  isReviewCard,
  isSelfReview,
  parseReviewVerdict,
  planReviewDispatch,
  planReviewOutcomes,
  planReviewOutcomes as outcomes,
  planWorkflowTick,
  reviewIdemKey,
  reviewOf,
  reviewRoundOf,
  reworkIdemKey,
  roundOf,
} from "../../src/shared/workflow.mjs";
import { resolveWorkflowConfig } from "../../src/shared/scheduling.mjs";

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
    assert.equal(action.acceptance.length, 3);
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
    assert.deepEqual(result.alerts, [{ type: "dispatch_skipped", reason: "reviewer_not_configured", waiting: 1 }]);
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
      { type: "approve", reviewRef: "T-2", originalRef: "T-1", round: 1, closeReview: true },
    ]);
    assert.deepEqual(result.alerts, []);
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
      rejected: 0,
      dispatched: 0,
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
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("resolveWorkflowConfig", () => {
  it("defaults to on, no reviewer, auto-accept, 20 writes", () => {
    assert.deepEqual(resolveWorkflowConfig(), {
      workflow: true,
      reviewer: null,
      autoAcceptReviews: true,
      maxActions: 20,
      reviewAgingMs: 3_600_000,
    });
  });

  it("prefers flag > env > file > default", () => {
    const file = {
      MEERKAT_TASKPANEL_WORKFLOW: "no",
      MEERKAT_TASKPANEL_REVIEWER: "file-reviewer",
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "no",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "7",
    };
    const env = {
      MEERKAT_TASKPANEL_WORKFLOW: "yes",
      MEERKAT_TASKPANEL_REVIEWER: "env-reviewer",
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "yes",
      MEERKAT_TASKPANEL_WORKFLOW_MAX_ACTIONS: "9",
    };
    assert.deepEqual(resolveWorkflowConfig({ env, file }), {
      workflow: true,
      reviewer: "env-reviewer",
      autoAcceptReviews: true,
      maxActions: 9,
      reviewAgingMs: 3_600_000,
    });
    assert.deepEqual(
      resolveWorkflowConfig({
        flags: {
          workflow: "no",
          reviewer: "flag-reviewer",
          autoAcceptReviews: "no",
          workflowMaxActions: "3",
          reviewAgingMinutes: "30",
        },
        env,
        file,
      }),
      { workflow: false, reviewer: "flag-reviewer", autoAcceptReviews: false, maxActions: 3, reviewAgingMs: 1_800_000 },
    );
    assert.deepEqual(resolveWorkflowConfig({ file }), {
      workflow: false,
      reviewer: "file-reviewer",
      autoAcceptReviews: false,
      maxActions: 7,
      reviewAgingMs: 3_600_000,
    });
  });

  it("ignores an unreadable value and falls through", () => {
    const resolved = resolveWorkflowConfig({
      flags: { workflow: "maybe", reviewer: "   ", workflowMaxActions: "0" },
      env: { MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "perhaps" },
      file: { MEERKAT_TASKPANEL_WORKFLOW: "no" },
    });
    assert.equal(resolved.workflow, false, "the file's value is the next readable one");
    assert.equal(resolved.reviewer, null, "whitespace is not a name");
    assert.equal(resolved.autoAcceptReviews, true);
    assert.equal(resolved.maxActions, 20, "a non-positive cap is not a cap");
  });
});
