/**
 * The board's workflow tick — the snapshot assembly around the pure decisions in
 * `domain/workflow.mjs`.
 *
 * The board owns the *decisions* (reconcile notices, review outcomes, review
 * dispatch); the loop owns their *execution*: it creates the review card, moves
 * the original, comments, writes the markers and closes the review card last.
 * This use-case is the seam between the two: it performs the board's own
 * container reconcile, reads the bounded board snapshot, and returns the plan
 * the loop applies. It deliberately performs **no review writes** — an action in
 * the plan is a decision, not an effect.
 */

import { DEFAULT_BOARD_LIMIT } from "../../foundation/constants.mjs";
import { reportToWire, taskToWire } from "../../foundation/wire.mjs";
import {
  isReviewCard,
  parseReviewVerdict,
  planWorkflowTick,
  roundOf,
} from "../domain/workflow.mjs";
import { reconcileContainers } from "./rollup.mjs";

/**
 * One board-side workflow tick.
 *
 * @param {object} ctx
 * @param {{
 *   reviewer?: string|null,
 *   reviewAgingMs?: number,
 *   maxActions?: number,
 *   boardLimit?: number,
 *   dryRun?: boolean,
 * }} [input]
 * @returns {{
 *   dryRun: boolean,
 *   scanned: number,
 *   actions: object[],
 *   workflow: {alerts: object[], actions: object[], changes: object[], summary: object},
 * }}
 */
export function workflowTick(ctx, input = {}) {
  const dryRun = input.dryRun === true;
  const reconcile = reconcileContainers(ctx, { dryRun });

  // The loop's read is bounded (`--board-limit`); the board's is too, so a
  // large board keeps the same fail-safe: a truncated snapshot still applies
  // review outcomes, but it dispatches nothing.
  const limit =
    Number.isFinite(input.boardLimit) && input.boardLimit > 0
      ? Math.trunc(input.boardLimit)
      : DEFAULT_BOARD_LIMIT;
  const rows = ctx.repos.tasks.list({ limit: limit + 1 });
  const boardTruncated = rows.length > limit;
  const snapshot = boardTruncated ? rows.slice(0, limit) : rows;

  const lookup = (kind, id) => ctx.repos.dictionary.getById(kind, id);
  const parents = new Map(
    ctx.repos.relations.listParentEdges().map((edge) => [edge.target, edge.source]),
  );
  const tasks = snapshot.map((task) =>
    taskToWire(task, { lookup, parentId: parents.get(task.id) ?? null }),
  );

  // 0032 — the current-round delivery report for every in_review non-review
  // card. The planner needs its `acceptance` list to decide whether an
  // auto-accept or an APPROVE is safe *before* the write gate refuses it.
  const reportsByRef = {};
  for (let i = 0; i < snapshot.length; i += 1) {
    const card = tasks[i];
    if (isReviewCard(card) || card.status !== "in_review") continue;
    const ref = String(card.identifier ?? "");
    if (ref === "") continue;
    const report = ctx.repos.reports.latestForRound(snapshot[i].id, snapshot[i].deliveryRound);
    if (report === null || report === undefined) continue;
    reportsByRef[ref] = reportToWire(report, { lookup });
  }

  // A verdict is the review card's report for its OWN current delivery round
  // (`delivery_round`), not the round it audits (`review_round`): every report
  // is stamped with the card's own round, and a fresh review card's own round
  // is 1 even when it audits the original's round 2+. Only in_review review
  // cards can carry one that matters; terminal cards are skipped by the planner.
  const verdicts = {};
  for (let i = 0; i < snapshot.length; i += 1) {
    const card = tasks[i];
    if (!isReviewCard(card) || card.status !== "in_review") continue;
    const ref = String(card.identifier ?? "");
    if (ref === "") continue;
    const reports = ctx.repos.reports
      .listByTask(snapshot[i].id)
      .map((report) => reportToWire(report, { lookup }));
    verdicts[ref] = parseReviewVerdict(reports, roundOf(card));
  }

  const reviewer =
    typeof input.reviewer === "string" && input.reviewer.trim() !== ""
      ? input.reviewer.trim()
      : null;

  // 0031 — a project may override the deployment-level reviewer. Read every
  // project (archived included: it can still own in-flight cards) so dispatch
  // can resolve `project.reviewer ?? global` from the snapshot alone.
  const projectReviewers = Object.fromEntries(
    ctx.repos.projects
      .list({ includeArchived: true })
      .map((project) => [project.id, project.reviewer ?? null]),
  );

  const workflow = planWorkflowTick({
    tasks,
    verdicts,
    reportsByRef,
    reconcileActions: reconcile.actions,
    config: {
      reviewer,
      projectReviewers,
      reviewAgingMs: input.reviewAgingMs,
      maxActions: input.maxActions,
      // 0038 — the card's own `acceptance_mode` is the whole decision; there is
      // no board-level policy and no loop-side advisory copy to merge.
    },
    boardTruncated,
    now: ctx.now(),
  });

  return {
    dryRun: reconcile.dryRun,
    scanned: reconcile.scanned,
    actions: reconcile.actions,
    workflow,
  };
}
