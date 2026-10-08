/**
 * Dictionary entities: assignees and reporters (ARCHITECTURE §4.4).
 *
 * The list is *grown by use* — there is no management API anywhere in core, and
 * this module exports no add/remove/rename. A task write resolves the free-text
 * name it was given against what already exists:
 *
 *   1. normalise  (`normalizeName`: NFKC, case-fold, collapse whitespace, trim)
 *   2. exact hit  → reuse (even with `forceCreate` — forcing only bypasses fuzzy)
 *   3. fuzzy hit  → exactly one candidate ⇒ reuse; several ⇒ refuse and list them
 *                   (never guess); none ⇒ create
 *   4. `forceCreate` skips 3 and creates
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { DICT_KINDS, DICTIONARY_KINDS } from "./enums.mjs";

/** Fuzzy matching is prefix/substring on the normalised name. */
export function normalizeName(raw) {
  if (typeof raw !== "string") {
    throw new DomainError("DICTIONARY_INVALID", {
      message: "a dictionary name must be a string",
      details: { field: "name", received: typeof raw },
    });
  }
  const normalized = raw
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized === "") {
    throw new DomainError("DICTIONARY_INVALID", {
      message: "a dictionary name must not be empty",
      details: { field: "name", received: raw },
    });
  }
  return normalized;
}

/** @param {unknown} value */
export function isDictionaryKind(value) {
  return DICTIONARY_KINDS.includes(/** @type {string} */ (value));
}

/**
 * Resolve a raw name against the existing entries of one kind.
 *
 * @param {{id: string, kind: string, displayName: string, normalizedName: string}[]} existing
 * @param {string} raw
 * @param {{kind: "agent"|"human", forceCreate?: boolean}} options
 * @returns {{action: "reuse"|"create", entry?: object, displayName: string, normalizedName: string, kind: string}}
 * @throws {DomainError} DICTIONARY_AMBIGUOUS when several entries match
 */
export function resolveDictionaryEntry(existing, raw, options) {
  const { kind, forceCreate = false } = options;
  if (!DICT_KINDS.includes(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `dictionary kind must be one of ${DICT_KINDS.join(", ")}`,
      details: { field: "kind", received: kind, allowed: DICT_KINDS },
    });
  }
  const normalizedName = normalizeName(raw);
  const displayName = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const sameKind = (Array.isArray(existing) ? existing : []).filter((entry) => entry.kind === kind);

  const exact = sameKind.filter((entry) => normalizeName(entry.displayName) === normalizedName);
  if (exact.length === 1) {
    // On reuse the *dictionary's* spelling wins: that is what makes the list a
    // dictionary rather than a log of whatever people typed.
    return { action: "reuse", entry: exact[0], displayName: exact[0].displayName, normalizedName, kind };
  }
  if (exact.length > 1) {
    // Two rows with the same normalised name cannot exist (UNIQUE(normalized_name, kind))
    // — unless the caller handed us unsaved rows. Refuse rather than pick one.
    throw ambiguous(raw, exact);
  }

  const fuzzy = sameKind.filter((entry) => normalizeName(entry.displayName).includes(normalizedName));
  if (fuzzy.length === 1) {
    return { action: "reuse", entry: fuzzy[0], displayName: fuzzy[0].displayName, normalizedName, kind };
  }
  if (fuzzy.length > 1 && !forceCreate) {
    throw ambiguous(raw, fuzzy);
  }

  return { action: "create", displayName, normalizedName, kind };
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
  kind: "kind",
  display_name: "displayName",
  normalized_name: "normalizedName",
  platform: "platform",
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
