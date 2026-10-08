/**
 * Claim policy (I1/I2) as a pure decision.
 *
 * The CAS itself lives in SQL (`repositories/tasks.mjs#claimCas`): one
 * `UPDATE … WHERE status='todo' AND version=?`, and the winner is whoever's
 * statement reports a changed row. What is decided *here* is what to do about
 * the three observable outcomes — because "0 rows changed" is not an error
 * message:
 *
 *   * a **fresh** claim by somebody else ⇒ somebody is working on it (409)
 *   * a fresh claim by *me*            ⇒ reuse it, do not reset the heartbeat
 *   * `in_progress` with no claimer    ⇒ corruption, not contention (500, I2)
 *
 * Pure: no `node:` specifiers, no clock — callers pass `now`.
 */

import { HEARTBEAT_FRESH_MS } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { isClaimable } from "./status.mjs";
import { isClaimFresh } from "./task.mjs";

/** What `decideClaim` can conclude. */
export const CLAIM_ACTIONS = Object.freeze({
  TAKE: "take",
  REUSE: "reuse",
  CONFLICT: "conflict",
  CORRUPT: "corrupt",
  INVALID: "invalid",
});

/**
 * @param {object} task a Task DTO
 * @param {{actor: string, now: string, freshMs?: number}} options
 * @returns {{action: string, code: string|null, reason?: string, steal?: boolean}}
 */
export function decideClaim(task, options) {
  const { actor, now, freshMs = HEARTBEAT_FRESH_MS } = options;

  if (task.status === "in_progress") {
    const holder = task.claimedBy;
    if (holder === null || holder === undefined || holder === "") {
      return {
        action: CLAIM_ACTIONS.CORRUPT,
        code: "EXECUTION_STATE_CORRUPT",
        reason: "task is in_progress but nobody claims it",
      };
    }
    const fresh = isClaimFresh(task, { now, freshMs });
    if (fresh && holder === actor) {
      return {
        action: CLAIM_ACTIONS.REUSE,
        code: null,
        reason: "the same actor already holds a fresh claim",
      };
    }
    if (fresh) {
      return {
        action: CLAIM_ACTIONS.CONFLICT,
        code: "EXECUTION_ACTIVE",
        reason: `${holder} holds a fresh claim (heartbeat ${task.heartbeatAt})`,
      };
    }
    // A stale claim is not a claim: take it over, recording who took it.
    return {
      action: CLAIM_ACTIONS.TAKE,
      code: null,
      reason: `previous claim by ${holder} went stale`,
      steal: true,
    };
  }

  if (isClaimable(task.status)) {
    return { action: CLAIM_ACTIONS.TAKE, code: null };
  }

  return {
    action: CLAIM_ACTIONS.INVALID,
    code: "INVALID_TRANSITION",
    reason: `only todo tasks can be claimed, this one is ${task.status}`,
  };
}

/**
 * The same decision, as a throw.
 *
 * @param {object} task
 * @param {{actor: string, now: string, freshMs?: number}} options
 * @throws {DomainError} EXECUTION_STATE_CORRUPT / EXECUTION_ACTIVE / INVALID_TRANSITION
 */
export function assertClaimable(task, options) {
  const verdict = decideClaim(task, options);
  if (verdict.code === null) return verdict;

  throw new DomainError(verdict.code, {
    message: `${task.identifier ?? task.id}: ${verdict.reason}`,
    details: {
      taskId: task.id,
      status: task.status,
      claimedBy: task.claimedBy ?? null,
      heartbeatAt: task.heartbeatAt ?? null,
      actor: options.actor,
    },
  });
}

/**
 * How a 0-row CAS is explained, once the current row has been re-read inside
 * the same transaction.
 *
 * @param {{before: object, after: object|null, actor: string, now: string, ifVersion?: number, freshMs?: number}} input
 */
export function explainLostClaim(input) {
  const { before, after, actor, now, ifVersion, freshMs } = input;

  if (after === null || after === undefined) {
    return new DomainError("NOT_FOUND", {
      message: "task disappeared while claiming it",
      details: { taskId: before.id },
    });
  }
  if (ifVersion !== undefined && after.version !== ifVersion) {
    return new DomainError("VERSION_CONFLICT", {
      message: `task changed under us (version ${after.version}, expected ${ifVersion})`,
      details: { taskId: after.id, currentVersion: after.version, expectedVersion: ifVersion },
    });
  }
  const verdict = decideClaim(after, { actor, now, ...(freshMs === undefined ? {} : { freshMs }) });
  if (verdict.code !== null) {
    return new DomainError(verdict.code, {
      message: `${after.identifier ?? after.id}: lost the claim race (${verdict.reason})`,
      details: { taskId: after.id, status: after.status, claimedBy: after.claimedBy ?? null },
    });
  }
  return new DomainError("CLAIM_LOST", {
    message: `${after.identifier ?? after.id}: the claim was taken concurrently`,
    details: { taskId: after.id, status: after.status },
  });
}
