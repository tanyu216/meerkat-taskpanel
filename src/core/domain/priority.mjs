/**
 * Priority ordering — pure helpers over the four canonical priorities.
 *
 * The board sorts most-urgent-first; `comparePriority` follows that convention
 * so `[].sort(comparePriority)` needs no extra reversal. Storage keeps the
 * literal string; the rank only exists for sorting and rollups.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { PRIORITIES, PRIORITY } from "./enums.mjs";

/** Importance rank — higher is more urgent. */
export const PRIORITY_RANK = Object.freeze({
  [PRIORITY.LOW]: 0,
  [PRIORITY.MEDIUM]: 1,
  [PRIORITY.HIGH]: 2,
  [PRIORITY.URGENT]: 3,
});

/** The default when a caller omits priority. */
export const DEFAULT_PRIORITY = PRIORITY.MEDIUM;

/** @param {unknown} value */
export function isPriority(value) {
  return PRIORITIES.includes(/** @type {string} */ (value));
}

/**
 * Normalise a raw priority value.
 *
 * @param {unknown} value
 * @param {{fallback?: string|null}} [options] `fallback` is returned for
 *   null/undefined/empty input; pass `null` to demand an explicit value.
 * @returns {string|null}
 */
export function parsePriority(value, options = {}) {
  const { fallback = DEFAULT_PRIORITY } = options;
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `priority must be a string, got ${typeof value}`,
      details: { field: "priority", received: typeof value, allowed: PRIORITIES },
    });
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (!isPriority(normalized)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown priority ${JSON.stringify(value)}`,
      details: { field: "priority", received: value, allowed: PRIORITIES },
    });
  }
  return normalized;
}

/**
 * Sort comparator: most urgent first, ties broken by the `a`/`b` string order
 * so sorting stays stable across runs.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePriority(a, b) {
  const ra = PRIORITY_RANK[/** @type {keyof typeof PRIORITY_RANK} */ (a)] ?? PRIORITY_RANK.medium;
  const rb = PRIORITY_RANK[/** @type {keyof typeof PRIORITY_RANK} */ (b)] ?? PRIORITY_RANK.medium;
  if (ra !== rb) return rb - ra;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank for a value, defaulting to `medium` for anything unknown (rollups should
 * not explode on a bad row).
 * @param {unknown} value
 */
export function priorityRank(value) {
  return PRIORITY_RANK[/** @type {keyof typeof PRIORITY_RANK} */ (value)] ?? PRIORITY_RANK.medium;
}
