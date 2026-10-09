/**
 * Claim policy (I1/I2) as a pure decision.
 *
 * The CAS itself lives in SQL (`repositories/tasks.mjs#claimCas` /
 * `stealStaleClaim`): one `UPDATE … WHERE … version=?`, and the winner is
 * whoever's statement reports a changed row. What is decided *here* is what to
 * do about the three observable outcomes — because "0 rows changed" is not an
 * error message.
 *
 * T-20261009-230500-claimassignee added the **execution-side routing lock**: a
 * card carries two different people. `assignee` is the routing/responsibility
 * (who the card belongs to); `claimed_by` is the execution lock (who is doing
 * it now). Normally they are the same person. Claiming — `todo → in_progress` —
 * is only allowed when they *are*, unless one of two audited exceptions applies:
 *
 *   * an **unassigned** card (`assigneeId == null`) is an open pool — there is
 *     nobody to be "not the assignee" of, so any actor may take it;
 *   * `--allow-steal --reason "<why>"` explicitly overrides the routing lock.
 *
 * Re-claiming an `in_progress` card is governed by heartbeat age:
 *
 *   * `≤ 10min` (fresh): the holder reuses it; anyone else is blocked (409);
 *   * `10min … 6h`: only the **holder** may re-claim it;
 *   * `> 6h` (or no heartbeat at all): the claim has rotted — anybody may take
 *     it, and the takeover is audited (`steal: true`).
 *
 * An `epic` is a grouping card and is never claimable. `backlog` is not
 * claimable either — only `todo` is (the state machine's `isClaimable`).
 *
 * Pure: no `node:` specifiers, no clock — callers pass `now` and inject the
 * `resolveAssignee` lookup, so this stays testable without a database.
 */

import { CLAIM_STALE_ANY_MS, HEARTBEAT_FRESH_MS } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { norm } from "../../shared/norm.mjs";
import { isClaimable } from "./status.mjs";

/** What `decideClaim` can conclude. */
export const CLAIM_ACTIONS = Object.freeze({
  TAKE: "take",
  REUSE: "reuse",
  CONFLICT: "conflict",
  CORRUPT: "corrupt",
  INVALID: "invalid",
});

/**
 * Is `actorId` the card's assignee?
 *
 * The assignee is the dictionary entry for `task.assigneeId`; the caller injects
 * the lookup (`resolveAssignee(task)`) so this stays pure. Comparison is by the
 * project's one identity rule (`norm`): NFKC, whitespace removed, case folded —
 * so `linus`, `Linus` and ` L I N U S ` are one person, and the dictionary id or
 * display name resolve the same entry.
 *
 * An **unassigned** card (no `assigneeId`, or a dangling reference) returns
 * `true` for everyone: there is no route to violate, so the card is an open
 * pool. This is what lets the eight-way contention race claim an unassigned card.
 *
 * @param {object} task a Task DTO
 * @param {string} actorId
 * @param {((task: object) => object|null)|null} [resolveAssignee]
 * @returns {boolean}
 */
export function isAssignee(task, actorId, resolveAssignee) {
  const assigneeId = task.assigneeId;
  if (assigneeId === null || assigneeId === undefined || assigneeId === "") return true;
  const entry = typeof resolveAssignee === "function" ? resolveAssignee(task) : null;
  if (entry === null || entry === undefined) return true; // dangling ⇒ open pool
  const actorKey = identityKey(actorId);
  if (actorKey === null) return false;
  return (
    identityKey(entry.id) === actorKey ||
    identityKey(entry.displayName) === actorKey ||
    identityKey(entry.normalizedName) === actorKey
  );
}

/** `norm`, wrapped so an empty/blank value is a miss rather than a throw. */
function identityKey(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return norm(value);
  } catch {
    return null;
  }
}

/** Heartbeat age in ms, or `null` when there is no usable heartbeat. */
function heartbeatAgeMs(task, now) {
  const at = task.heartbeatAt;
  if (at === null || at === undefined || at === "") return null;
  const age = new Date(now).getTime() - new Date(at).getTime();
  return Number.isFinite(age) && age >= 0 ? age : null;
}

/**
 * @param {object} task a Task DTO
 * @param {{actor: string, now: string, freshMs?: number, allowSteal?: boolean, resolveAssignee?: ((task: object) => object|null)|null}} options
 * @returns {{action: string, code: string|null, reason?: string, reclaim?: boolean, steal?: boolean, stolenFrom?: string}}
 */
