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

import { DomainError } from "../../foundation/errors.mjs";
import { assertWaiverRequest } from "../domain/delivery-gate.mjs";
import { STATUS, TASK_KIND } from "../domain/enums.mjs";
import { normalizeReportCreate } from "../domain/report.mjs";
import { isTerminalStatus, transitionPolicyFor } from "../domain/status.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import {
  assertAcceptance,
  assertAcceptanceCoverage,
  assertChildrenTerminal,
  assertDeliveryCommitAnchor,
  assertDeliveryEvidenceAnchors,
  assertReviewReady,
} from "./acceptance.mjs";
import { actorOf } from "./context.mjs";
import { insertDeliveryReport } from "./delivery-report.mjs";
import { resolveActorId } from "./dictionary.mjs";
import {
  advanceContainerForChild,
  assertRollupCoverage,
  hasChildStarted,
  startContainerForChild,
} from "./rollup.mjs";

/** The task must exist, and its delivery round is what the report is judged against. */
function loadTask(ctx, taskRef) {
  return ctx.repos.tasks.requireAnyRef(taskRef);
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

  let identifier = null;
  const result = transaction(
    ctx.db,
    () => {
      const task = loadTask(ctx, input.taskId);
      identifier = task.identifier;
      const prepared = normalizeReportCreate(
        { ...input.report, author: resolveAuthor(ctx, input.report?.author ?? actor, now) },
        {
          taskRound: task.deliveryRound,
          now,
        },
      );

      // 0033 — a report on an epic *is* its rollup: it must describe every live
      // child, and it is marked as such. A plain `task` report is never a rollup.
      const isRollup = task.kind === TASK_KIND.EPIC;
      if (isRollup) assertRollupCoverage(ctx, task, prepared.acceptance);
      const report = insertDeliveryReport(ctx, {
        taskId: task.id,
        prepared,
        seg: prepared.seg ?? input.seg ?? null,
        sessionId: prepared.sessionId ?? input.sessionId ?? null,
        isRollup,
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

  if (typeof ctx.logger === "function") {
    ctx.logger({
      event: "report_written",
      identifier,
      round: result.report.round,
      report_id: result.report.id,
      actor: `${actor.kind}:${actor.id}`,
    });
  }
  return result;
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

  // Logged only after the transaction commits: a rolled-back delivery must not
  // leave a record that says it happened.
  let observed = null;
  const result = transaction(
    ctx.db,
    () => {
      const task = loadTask(ctx, input.taskId);

      // A terminal card has nothing to deliver. `to` is wire-only (the CLI does
      // not offer it), and the reopen edge now makes `to: "todo"` a legal
      // transition — without this guard, `POST /deliver {"to":"todo"}` would be
      // a reasonless reopen that also writes a report. Reopening is `issue
      // reopen`, which is audited.
      if (isTerminalStatus(task.status)) {
        throw new DomainError("TERMINAL_STATE", {
          message: `task is ${task.status} (terminal); it cannot be delivered`,
          details: { from: task.status, to, taskId: task.id },
          hint: { fix: `taskctl issue reopen ${task.identifier} --reason "<why>"` },
        });
      }

      // The move must be legal at all. The *gate* is deliberately not consulted
      // here: this transaction is what satisfies it, by inserting the report
      // (or stamping the waiver) below. The database trigger still checks that
      // it really happened — if the ordering here were wrong, the status update
      // would be refused.
      transitionPolicyFor(task).assert(to);
      // `deliver` accepts a wire-only `to`; a delivery that lands on `done` is
      // still an acceptance and obeys the card's own acceptance mode. In `off`
      // mode this is the direct `in_progress → done` path.
      if (to === STATUS.DONE) assertAcceptance(ctx, task, actor);
      // No delivery to review, and no acceptance, while a child is in flight.
      // Checked before the report is written, so a refusal costs nothing.
      assertChildrenTerminal(ctx, task, to);
      if (to === STATUS.DONE) assertReviewReady(ctx, task, actor);

      if (waived) {
        // 0033 — a container has no report of its own to waive: its evidence is
        // the rollup over its children. The deliberate exit is to roll up (or
        // cancel the epic), never to skip the evidence.
        if (task.kind === TASK_KIND.EPIC) {
          throw new DomainError("ROLLUP_REQUIRED", {
            message:
              `${task.identifier}: an epic cannot be delivered under a report waiver — ` +
              "its delivery evidence is the rollup over its children",
            details: { taskId: task.id, identifier: task.identifier, round: task.deliveryRound },
            hint: {
              command: `taskctl report template ${task.identifier}`,
              note: "fill the child list, then deliver it on the epic",
            },
          });
        }
        // A waiver excuses the *delivery* gate, never the acceptance gate: a
        // non-empty baseline still needs a current-round report before done.
        if (to === STATUS.DONE) assertAcceptanceCoverage(ctx, task);
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
        // A waived delivery enters the work (`in_review` counts — a nested epic
        // can be delivered straight out of `todo`), and can still finish a
        // child; both hooks live in commands/rollup.mjs.
        if (hasChildStarted(moved.status)) startContainerForChild(ctx, task.id, now);
        if (moved.status === STATUS.DONE) advanceContainerForChild(ctx, task.id, now);
        observed = {
          identifier: task.identifier,
          from: task.status,
          to: moved.status,
          round: waiver.round,
          reportId: null,
        };
        return { task: moved, report: null, waived: true };
      }

      const prepared = normalizeReportCreate(
        { ...input.report, author: resolveAuthor(ctx, input.report?.author ?? actor, now) },
        {
          taskRound: task.deliveryRound,
          now,
        },
      );
      // The prepared row is not in the repository yet, so the gate is given it
      // directly; if it fails, the transaction rolls back and no report is left
      // behind.
      if (to === STATUS.DONE) assertAcceptanceCoverage(ctx, task, { report: prepared });
      // The artifact contract: a report that cites a path must name the commit
      // it was made in. Runs on the *prepared* row (after bounding), so a
      // truncated-away commit anchor is a refusal, not a silent pass.
      assertDeliveryCommitAnchor(task, prepared);
      // The same shape rule for acceptance claims: a `met` that names no anchor
      // can never be accepted, and the round binds the report — refusing it now
      // costs the worker one edit instead of the review a wasted round.
      assertDeliveryEvidenceAnchors(task, prepared);
      const isRollup = task.kind === TASK_KIND.EPIC;
      if (isRollup) assertRollupCoverage(ctx, task, prepared.acceptance);
      const report = insertDeliveryReport(ctx, {
        taskId: task.id,
        prepared,
        seg: prepared.seg ?? input.seg ?? null,
        sessionId: prepared.sessionId ?? input.sessionId ?? null,
        isRollup,
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
      // Same hooks as the waived branch: a delivery enters the work (so a nested
      // container can start), and a delivery straight to `done` can finish one.
      if (hasChildStarted(moved.status)) startContainerForChild(ctx, task.id, now);
      if (moved.status === STATUS.DONE) advanceContainerForChild(ctx, task.id, now);
      observed = {
        identifier: task.identifier,
        from: task.status,
        to: moved.status,
        round: report.round,
        reportId: report.id,
      };
      return { task: moved, report, waived: false };
    },
    { op: "reports.deliver" },
  );

  if (typeof ctx.logger === "function" && observed !== null) {
    ctx.logger({
      event: "task_delivered",
      identifier: observed.identifier,
      from: observed.from,
      to: observed.to,
      round: observed.round,
      report_id: observed.reportId,
      waived: result.waived,
      actor: `${actor.kind}:${actor.id}`,
    });
  }
  return result;
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
