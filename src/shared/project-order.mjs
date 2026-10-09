/**
 * The PROJECTS list weight algorithm (ARCHITECTURE §4.6), as a pure function.
 *
 * The board must not sort projects itself (§8: "前端只消费顺序"), so the order is
 * computed here — at the boundary — and shipped in the response. The three
 * factors are recency-weighted activity (`A7` over 7 days, `A30` over 30) and
 * age (`C`, newer first), combined as `0.5·A7 + 0.3·A30 + 0.2·C`.
 *
 * Each factor is **rank-normalised** — `s = (N − rank + 1) / N`, best = 1.0 —
 * rather than used raw. That is the point of the design: a busy project with 900
 * events must not bury a new one with 3, because both can be "the most active
 * thing" in their own right. The rank says *where you sit*, the score says *how
 * much that is worth*.
 *
 * Pure: no I/O, no clock (the caller passes `now`), no SQLite. Counts arrive
 * already aggregated; this file only turns numbers into an order.
 */

import { PROJECT_ORDER_WEIGHTS } from "./constants.mjs";

/**
 * Rank values *descending* and normalise to `(N − rank + 1) / N`.
 *
 * Ties share the best rank among them (standard competition ranking), so two
 * projects with identical activity get identical scores — the honest answer, and
 * one that keeps the result stable under input reordering.
 *
 * @template T @param {T[]} values @param {(a: T, b: T) => number} compare descending comparator
 * @returns {{scores: number[], ranks: number[]}} aligned with `values`
 */
export function normalise(values, compare) {
  const n = values.length;
  if (n === 0) return { scores: [], ranks: [] };
  const ranks = values.map((value) => values.filter((other) => compare(other, value) < 0).length + 1);
  const scores = ranks.map((rank) => (n - rank + 1) / n);
  return { scores, ranks };
}

/** Descending by a numeric field, with `undefined` treated as 0. */
function numericDesc(a, b) {
  return Number(b ?? 0) - Number(a ?? 0);
}

/** Descending by an ISO-8601 string, with a missing value sorting last. */
function stringDesc(a, b) {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return right > left ? 1 : -1;
}

/**
 * Order projects by §4.6.
 *
 * @param {Array<{
 *   id: string, name: string, createdAt?: string|null,
 *   a7?: number, a30?: number, lastActivityAt?: string|null, archivedAt?: string|null,
 * }>} entries
 * @param {{weights?: {a7: number, a30: number, created: number}}} [options]
 * @returns {Array<object>} a new array, ordered, each entry carrying `order`
 */
export function rankProjects(entries, options = {}) {
  const weights = options.weights ?? PROJECT_ORDER_WEIGHTS;
  if (entries.length === 0) return [];

  const a7 = normalise(entries.map((entry) => entry.a7), numericDesc);
  const a30 = normalise(entries.map((entry) => entry.a30), numericDesc);
  const created = normalise(entries.map((entry) => entry.createdAt), stringDesc);

  const scored = entries.map((entry, index) => {
    const scores = { a7: a7.scores[index], a30: a30.scores[index], created: created.scores[index] };
    return {
      entry,
      order: 0,
      lastActivityAt: typeof entry.lastActivityAt === "string" ? entry.lastActivityAt : null,
      archived: entry.archivedAt !== null && entry.archivedAt !== undefined,
      scores,
      ranks: { a7: a7.ranks[index], a30: a30.ranks[index], created: created.ranks[index] },
      total: weights.a7 * scores.a7 + weights.a30 * scores.a30 + weights.created * scores.created,
    };
  });

  scored.sort((left, right) => {
    // Archived projects are fixed to the bottom (§4.6) but keep their relative order.
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    if (right.total !== left.total) return right.total - left.total;
    // ① most recently active, ② project name ascending.
    const activity = stringDesc(left.lastActivityAt, right.lastActivityAt);
    if (activity !== 0) return activity;
    return left.entry.name.localeCompare(right.entry.name);
  });

  for (let i = 0; i < scored.length; i += 1) scored[i].order = i + 1;
  return scored;
}

/**
 * The `order_debug` projection (§4.6): raw factors, per-factor ranks and scores,
 * plus the total — everything needed to reconcile the order by hand.
 *
 * @param {object} item one entry from `rankProjects`
 */
export function orderDebugEntry(item) {
  return {
    id: item.entry.id,
    name: item.entry.name,
    order: item.order,
    total: round(item.total),
    archived: item.archived,
    factors: {
      a7: { raw: Number(item.entry.a7 ?? 0), rank: item.ranks.a7, score: round(item.scores.a7) },
      a30: { raw: Number(item.entry.a30 ?? 0), rank: item.ranks.a30, score: round(item.scores.a30) },
      created: { raw: item.entry.createdAt ?? null, rank: item.ranks.created, score: round(item.scores.created) },
    },
    last_activity_at: item.entry.lastActivityAt ?? null,
  };
}

/** Scores are floats; five decimals is plenty for a debug view and keeps JSON tidy. */
function round(value) {
  return Math.round(value * 100000) / 100000;
}
