/**
 * Labels — the registry entity (§4.1 / §4.4, rulings F2/F3/F5).
 *
 * A label is the same *kind* of thing as an assignee or a reporter: it grows by
 * use, has no management surface, and matches on the shared `norm` (so `Bug`,
 * `bug`, `B u g` and `"  bug  "` are one label). What it adds is a colour, a use
 * count and, eventually, an end of life.
 *
 * This module is pure — the value logic only. Registration and the GC live in
 * `core/commands/labels.mjs`; the SQL lives in `core/storage/repositories`.
 *
 * Pure: no `node:` specifiers.
 */

import { LABEL_TTL_DAYS_DEFAULT } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { norm } from "../../shared/norm.mjs";

/**
 * The identity key of a label: the shared `norm`. Re-exported under a
 * label-specific name so call sites read as what they mean.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeLabelName(raw) {
  return norm(raw);
}

/**
 * Which palette colour a *new* label takes (F2-A).
 *
 * Contract: the first palette colour with no active label on it; once every
 * colour is taken, the least-used one (ties broken by palette order). It is
 * deterministic, so the same board state always yields the same colour, and it
 * is computed once per label — a colour is never recomputed or shuffled.
 *
 * @param {string[]} activeColors the colours of the project's non-archived labels
 * @param {readonly string[]} palette
 * @returns {string}
 */
export function nextColor(activeColors, palette) {
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "nextColor needs a non-empty palette",
      details: { field: "palette" },
    });
  }
  const counts = new Map(palette.map((color) => [color, 0]));
  for (const color of Array.isArray(activeColors) ? activeColors : []) {
    if (counts.has(color)) counts.set(color, counts.get(color) + 1);
  }
  for (const color of palette) {
    if (counts.get(color) === 0) return color;
  }
  // Every colour is in use: take the least-used one, first in palette order.
  let best = palette[0];
  for (const color of palette) {
    if (counts.get(color) < counts.get(best)) best = color;
  }
  return best;
}

/**
 * The display form of a label name: NFKC, whitespace runs collapsed to a single
 * space, trimmed. Unlike the identity key (`norm`) it keeps word spacing —
 * `code review` stays readable — and it is only applied when a label is first
 * created: after that, first-seen wins and the stored spelling is reused.
 *
 * @param {string} raw
 * @returns {string}
 */
export function labelDisplayName(raw) {
  return String(raw).normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** `ttlDays` worth of milliseconds, as a number. @param {number} ttlDays */
function ttlMs(ttlDays) {
  return Number(ttlDays) * 24 * 60 * 60 * 1000;
}

/**
 * Is this label eligible for collection?
 *
 * Three conditions, all necessary (F5-B):
 *   * nothing references it (`useCount === 0` — the counter),
 *   * it is not already archived,
 *   * its `lastSeenAt` is older than the TTL.
 *
 * The *second* reference check (a live scan of task labels) is deliberately not
 * here: it needs the database, and ruling F3-B requires the GC to reconcile the
 * counter against that scan before archiving. This predicate is only the cheap,
 * pure pre-filter.
 *
 * @param {{useCount: number, archivedAt: string|null, lastSeenAt: string}} label
 * @param {{now: string, ttlDays?: number}} options
 * @returns {boolean}
 */
export function isCollectable(label, options) {
  const { now, ttlDays = LABEL_TTL_DAYS_DEFAULT } = options;
  if (label.archivedAt !== null && label.archivedAt !== undefined) return false;
  if (Number(label.useCount) !== 0) return false;
  const cutoff = new Date(now).getTime() - ttlMs(ttlDays);
  const seen = new Date(label.lastSeenAt).getTime();
  return Number.isFinite(seen) && seen <= cutoff;
}

/** Every column `labels` has, in a stable order (DTO ⇄ row translation). */
export const LABEL_COLUMNS = Object.freeze([
  "id",
  "project_id",
  "norm",
  "display_name",
  "color",
  "use_count",
  "first_seen_at",
  "last_seen_at",
  "archived_at",
]);

const CAMEL = Object.freeze({
  id: "id",
  project_id: "projectId",
  norm: "norm",
  display_name: "displayName",
  color: "color",
  use_count: "useCount",
  first_seen_at: "firstSeenAt",
  last_seen_at: "lastSeenAt",
  archived_at: "archivedAt",
});

/**
 * Row → DTO.
 * @param {object} row
 */
export function labelFromRow(row) {
  if (row === null || row === undefined) return null;
  const label = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    label[field] = row[column] === undefined ? null : row[column];
  }
  label.useCount = Number(label.useCount ?? 0);
  return label;
}

/**
 * DTO → row, restricted to `fields` (camelCase), or all of them.
 * @param {object} label
 * @param {string[]} [fields]
 */
export function labelToRow(label, fields = Object.keys(CAMEL).map((column) => CAMEL[column])) {
  const inverse = new Map(Object.entries(CAMEL).map(([column, field]) => [field, column]));
  const row = {};
  for (const field of fields) {
    const column = inverse.get(field);
    if (column === undefined) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `labelToRow: unknown field ${JSON.stringify(field)}`,
        details: { field },
      });
    }
    row[column] = label[field] === undefined ? null : label[field];
  }
  return row;
}
