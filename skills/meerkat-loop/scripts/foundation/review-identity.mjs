/**
 * The **one** reader for a card's review identity.
 *
 * A review card's identity used to be read four different ways: the acceptance
 * gate read `review_of_id` / `review_round`, the workflow's readable key read
 * only `meta.review_of`, the SLA patrol read only the meta mirror, and the web
 * read only the columns. A column-only row could therefore be a review to one
 * layer and an ordinary card to another. `0025` made the columns the authority
 * and kept the meta as a readable identifier mirror; this module is where that
 * precedence is written down once.
 *
 * It lives in `foundation/` rather than `core/domain/` because the SLA patrol
 * is a foundation module and the dependency direction is `core → foundation`.
 * Pure: no `node:` specifiers, no clock, no I/O.
 */

/**
 * A field that may arrive under its wire spelling or its repository DTO
 * spelling. The board has both: snapshots are snake_case, repositories return
 * camelCase.
 *
 * @param {object|null|undefined} task
 * @param {string} snake
 * @param {string} camel
 */
function fieldOf(task, snake, camel) {
  if (task === null || task === undefined) return null;
  const value = task[snake] ?? task[camel];
  return value === undefined ? null : value;
}

/** A non-empty trimmed string, or `null`. */
function text(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A non-negative integer from a number or a digit string, or `null`.
 *
 * `0` is a legal answer for `ownRound` (the DTO's default) and is deliberately
 * *not* treated as "no round" — `auditedRound` is the one place where an absent
 * value means the legacy "covers every round" reading.
 *
 * @param {unknown} value
 */
function intOrNull(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

/** Resolve `id → identifier` from a Map or a plain object. */
function lookup(byId, id) {
  if (byId === null || byId === undefined || id === null) return null;
  const value = typeof byId.get === "function" ? byId.get(id) : byId[id];
  return text(value);
}

/**
 * Read a card's review identity.
 *
 * Precedence:
 *   1. `review_of_id` — the structural column (0025). When it resolves through
 *      `byId`, the resolved identifier is the readable name.
 *   2. `meta.review_of` — the legacy/readable mirror, used only when the column
 *      is absent (`legacy: true`) or the caller supplied no `byId`.
 *   3. neither — an ordinary card.
 *
 * `auditedRound` is `review_round` first, then `meta.review_round`; a `null`
 * answer is the legacy "this review covers every round" reading, never 0.
 * `ownRound` is the review card's own `delivery_round` (the round its report is
 * stamped with), which is a different number from `auditedRound`.
 *
 * @param {object|null|undefined} task a wire task or repository DTO
 * @param {{byId?: Map<string,string>|Record<string,string>|null}} [options]
 * @returns {{
 *   isReview: boolean,
 *   originalId: string|null,
 *   originalRef: string|null,
 *   auditedRound: number|null,
 *   ownRound: number,
 *   legacy: boolean,
 * }}
 */
export function reviewIdentityOf(task, options = {}) {
  const byId = options.byId ?? null;
  const meta = task?.meta ?? {};

  const originalId = text(fieldOf(task, "review_of_id", "reviewOfId"));
  const metaRef = text(meta.review_of);
  const structuralRound = intOrNull(fieldOf(task, "review_round", "reviewRound"));
  const metaRound = intOrNull(meta.review_round);

  const isReview = originalId !== null || metaRef !== null;
  // The column is authoritative; the meta mirror is a display/legacy fallback.
  const resolved = lookup(byId, originalId);
  const originalRef = resolved ?? metaRef;

  return {
    isReview,
    originalId,
    originalRef,
    auditedRound: structuralRound ?? metaRound,
    ownRound: intOrNull(fieldOf(task, "delivery_round", "deliveryRound")) ?? 0,
    legacy: isReview && originalId === null,
  };
}

/**
 * Build the `id → identifier` index the reader takes. Callers that already hold
 * a board snapshot should build it once rather than re-deriving it per card.
 *
 * @param {object[]|null|undefined} tasks
 * @returns {Map<string,string>}
 */
export function reviewIdentityIndex(tasks) {
  const byId = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (typeof task?.id === "string" && task.id !== "" && typeof task.identifier === "string") {
      byId.set(task.id, task.identifier);
    }
  }
  return byId;
}