export function decideClaim(task, options) {
  const {
    actor,
    now,
    freshMs = HEARTBEAT_FRESH_MS,
    allowSteal = false,
    resolveAssignee = null,
  } = options;

  if (task.status === "in_progress") {
    const holder = task.claimedBy;
    if (holder === null || holder === undefined || holder === "") {
      return {
        action: CLAIM_ACTIONS.CORRUPT,
        code: "EXECUTION_STATE_CORRUPT",
        reason: "task is in_progress but nobody claims it",
      };
    }
    const age = heartbeatAgeMs(task, now);
    if (age !== null && age <= freshMs) {
      if (holder === actor) {
        return { action: CLAIM_ACTIONS.REUSE, code: null, reason: "the same actor already holds a fresh claim" };
      }
      return {
        action: CLAIM_ACTIONS.CONFLICT,
        code: "EXECUTION_ACTIVE",
        reason: `${holder} holds a fresh claim (heartbeat ${task.heartbeatAt})`,
      };
    }
    if (age !== null && age <= CLAIM_STALE_ANY_MS) {
      // Past fresh but not yet rotted: the lock has loosened for its holder
      // only. Re-claiming resets the lock (`reclaim`), and is not an audited
      // steal because the same person keeps it.
      if (holder === actor) {
        return {
          action: CLAIM_ACTIONS.TAKE,
          code: null,
          reason: "re-claiming a claim that went stale for its holder",
          reclaim: true,
        };
      }
      return {
        action: CLAIM_ACTIONS.CONFLICT,
        code: "EXECUTION_ACTIVE",
        reason: `${holder} still holds this task; only they may re-claim it within 6 hours`,
      };
    }
    // Older than six hours — or no heartbeat at all: the claim is not a claim.
    return {
      action: CLAIM_ACTIONS.TAKE,
      code: null,
      reason: `previous claim by ${holder} went stale`,
      reclaim: true,
      steal: true,
      stolenFrom: holder,
    };
  }

  if (isClaimable(task.status)) {
    if (task.kind === "epic") {
      return {
        action: CLAIM_ACTIONS.INVALID,
        code: "not_claimable",
        reason: "an epic is a grouping card and cannot be claimed",
      };
    }
    if (isAssignee(task, actor, resolveAssignee)) {
      return { action: CLAIM_ACTIONS.TAKE, code: null };
    }
    if (allowSteal === true) {
      const entry = typeof resolveAssignee === "function" ? resolveAssignee(task) : null;
      return {
        action: CLAIM_ACTIONS.TAKE,
        code: null,
        reason: "claimed by an explicit, audited --allow-steal",
        steal: true,
        stolenFrom: entry?.displayName ?? task.assigneeId,
      };
    }
    return {
      action: CLAIM_ACTIONS.INVALID,
      code: "not_assignee",
      reason: "this task is assigned to somebody else; only the assignee may claim it",
    };
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
 * @param {{actor: string, now: string, freshMs?: number, allowSteal?: boolean, resolveAssignee?: ((task: object) => object|null)|null}} options
 * @throws {DomainError} EXECUTION_STATE_CORRUPT / EXECUTION_ACTIVE / not_assignee / not_claimable / INVALID_TRANSITION
 */
export function assertClaimable(task, options) {
  const verdict = decideClaim(task, options);
  if (verdict.code === null) return verdict;

  const ref = task.identifier ?? task.id;
  throw new DomainError(verdict.code, {
    message: `${ref}: ${verdict.reason}`,
    details: {
      taskId: task.id,
      status: task.status,
      kind: task.kind ?? null,
      claimedBy: task.claimedBy ?? null,
      heartbeatAt: task.heartbeatAt ?? null,
      actor: options.actor,
      ...(verdict.code === "not_assignee" ? { assignee: task.assigneeId ?? null } : {}),
    },
    // A repair command names the actual card, the way the report gate's does.
    ...(verdict.code === "not_assignee"
      ? { hint: { fix: `taskctl issue move ${ref} in_progress --allow-steal --reason "<why>"` } }
      : {}),
  });
}

/**
 * How a 0-row CAS is explained, once the current row has been re-read inside
 * the same transaction.
 *
 * @param {{before: object, after: object|null, actor: string, now: string, ifVersion?: number, freshMs?: number, allowSteal?: boolean, resolveAssignee?: ((task: object) => object|null)|null}} input
 */
export function explainLostClaim(input) {
  const { before, after, actor, now, ifVersion, freshMs, allowSteal, resolveAssignee } = input;

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
  const verdict = decideClaim(after, { actor, now, freshMs, allowSteal, resolveAssignee });
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
