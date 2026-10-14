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
 * M1 adds one first-class status, `awaiting` (the card is running but has asked
 * a human — design §2/§6). Three properties of it are load-bearing and are
 * asserted in `test/contract/state-machine.test.mjs`:
 *
 *   - **`in_progress → awaiting` is the only entry.** No other status may reach
 *     it, so the badge's reason stays single-valued.
 *   - **`awaiting → in_progress` is the only way back into the work** (a human
 *     replied); `awaiting → canceled` is allowed (the human cancels);
 *     `awaiting → blocked` and `awaiting → in_review | done` are **forbidden**.
 *     The last one is a delivery-gate bypass: reaching `in_review` from
 *     `awaiting` would skip the report for the current round, which the DB
 *     trigger and this table both refuse.
 *   - **`awaiting` is not terminal, and it does not start a delivery round.**
 *     `awaiting → in_progress` is a *resume of the same attempt*, not a rework:
 *     `ROUND_BUMPING_EXITS` only speaks about leaving `in_review` (F3), so the
 *     round counter is untouched and the round's report, once written, still
 *     counts. The card never left `in_progress` in the board's eyes.
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
  [STATUS.IN_PROGRESS]: Object.freeze([
    STATUS.IN_REVIEW,
    STATUS.BLOCKED,
    STATUS.TODO,
    STATUS.CANCELED,
    // M1 — the single entry into `awaiting` (design §2.1/§6).
    STATUS.AWAITING,
  ]),
  // M1 — the overlay state. Its only exits are back into the work (the human
  // replied) or out of it (the human canceled). `blocked`, `in_review` and
  // `done` are absent on purpose: an `awaiting` card must not be able to reach
  // `in_review` without the report the delivery gate demands.
  [STATUS.AWAITING]: Object.freeze([STATUS.IN_PROGRESS, STATUS.CANCELED]),
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
 *
 * Membership is keyed on the **source** status: a round only ever starts when a
 * card *leaves `in_review`*. So M1's `awaiting → in_progress` is not in this
 * list and cannot be: `awaiting` is entered from `in_progress`, the round never
 * ended, and resuming therefore keeps the same delivery round — and the report
 * already written for it. Written down because "in_progress" appearing in the
 * list makes the pair look like it might belong here; the `from` is what
 * decides (asserted in `test/contract/state-machine.test.mjs`).
 */
export const ROUND_BUMPING_EXITS = Object.freeze([STATUS.IN_PROGRESS, STATUS.BLOCKED]);

/** The single status a task may be claimed from. */
export const CLAIMABLE_STATUS = STATUS.TODO;

/**
 * The **work cycle** — the statuses in which a card keeps its execution claim
 * (`claimed_by` / `claimed_at` / `heartbeat_at`).
 *
 * The claim is a lock on *this* attempt, so it lives exactly as long as the card
 * is being worked: `in_progress` holds it, `awaiting` is the same attempt
 * paused on a human (M1), `in_review` is the same attempt handed over for
 * review, and `blocked` is the same attempt stopped on something external. Every
 * status **outside** the cycle is an exit — `todo`, `backlog` and the terminal
 * pair — and leaving the cycle releases the lock (see
 * `storage/repositories/tasks.mjs#moveCas`).
 *
 * Why the release matters (T-20261014-152924): the schema refuses a claim on a
 * `backlog` card (`CHECK (claimed_by IS NULL OR status <> 'backlog')`), while
 * `in_progress → todo` and `todo → backlog` are both legal transitions. Before
 * the release, the first leg left `claimed_by` behind and the second leg tripped
 * the CHECK — surfacing as a raw `CHECK constraint failed: …` in the UI.
 *
 * Why `in_review` and `blocked` are **inside** the cycle rather than released on
 * entry: both can be exited back into `in_progress` (`rework`, `unblock`), and
 * the card that comes back must still be the *same executor's* card. Releasing
 * on entry would hand the lock to whoever performed the bounce — `rework` does
 * not re-check the routing lock (`commands/tasks.mjs#moveStatus`), so the new
 * holder would be taken silently and the original executor's next heartbeat
 * would be refused with `EXECUTION_ACTIVE` for up to six hours.
 */
export const CLAIM_HOLDING_STATUSES = Object.freeze([
  STATUS.IN_PROGRESS,
  STATUS.AWAITING,
  STATUS.IN_REVIEW,
  STATUS.BLOCKED,
]);

/**
 * Does a card in this status keep its execution claim?
 * @param {unknown} status
 * @returns {boolean}
 */
export function holdsClaim(status) {
  return CLAIM_HOLDING_STATUSES.includes(/** @type {string} */ (status));
}

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
