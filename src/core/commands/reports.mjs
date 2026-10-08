/**
 * Report use-cases — and `deliver`, the atomic "write the report and hand the
 * card over" primitive (§4.5 ②).
 *
 * `writeReport` adds a report without moving the task (back-filling history, or
 * preparing a delivery). `deliver` is what an agent should call: one
 * transaction that validates the report, stores it, points the task at it and
 * moves the task to `in_review`. If anything fails, nothing happened — not even
 * a revision bump.
 */

import { DomainError } from "../../shared/errors.mjs";
import { normalizeReportCreate } from "../domain/report.mjs";
import { assertTransition } from "../domain/status.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/** The task must exist, and its delivery round is what the report is judged against. */
function loadTask(ctx, taskRef) {
  const task =
    ctx.repos.tasks.get(taskRef) ?? ctx.repos.tasks.findByIdentifierAnyProject(taskRef);
  if (task === null) {
    throw new DomainError("NOT_FOUND", { message: `no task ${taskRef}`, details: { taskId: taskRef } });
  }
  return task;
}

/**
 * Append a report for the task's current delivery round.
 *
 * @param {object} ctx
 * @param {{taskId: string, report: object, actor: object}} input
 */
export function writeReport(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const task = loadTask(ctx, input.taskId);
      const prepared = normalizeReportCreate({ ...input.report, author: input.report?.author ?? actor }, {
        taskRound: task.deliveryRound,
        now,
      });

      const report = ctx.repos.reports.insert({
        ...prepared,
        taskId: task.id,
        seg: prepared.seg ?? input.seg ?? null,
        sessionId: prepared.sessionId ?? input.sessionId ?? null,
      });
      const updated = ctx.repos.tasks.setReportLatest({ id: task.id, reportId: report.id, now });

      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "report_written",
        changes: { round: report.round, reportId: report.id, deliveryRound: updated.deliveryRound },
        createdAt: now,
      });
      return { task: updated, report };
    },
    { op: "reports.write" },
  );
}

/**
 * Deliver: report + `→ in_review`, atomically.
 *
 * @param {object} ctx
 * @param {{taskId: string, report: object, actor: object, ifVersion?: number, to?: string}} input
 */
export function deliver(ctx, input) {
  const actor = actorOf(input.actor);
  const to = input.to ?? "in_review";
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const task = loadTask(ctx, input.taskId);

      // The move must be legal at all. The *gate* is deliberately not consulted
      // here: this transaction is what satisfies it, by inserting the report
      // below. The database trigger still checks that the insert really happened
      // — if the ordering here were wrong, the status update would be refused.
      assertTransition(task.status, to);

      const prepared = normalizeReportCreate({ ...input.report, author: input.report?.author ?? actor }, {
        taskRound: task.deliveryRound,
        now,
      });
      const report = ctx.repos.reports.insert({
        ...prepared,
        taskId: task.id,
        seg: prepared.seg ?? input.seg ?? null,
        sessionId: prepared.sessionId ?? input.sessionId ?? null,
      });

      const moved = ctx.repos.tasks.moveCas({
        id: task.id,
        ifVersion: input.ifVersion,
        to,
        now,
        reportLatestId: report.id,
      });

      ctx.repos.activities.append({
        taskId: task.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "task_delivered",
        changes: {
          from: task.status,
          to: moved.status,
          round: report.round,
          reportId: report.id,
          deliveryRound: moved.deliveryRound,
        },
        createdAt: now,
      });
      return { task: moved, report };
    },
    { op: "reports.deliver" },
  );
}

/** @param {object} ctx @param {{taskId: string}} input */
export function listReports(ctx, input) {
  return ctx.repos.reports.listByTask(input.taskId);
}

/** @param {object} ctx @param {{taskId: string, round?: number}} input */
export function getReport(ctx, input) {
  const task = loadTask(ctx, input.taskId);
  const round = input.round ?? task.deliveryRound;
  return ctx.repos.reports.latestForRound(task.id, round);
}
