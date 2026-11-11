/**
 * Intake requests — a human's free-text work description, turned into cards by
 * the decision lane.
 *
 * The write path is deliberately small: submit one description bound to a
 * project; the decision lane later records the cards it filed (`consumed`) or
 * why it could not (`failed`). The request is board state; each command appends
 * its `task_activities` row in the same transaction, so the stream sees every
 * change and a consumer re-reads this row for the truth.
 *
 * Three rules carry the reliability story:
 *
 *   * **Idempotent submit.** `(project_id, idem)` is unique. A double click or a
 *     retried POST returns the request that already landed — no second row, no
 *     second activity row, no second director turn.
 *   * **Compare-and-set settlement.** Both terminal writes are `UPDATE … WHERE
 *     status = 'pending'`; the first writer wins and every later caller re-reads
 *     the settled row. A cross-terminal call (complete after fail) is a real
 *     contradiction and names `INVALID_TRANSITION`.
 *   * **No reopen.** A refused description is resubmitted as a new request; the
 *     history of the refusal stays readable.
 */

import { INTAKE_TEXT_MAX } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { normalizeIdem } from "../domain/idem.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/** The refusal shape a `project_id` that names no project gets. */
function projectRefusal(projectId) {
  return new DomainError("VALIDATION_FAILED", {
    message: `project ${JSON.stringify(projectId)} does not exist`,
    details: { field: "project_id", projectId },
  });
}

/** The description as it will be stored, or a refusal. */
function intakeText(value) {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "intake text is required",
      details: { field: "text" },
    });
  }
  const text = value.trim();
  if (text === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "intake text is required",
      details: { field: "text" },
    });
  }
  if (text.length > INTAKE_TEXT_MAX) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `intake text is longer than ${INTAKE_TEXT_MAX} characters`,
      details: { field: "text", max: INTAKE_TEXT_MAX, length: text.length },
    });
  }
  return text;
}

/** The created refs, trimmed and de-duplicated in first-seen order. */
function createdRefs(value) {
  if (!Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "created must be an array of card identifiers",
      details: { field: "created" },
    });
  }
  const refs = [];
  const seen = new Set();
  for (const item of value) {
    const ref = typeof item === "string" ? item.trim() : "";
    if (ref === "" || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  if (refs.length === 0) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a consumed intake request must name at least one created card",
      details: { field: "created" },
    });
  }
  return refs;
}

/** A non-empty refusal reason. */
function failureReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a failure reason is required",
      details: { field: "reason" },
    });
  }
  return reason;
}

/**
 * Submit one description.
 *
 * @param {object} ctx
 * @param {{projectId: string, text: string, idem?: string|null, actor?: object}} input
 */
export function createIntake(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  const text = intakeText(input.text);
  const project = ctx.repos.projects.get(input.projectId);
  if (project === null || project === undefined) throw projectRefusal(input.projectId);
  const idem = normalizeIdem(input.idem);
  if (idem !== null) {
    const existing = ctx.repos.intake.findByProjectIdem(project.id, idem);
    if (existing !== null) return existing;
  }
  const now = ctx.now();
  try {
    return transaction(
      ctx.db,
      () => {
        const request = ctx.repos.intake.insert({
          projectId: project.id,
          text,
          idem,
          createdBy: actor.id,
          createdKind: actor.kind,
          now,
        });
        ctx.repos.activities.append({
          taskId: null,
          actorKind: actor.kind,
          actorId: actor.id,
          event: "intake_requested",
          changes: { intake_id: request.id, project_id: request.projectId },
          createdAt: now,
        });
        return request;
      },
      { op: "intake.create" },
    );
  } catch (err) {
    // The unique index resolves a race between two submits of the same key:
    // the loser reads the winner's row, exactly like the pre-read above.
    if (err?.code === "IDEM_EXISTS" && idem !== null) {
      const existing = ctx.repos.intake.findByProjectIdem(project.id, idem);
      if (existing !== null) return existing;
    }
    throw err;
  }
}

/**
 * One request, or `INTAKE_NOT_FOUND`.
 *
 * @param {object} ctx
 * @param {{id: string}} input
 */
export function getIntake(ctx, input) {
  const request = ctx.repos.intake.get(input.id);
  if (request === null) {
    throw new DomainError("INTAKE_NOT_FOUND", {
      message: `no intake request ${JSON.stringify(input.id)}`,
      details: { intakeId: input.id },
    });
  }
  return request;
}

/**
 * The supervisor's read: oldest first.
 *
 * @param {object} ctx
 * @param {{status?: string|null, projectId?: string|null, limit?: number}} [filter]
 */
export function listIntake(ctx, filter = {}) {
  return ctx.repos.intake.list({
    status: filter.status ?? null,
    projectId: filter.projectId ?? null,
    limit: filter.limit,
  });
}

/**
 * `pending → consumed`, recording the cards the decision lane filed.
 *
 * A repeat call after success returns the same row; a call after `failed` is a
 * contradiction, not a retry.
 *
 * @param {object} ctx
 * @param {{id: string, refs: string[], actor?: object}} input
 */
export function completeIntake(ctx, input) {
  const actor = actorOf(input.actor);
  const refs = createdRefs(input.refs);
  // Read first: an unknown id and an already-terminal row are different answers.
  getIntake(ctx, input);
  const now = ctx.now();
  return transaction(
    ctx.db,
    () => {
      const { row, changed } = ctx.repos.intake.complete(input.id, {
        refs,
        settledBy: actor.id,
        settledByKind: actor.kind,
        now,
      });
      if (row === null) {
        throw new DomainError("INTAKE_NOT_FOUND", {
          message: `no intake request ${JSON.stringify(input.id)}`,
          details: { intakeId: input.id },
        });
      }
      if (!changed) {
        if (row.status === "consumed") return row;
        throw new DomainError("INVALID_TRANSITION", {
          message: `intake request ${row.id} is ${row.status}; it cannot be consumed`,
          details: { intakeId: row.id, from: row.status, to: "consumed" },
        });
      }
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "intake_consumed",
        changes: { intake_id: row.id, refs },
        createdAt: now,
      });
      return row;
    },
    { op: "intake.complete" },
  );
}

/**
 * `pending → failed`, recording who declined and why.
 *
 * @param {object} ctx
 * @param {{id: string, reason: string, actor?: object}} input
 */
export function failIntake(ctx, input) {
  const actor = actorOf(input.actor);
  const reason = failureReason(input.reason);
  getIntake(ctx, input);
  const now = ctx.now();
  return transaction(
    ctx.db,
    () => {
      const { row, changed } = ctx.repos.intake.fail(input.id, {
        reason,
        settledBy: actor.id,
        settledByKind: actor.kind,
        now,
      });
      if (row === null) {
        throw new DomainError("INTAKE_NOT_FOUND", {
          message: `no intake request ${JSON.stringify(input.id)}`,
          details: { intakeId: input.id },
        });
      }
      if (!changed) {
        if (row.status === "failed") return row;
        throw new DomainError("INVALID_TRANSITION", {
          message: `intake request ${row.id} is ${row.status}; it cannot be failed`,
          details: { intakeId: row.id, from: row.status, to: "failed" },
        });
      }
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "intake_failed",
        changes: { intake_id: row.id, reason },
        createdAt: now,
      });
      return row;
    },
    { op: "intake.fail" },
  );
}
