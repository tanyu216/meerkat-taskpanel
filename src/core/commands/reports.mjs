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
import { assertWaiverRequest } from "../domain/delivery-gate.mjs";
import { STATUS } from "../domain/enums.mjs";
import { normalizeReportCreate } from "../domain/report.mjs";
import { assertTransition } from "../domain/status.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";
import { resolveActorId } from "./dictionary.mjs";
import { advanceContainerForChild } from "./rollup.mjs";

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
 * The report's author, resolved to an actor **id**.
 *
 * `task_reports.author_id` is a reference to `actors(id)` since 0020. A report may
 * name its own author (a historical, back-dated report), otherwise the writer is
 * the actor that ran the command — either way the value that arrives is a *name*,
 * and the column wants the id. The `kind` is carried through unchanged: it is a
 * label on the log row, and the actor's own kind lives on the actor row.
 *
 * @param {object} ctx
 * @param {{kind: string, id: string}} author
 * @param {string} now
 */
function resolveAuthor(ctx, author, now) {
  const id = resolveActorId({ repos: ctx.repos, now }, { name: author.id, actorKind: author.kind });
  return { kind: author.kind, id };
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
      const prepared = normalizeReportCreate(
        { ...input.report, author: resolveAuthor(ctx, input.report?.author ?? actor, now) },
        {
          taskRound: task.deliveryRound,
          now,
        },
      );

      const report = ctx.repos.reports.insert({
        ...prepared,
        taskId: task.id,
        // An explicit origin: this is the delivery writer, and the gate must
        // never have to guess that (0008).
        origin: "delivery",
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
 * With `noReport: true` this is the *waived* delivery (F-B1): no report row is
 * written, the task carries the waiver and the audit says `report_waived`. The
 * two forms are mutually exclusive — sending both is a usage error, not a
 * silently picked winner.
 *
 * @param {object} ctx
 * @param {{taskId: string, report?: object|null, actor: object, ifVersion?: number, to?: string, noReport?: boolean, reason?: string, seg?: string, sessionId?: string}} input
 * @returns {{task: object, report: object|null, waived: boolean}}
 */
export function deliver(ctx, input) {
  const actor = actorOf(input.actor);
  const to = input.to ?? "in_review";
  const now = ctx.now();
  const waived = input.noReport === true;

  const waiverReason = waived
    ? assertWaiverRequest({ noReport: true, reason: input.reason, to, hasReport: input.report != null })
    : null;
  if (!waived && input.report == null) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "deliver needs a report, or --no-report with a reason",
      details: { fields: ["report", "noReport"] },
      hint: { fix: "taskctl issue deliver <id> --report-file -" },
    });
  }

  return transaction(
    ctx.db,
    () => {
      const task = loadTask(ctx, input.taskId);

      // The move must be legal at all. The *gate* is deliberately not consulted
      // here: this transaction is what satisfies it, by inserting the report
      // (or stamping the waiver) below. The database trigger still checks that
      // it really happened — if the ordering here were wrong, the status update
      // would be refused.
      assertTransition(task.status, to, task.kind);

      if (waived) {
        const waiver = { round: task.deliveryRound, reason: waiverReason, at: now };
        const moved = ctx.repos.tasks.moveCas({ id: task.id, ifVersion: input.ifVersion, to, now, waiver });
        ctx.repos.activities.append({
          taskId: task.id,
          actorKind: actor.kind,
          actorId: actor.id,
          event: "report_waived",
          changes: {
            from: task.status,
            to: moved.status,
            round: waiver.round,
            reason: waiver.reason,
            deliveryRound: moved.deliveryRound,
          },
          createdAt: now,
        });
        // A waived delivery can still finish a child — the container rolls up
        // on `done`, however the child got there (commands/rollup.mjs).
        if (moved.status === STATUS.DONE) advanceContainerForChild(ctx, task.id, now);
        return { task: moved, report: null, waived: true };
      }

      const prepared = normalizeReportCreate(
        { ...input.report, author: resolveAuthor(ctx, input.report?.author ?? actor, now) },
        {
          taskRound: task.deliveryRound,
          now,
        },
      );
      const report = ctx.repos.reports.insert({
        ...prepared,
        taskId: task.id,
        // The delivery writer: this row is what the gate will accept (0008).
        origin: "delivery",
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
      // Same hook as the waived branch: `deliver` may land a card on `done`
      // (a rework accepted straight through), and that can finish a container.
      if (moved.status === STATUS.DONE) advanceContainerForChild(ctx, task.id, now);
      return { task: moved, report, waived: false };
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
