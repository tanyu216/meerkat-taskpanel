/**
 * The cycle verdict: one name for "is this round done?".
 *
 * The loop already knows every fact that decides a card's cycle — the board
 * status, the queue row, its attempt/timeout/crash counters, its backoff — but
 * each reader decided "settled" for itself. This module is the one pure
 * judgment: it reads facts and returns a level, writing nothing.
 *
 * `CYCLE_LEVELS` is ordered by precedence, and `cycleVerdict` applies that order
 * unconditionally: a finished row is settled even when a counter is also spent,
 * and a terminal card is terminal whatever its row says.
 *
 * Node builtins only; this file must not import from `src/orchestrator`.
 */

import { TERMINAL_STATUSES } from "./sla-patrol.mjs";

/** The four settled levels, highest precedence first. */
export const CYCLE_LEVELS = Object.freeze(["terminal", "settled", "needs_human", "in_flight"]);

/** Row statuses that mean "queued and still owned by the loop". */
const IN_FLIGHT_ROW_STATUSES = Object.freeze(["pending", "processing", "dispatched"]);

function atLeast(value, bound) {
  return Number(value ?? 0) >= Number(bound ?? 0);
}

/**
 * Classify one card's cycle.
 *
 * Precedence (fixed; `test/contract/cycle-verdict.test.mjs` pins it):
 *
 * 1. card status is terminal → `terminal/card_terminal`
 * 2. row is done → `settled/row_done`
 * 3. row failed → `needs_human/row_failed`
 * 4. attempt bound spent → `needs_human/handoff_attempts`
 * 5. timeout bound spent → `needs_human/turn_timeouts`
 * 6. crash-recovery bound spent → `needs_human/crash_recoveries`
 * 7. retry time still in the future → `in_flight/backoff`
 * 8. row pending/processing/dispatched → `in_flight/queued`
 * 9. a live card with no row → `needs_human/unclaimed`
 * 10. anything else → `needs_human/unknown` (never throws)
 *
 * @param {{
 *   cardStatus?: string|null,
 *   rowStatus?: string|null,
 *   attempts?: number, maxAttempts?: number,
 *   timeouts?: number, maxTimeouts?: number,
 *   recoveries?: number, maxRecoveries?: number,
 *   retryAt?: string|null,
 *   now?: number,
 *   terminalStatuses?: readonly string[],
 * }} [input]
 * @returns {{level: string, reason: string}}
 */
export function cycleVerdict({
  cardStatus = null,
  rowStatus = null,
  attempts = 0,
  maxAttempts = 3,
  timeouts = 0,
  maxTimeouts = 3,
  recoveries = 0,
  maxRecoveries = 3,
  retryAt = null,
  now = Date.now(),
  terminalStatuses = TERMINAL_STATUSES,
} = {}) {
  const card = cardStatus === null || cardStatus === undefined ? "" : String(cardStatus);
  const row = rowStatus === null || rowStatus === undefined ? "" : String(rowStatus);

  if (card !== "" && terminalStatuses.includes(card)) {
    return { level: "terminal", reason: "card_terminal" };
  }
  if (row === "done") return { level: "settled", reason: "row_done" };
  if (row === "failed") return { level: "needs_human", reason: "row_failed" };
  // A caller with a tighter bound (the director's two-attempt lane) passes it
  // in; the default is the handoff bound.
  if (atLeast(attempts, maxAttempts)) return { level: "needs_human", reason: "handoff_attempts" };
  if (atLeast(timeouts, maxTimeouts)) return { level: "needs_human", reason: "turn_timeouts" };
  if (atLeast(recoveries, maxRecoveries)) return { level: "needs_human", reason: "crash_recoveries" };

  const retry = Date.parse(String(retryAt ?? ""));
  if (!Number.isNaN(retry) && retry > now) return { level: "in_flight", reason: "backoff" };
  if (IN_FLIGHT_ROW_STATUSES.includes(row)) return { level: "in_flight", reason: "queued" };
  if (card !== "" && row === "") return { level: "needs_human", reason: "unclaimed" };
  return { level: "needs_human", reason: "unknown" };
}

/**
 * Group queue rows by the card they hand off. Rows with no card are ignored —
 * they cannot be a card's cycle.
 *
 * @param {object[]|null|undefined} rows
 * @returns {Map<string, object[]>}
 */
export function groupQueueRowsByCard(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const card = String(row?.card ?? "");
    if (card === "") continue;
    const group = groups.get(card);
    if (group === undefined) groups.set(card, [row]);
    else group.push(row);
  }
  return groups;
}

/**
 * The newest row in a group: latest `enqueuedAt`, and the later array entry on
 * a tie or a missing timestamp.
 *
 * @param {object[]|null|undefined} rows
 * @returns {object|null}
 */
export function newestRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let best = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const row of list) {
    if (row === null || typeof row !== "object") continue;
    const at = Date.parse(String(row.enqueuedAt ?? ""));
    // A row with no usable timestamp still wins when it is the only candidate.
    const stamp = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    if (best === null || stamp >= bestAt) {
      best = row;
      bestAt = stamp;
    }
  }
  return best;
}
