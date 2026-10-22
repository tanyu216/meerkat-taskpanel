/**
 * The acceptance baseline and its coverage arithmetic.
 *
 * A card's baseline is a frozen list of criteria (`tasks.acceptance_json`,
 * 0032). A delivery report answers each criterion with one of four statuses
 * (`met`, `partial`, `not_met`, `not_applicable`). This module owns the two
 * pure questions the board asks about that pair:
 *
 *   * **What is the canonical list?** `normalizeAcceptanceList` trims,
 *     de-duplicates and caps a caller-supplied list; the command layer writes
 *     the result once and never rewrites it.
 *   * **Does the report cover it?** `coverageOf` is the gate's arithmetic:
 *     every baseline item must have a matching report item, and no item may
 *     be `partial` or `not_met`. `not_applicable` is a valid answer only with a
 *     note (a verdict, not a shrug).
 *
 * Matching is by **normalised text**, because neither the baseline nor a report
 * carries a stable criterion id. NFKC + whitespace folding + case-folding makes
 * the match tolerant of formatting; it deliberately does not do fuzzy matching.
 * A criterion that was reworded is a different criterion — that is what the
 * immutable baseline is for.
 *
 * Pure: no `node:` specifiers, no clock.
 */

import { ACCEPTANCE_STATUSES } from "./enums.mjs";

/** Statuses that make a delivery incomplete. */
export const BLOCKING_ACCEPTANCE_STATUSES = Object.freeze(["partial", "not_met"]);

/** @param {unknown} status */
export function isBlockingStatus(status) {
  return BLOCKING_ACCEPTANCE_STATUSES.includes(/** @type {string} */ (status));
}

/**
 * Canonical display form: NFKC, one space for every whitespace run, trimmed.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAcceptanceText(value) {
  if (typeof value !== "string") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The match key. Display text keeps its case; the key folds it so "A" and "a"
 * are the same criterion.
 * @param {unknown} value
 * @returns {string}
 */
export function acceptanceKey(value) {
  return normalizeAcceptanceText(value).toLowerCase();
}

/**
 * Normalise a caller-supplied list.
 *
 * Accepts the modern `string[]` and the historical `{text, checked}[]` shape;
 * `checked` is never evidence, only `text` is carried. Non-string, non-object
 * entries are ignored (a `meta` bag is writable and can hold anything). The
 * first display spelling for a key wins.
 *
 * @param {unknown[]} values
 * @param {{maxItems?: number}} [options]
 * @returns {string[]}
 */
export function normalizeAcceptanceList(values, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 60;
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const raw =
      typeof value === "string"
        ? value
        : value !== null && typeof value === "object" && typeof value.text === "string"
          ? value.text
          : null;
    if (raw === null) continue;
    const text = normalizeAcceptanceText(raw);
    if (text === "") continue;
    const key = acceptanceKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Parse a stored `acceptance_json` value. A broken value reads as `[]` (the
 * column is NOT NULL and CHECKed, but a corrupted row must not break a read).
 * @param {unknown} value
 * @returns {string[]}
 */
export function acceptanceFromJson(value) {
  if (Array.isArray(value)) return normalizeAcceptanceList(value, { maxItems: 64 });
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeAcceptanceList(parsed, { maxItems: 64 }) : [];
  } catch {
    return [];
  }
}

/** The severity order used when a report repeats a criterion. */
const STATUS_RANK = Object.freeze({
  met: 0,
  not_applicable: 1,
  partial: 2,
  not_met: 3,
});

/**
 * Merge duplicate report items by key, keeping the worst status and the first
 * non-empty text/note.
 * @param {object[]} reportItems
 */
function mergeReportItems(reportItems) {
  const byKey = new Map();
  for (const item of Array.isArray(reportItems) ? reportItems : []) {
    if (item === null || typeof item !== "object") continue;
    const text = normalizeAcceptanceText(item.text);
    if (text === "") continue;
    const key = acceptanceKey(text);
    const status = ACCEPTANCE_STATUSES.includes(item.status) ? item.status : "not_met";
    const note = typeof item.note === "string" ? item.note.trim() : "";
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, { key, text, status, note });
      continue;
    }
    if ((STATUS_RANK[status] ?? 3) > (STATUS_RANK[prior.status] ?? 3)) prior.status = status;
    if (prior.note === "" && note !== "") prior.note = note;
  }
  return byKey;
}

/**
 * Does `reportItems` cover `baseline`?
 *
 * `extra` items (report answers with no matching baseline criterion) are
 * allowed when they are `met` or a noted `not_applicable`; a blocking extra is
 * still a blocking fact — the report itself says work is unfinished.
 *
 * @param {{baseline?: unknown[], reportItems?: object[], includeExtras?: boolean}} input
 * @returns {{
 *   ok: boolean,
 *   vacuous: boolean,
 *   missing: {key: string, text: string}[],
 *   blocking: {key: string, text: string, status: string}[],
 *   extra: {key: string, text: string, status: string}[],
 * }}
 */
export function coverageOf(input = {}) {
  const baseline = normalizeAcceptanceList(input.baseline ?? [], { maxItems: 64 });
  const includeExtras = input.includeExtras !== false;
  const items = mergeReportItems(input.reportItems ?? []);
  const baselineKeys = new Set(baseline.map((text) => acceptanceKey(text)));

  const missing = [];
  const blocking = [];
  for (const text of baseline) {
    const key = acceptanceKey(text);
    const item = items.get(key);
    if (item === undefined) {
      missing.push({ key, text });
      continue;
    }
    if (isBlockingStatus(item.status)) {
      blocking.push({ key, text, status: item.status });
    } else if (item.status === "not_applicable" && item.note === "") {
      blocking.push({ key, text, status: "not_applicable" });
    }
  }

  const extra = [];
  if (includeExtras) {
    for (const item of items.values()) {
      if (baselineKeys.has(item.key)) continue;
      extra.push({ key: item.key, text: item.text, status: item.status });
      if (isBlockingStatus(item.status) || (item.status === "not_applicable" && item.note === "")) {
        blocking.push({ key: item.key, text: item.text, status: item.status });
      }
    }
  }

  return {
    ok: baseline.length === 0 || (missing.length === 0 && blocking.length === 0),
    vacuous: baseline.length === 0,
    missing,
    blocking,
    extra,
  };
}
