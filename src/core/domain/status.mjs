/**
 * The task lifecycle state machine (F1 ruling: whitelist table, option A).
 *
 * The whitelist is the *only* fact source: `domain/status.mjs` decides the
 * service-layer path and `migrations/0002_invariants.sql` re-encodes the exact
 * same table as a trigger, so the DB is the machine guarantee behind the same
 * rules (`test/contract/state-machine.test.mjs` walks every ordered pair, for a
 * `task` *and* for an `epic`, down both paths).
 *
 * Since 0024 the whitelist has **two rows per status for one pair**: the base
 * table below is the `task` row and {@link EPIC_ONLY_TRANSITIONS} is the one
 * pair an `epic` adds to it. The second axis is confined to `kind` — it is not a
 * general-purpose rule hook — and every predicate takes it as an optional last
 * argument, so a caller with no kind in hand reads the base table.
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
import { STATUS, STATUSES, TASK_KIND } from "./enums.mjs";

/**
 * `from` → allowed `to` values. Every pair *not* listed here is rejected with
 * `INVALID_TRANSITION` (or `TERMINAL_STATE` when `from` is terminal).
 *
 * This is the **task** row. An `epic` adds {@link EPIC_ONLY_TRANSITIONS} on top
 * of it (0024); `kind` is the second argument of every predicate below, and a
 * caller that does not pass one gets exactly this table.
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

/**
 * The **epic overlay** (0024): the pairs that are legal for an `epic` and for no
 * other kind.
 *
 * An `epic` is a container — never claimed, never `in_progress` (that refusal is
 * `domain/claim.mjs#decideClaim`, and it is product semantics: `GLOSSARY.md`
 * "Epic"). So the one assumption every other row of the table can make —
 * *`in_review` is entered from the work cycle* — does not hold for it: `todo` is
 * where `issue create --kind epic` puts a container, and without an exit there
 * the card can never be delivered, and so never reach `done`. The pair is
 * **added** to the row rather than replacing it; the whitelist stays a whitelist.
 *
 * One pair, and only `todo → in_review`:
 *
 *   - `todo` is the epic's ready state, and the only one that means "released for
 *     work" — so it is the only state that may be delivered from. `backlog` is
 *     deliberately absent: an unreleased container is not deliverable, exactly as
 *     an unreleased task is not claimable.
 *   - `todo → in_progress` is *not* removed. It is the claim gate, not the table,
 *     that refuses an epic, and moving that refusal into the table would take
 *     `in_progress → todo`'s counterexample apart for `deploy` cards too.
 *
 * What the overlay does **not** relax is the delivery gate: `requiresReport`
 * keys on `to` alone, so an epic landing in `in_review` still owes a report for
 * the current round — the rollup, which is what a reviewer reads. The database
 * mirrors both halves (`0024_epic_deliver_from_todo.sql`).
 */
export const EPIC_ONLY_TRANSITIONS = Object.freeze({
  [STATUS.TODO]: Object.freeze([STATUS.IN_REVIEW]),
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
 * The allowed targets of `from` **for this kind of card**.
 *
 * `kind` is the card's own `kind` (`TASK_KIND`). An `epic` gets
 * {@link EPIC_ONLY_TRANSITIONS} laid over the base row; every other kind — and a
 * caller that states none — reads the base table unchanged, which is the
 * fail-closed direction: an unstated kind is never *more* permissive.
 *
 * @param {string} from
 * @param {string|null} [kind] the card's kind, or `null`/omitted for the base table
 * @returns {readonly string[]} allowed targets (empty for terminal statuses and
 *   for unknown inputs).
 */
export function allowedTargets(from, kind = null) {
  const base = ALLOWED_TRANSITIONS[from];
  if (base === undefined) return Object.freeze([]);
  if (kind !== TASK_KIND.EPIC) return base;
  const extra = EPIC_ONLY_TRANSITIONS[from];
  return extra === undefined ? base : Object.freeze([...base, ...extra]);
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {boolean} whether the pair is on the whitelist for this kind
 */
export function canTransition(from, to, kind = null) {
  return allowedTargets(from, kind).includes(to);
}

/**
 * Machine-readable reason for a rejection, or `null` when the pair is allowed.
 * Kept separate from `assertTransition` so the contract test can assert codes
 * without catching exceptions.
 *
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {"TERMINAL_STATE"|"INVALID_TRANSITION"|null}
 */
export function transitionReasonCode(from, to, kind = null) {
  if (canTransition(from, to, kind)) return null;
  if (isTerminalStatus(from)) return "TERMINAL_STATE";
  return "INVALID_TRANSITION";
}

/**
 * Assert a transition, throwing the same reason code the DB trigger raises.
 *
 * The refusal carries the target's own `allowed` list, so the repair a caller
 * prints is the move that caller can actually make — an epic in `todo` is told
 * `in_review` is available, a task in `todo` is not.
 *
 * @param {string} from
 * @param {string} to
 * @param {string|null} [kind] the card's kind (see {@link allowedTargets})
 * @returns {string} `to`, for chaining
 */
export function assertTransition(from, to, kind = null) {
  if (!isKnownStatus(from) || !isKnownStatus(to)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown status value(s): from=${JSON.stringify(from)} to=${JSON.stringify(to)}`,
      details: { from, to, allowed: STATUSES },
    });
  }
  const reason = transitionReasonCode(from, to, kind);
  if (reason !== null) {
    throw new DomainError(reason, {
      details: {
        from,
        to,
        allowed: [...allowedTargets(from, kind)],
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
