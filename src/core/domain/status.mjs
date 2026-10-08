/**
 * The task lifecycle state machine (F1 ruling: whitelist table, option A).
 *
 * The whitelist is the *only* fact source: `domain/status.mjs` decides the
 * service-layer path and `migrations/0002_invariants.sql` re-encodes the exact
 * same table as a trigger, so the DB is the machine guarantee behind the same
 * rules (`test/contract/state-machine.test.mjs` walks all 49 pairs down both
 * paths).
 *
 * Key properties:
 *   - `done` is reachable **only** from `in_review` ⇒ "no delivery without review".
 *   - `done`/`canceled` are terminal (I3).
 *   - Leaving `in_review` (to `in_progress` or `blocked`) starts a new delivery
 *     round (F3), so the previous round's report can no longer satisfy the gate.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { STATUS, STATUSES } from "./enums.mjs";

/**
 * `from` → allowed `to` values. Every pair *not* listed here is rejected with
 * `INVALID_TRANSITION` (or `TERMINAL_STATE` when `from` is terminal).
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.BACKLOG]: Object.freeze([STATUS.TODO, STATUS.CANCELED]),
  [STATUS.TODO]: Object.freeze([STATUS.BACKLOG, STATUS.IN_PROGRESS, STATUS.BLOCKED, STATUS.CANCELED]),
  [STATUS.IN_PROGRESS]: Object.freeze([STATUS.IN_REVIEW, STATUS.BLOCKED, STATUS.TODO, STATUS.CANCELED]),
  [STATUS.IN_REVIEW]: Object.freeze([STATUS.DONE, STATUS.IN_PROGRESS, STATUS.BLOCKED]),
  [STATUS.BLOCKED]: Object.freeze([STATUS.TODO, STATUS.IN_PROGRESS, STATUS.IN_REVIEW, STATUS.CANCELED]),
  [STATUS.DONE]: Object.freeze([]),
  [STATUS.CANCELED]: Object.freeze([]),
});

/** Statuses nothing may leave (I3). */
export const TERMINAL_STATUSES = Object.freeze([STATUS.DONE, STATUS.CANCELED]);

/**
 * Exits from `in_review` that start a new delivery round (F3). Both of these
 * are "the delivery came back" — a rework and a blocker discovered at review
 * time. `in_review → done` is the delivery succeeding and does *not* bump.
 */
export const ROUND_BUMPING_EXITS = Object.freeze([STATUS.IN_PROGRESS, STATUS.BLOCKED]);

/** The single status a task may be claimed from. */
export const CLAIMABLE_STATUS = STATUS.TODO;

/** @param {unknown} value */
export function isKnownStatus(value) {
  return STATUSES.includes(/** @type {string} */ (value));
}

/** @param {unknown} value */
export function isTerminalStatus(value) {
  return TERMINAL_STATUSES.includes(/** @type {string} */ (value));
}

/**
 * @param {string} from
 * @returns {readonly string[]} allowed targets (empty for terminal statuses and
 *   for unknown inputs).
 */
export function allowedTargets(from) {
  return ALLOWED_TRANSITIONS[from] ?? Object.freeze([]);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean} whether the pair is on the whitelist
 */
export function canTransition(from, to) {
  return allowedTargets(from).includes(to);
}

/**
 * Machine-readable reason for a rejection, or `null` when the pair is allowed.
 * Kept separate from `assertTransition` so the contract test can assert codes
 * without catching exceptions.
 *
 * @param {string} from
 * @param {string} to
 * @returns {"TERMINAL_STATE"|"INVALID_TRANSITION"|null}
 */
export function transitionReasonCode(from, to) {
  if (canTransition(from, to)) return null;
  if (isTerminalStatus(from)) return "TERMINAL_STATE";
  return "INVALID_TRANSITION";
}

/**
 * Assert a transition, throwing the same reason code the DB trigger raises.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string} `to`, for chaining
 */
export function assertTransition(from, to) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown status value(s): from=${JSON.stringify(from)} to=${JSON.stringify(to)}`,
      details: { from, to, allowed: STATUSES },
    });
  }
  const reason = transitionReasonCode(from, to);
  if (reason !== null) {
    throw new DomainError(reason, {
      details: {
        from,
        to,
        allowed: [...allowedTargets(from)],
      },
      message:
        reason === "TERMINAL_STATE"
          ? `task is ${from} (terminal); it cannot move to ${to}`
          : `transition ${from} → ${to} is not allowed`,
    });
  }
  return to;
}

/** @param {unknown} value */
export function isClaimable(value) {
  return value === CLAIMABLE_STATUS;
}

/**
 * Does moving `from → to` start a new delivery round?
 * @param {string} from
 * @param {string} to
 */
export function bumpsDeliveryRound(from, to) {
  return from === STATUS.IN_REVIEW && ROUND_BUMPING_EXITS.includes(/** @type {string} */ (to));
}

/**
 * Does entering `to` require a report for the current round?
 * @param {string} to
 */
export function requiresReport(to) {
  return to === STATUS.IN_REVIEW;
}
