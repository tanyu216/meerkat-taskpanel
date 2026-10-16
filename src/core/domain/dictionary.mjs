/**
 * Dictionary entities: the actors a card can name (ARCHITECTURE §4.4).
 *
 * Since `0019` there is one actor table (`actors`); `assignee` and `reporter` are
 * **roles** — the `tasks` column a task fills — not separate dictionaries. The
 * list is *grown by use*: there is no management API anywhere in core, and this
 * module exports no add/remove/rename. A task write resolves the free-text name
 * it was given against what already exists:
 *
 *   1. normalise  (`normalizeName` = the shared `norm`: NFKC, case-fold,
 *                   remove ALL whitespace)
 *   2. exact hit  → reuse (even with `forceCreate` — forcing only bypasses fuzzy)
 *   3. fuzzy hit  → exactly one candidate ⇒ reuse; several ⇒ refuse and list them
 *                   (never guess); none ⇒ create
 *   4. `forceCreate` skips 3 and creates
 *
 * `normalizeName` is a re-export of `src/shared/norm.mjs#norm`, the single source
 * of truth for labels / assignees / reporters alike. The name is kept because
 * `actors`' column is `normalized_name` — that column **is** `norm`.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { norm } from "../../shared/norm.mjs";
import { DICTIONARY_KINDS, isActorKind } from "./enums.mjs";

/**
 * Fuzzy matching is prefix/substring on the normalised name.
 *
 * Ruling F7 (2026-10-09) changed this from "collapse whitespace" to "remove ALL
 * whitespace": `"B u g"` and `bug` are now the same key, and so are
 * `code review` and `codereview`. `src/shared/norm.mjs` holds the definition.
 */
export const normalizeName = norm;

/** @param {unknown} value */
export function isDictionaryKind(value) {
  return DICTIONARY_KINDS.includes(/** @type {string} */ (value));
}

/**
 * Resolve a raw name against **every** existing entry.
 *
 * Since `0019` a person is one row (`UNIQUE(normalized_name)`), and since `0023`
 * that row holds **no kind**: a kind describes an act (which platform made this
 * claim, wrote this comment), and one row per person cannot hold it. So this
 * resolves a *name* and nothing else — the caller keeps the kind it is recording
 * on its own reference.
 *
 * @param {{id: string, displayName: string, normalizedName: string}[]} existing
 * @param {string} raw
 * @param {{forceCreate?: boolean}} options
 * @returns {{action: "reuse"|"create", entry?: object, displayName: string, normalizedName: string}}
 * @throws {DomainError} DICTIONARY_AMBIGUOUS when several entries match
 */
export function resolveDictionaryEntry(existing, raw, options) {
  const { forceCreate = false } = options;
  const normalizedName = normalizeName(raw);
  const displayName = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const pool = Array.isArray(existing) ? existing : [];

  const exact = pool.filter((entry) => normalizeName(entry.displayName) === normalizedName);
  if (exact.length === 1) {
    // On reuse the *dictionary's* spelling wins: that is what makes the list a
    // dictionary rather than a log of whatever people typed.
    return { action: "reuse", entry: exact[0], displayName: exact[0].displayName, normalizedName };
  }
  if (exact.length > 1) {
    // Two rows with the same normalised name cannot exist (UNIQUE(normalized_name))
    // — unless the caller handed us unsaved rows. Refuse rather than pick one.
    throw ambiguous(raw, exact);
  }

  const fuzzy = pool.filter((entry) => normalizeName(entry.displayName).includes(normalizedName));
  if (fuzzy.length === 1) {
    // On reuse the verdict describes the *existing* entry — including its
    // normalised name. Returning the caller's spelling here looks harmless and
    // is not: `dictionary.upsert` keys on `normalized_name`, so
    // `--assignee linu` (a unique prefix of `linus`) would miss the row it just
    // matched and insert a second one. M2's `issue create --assignee <text>` is
    // what surfaced it; `test/core/domain/dictionary.test.mjs` pins it.
    return {
      action: "reuse",
      entry: fuzzy[0],
      displayName: fuzzy[0].displayName,
      normalizedName: fuzzy[0].normalizedName ?? normalizeName(fuzzy[0].displayName),
    };
  }
  if (fuzzy.length > 1 && !forceCreate) {
    throw ambiguous(raw, fuzzy);
  }

  return { action: "create", displayName, normalizedName };
}

/** @returns {DomainError} */
function ambiguous(raw, candidates) {
  return new DomainError("DICTIONARY_AMBIGUOUS", {
    message: `${JSON.stringify(raw)} matches ${candidates.length} dictionary entries; be exact or pass --force-create`,
    details: {
      field: "name",
      received: raw,
      candidates: candidates.map((entry) => ({ id: entry.id, displayName: entry.displayName })),
    },
    hint: { fix: "use an exact display name, --force-create, or the entry id" },
  });
}

const CAMEL = {
  id: "id",
  // **Not a column.** `actors` holds no kind (since `0023`): a kind describes an
  // act, and this table is one row per person. The registry *read* aliases this
  // name onto an aggregate over the references that recorded one
  // (`repositories/dictionary.mjs#AGGREGATED_KIND`), so the DTO carries the field
  // and a plain row read reports `null` — "not recorded" — for it.
  kind: "kind",
  display_name: "displayName",
  // `normalized_name` is the historical column name for `norm` (F4-A): the value
  // it holds is exactly `src/shared/norm.mjs#norm`, so a label and an assignee
  // with the same spelling share one identity rule.
  normalized_name: "normalizedName",
  first_seen_at: "firstSeenAt",
  last_seen_at: "lastSeenAt",
  use_count: "useCount",
};

/** @param {object} row */
export function dictionaryEntryFromRow(row) {
  if (row === null || row === undefined) return null;
  const entry = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    entry[field] = row[column] === undefined ? null : row[column];
  }
  return entry;
}

/** @param {object} entry */
export function dictionaryEntryToRow(entry) {
  const inverse = new Map(Object.entries(CAMEL).map(([column, field]) => [field, column]));
  const row = {};
  for (const [field, value] of Object.entries(entry)) {
    const column = inverse.get(field);
    if (column !== undefined) row[column] = value;
  }
  return row;
}
