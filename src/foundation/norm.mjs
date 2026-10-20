/**
 * `norm` — the single normalisation used for every dictionary-ish identity:
 * **labels, assignees and reporters** alike (§4.4, Terry 2026-10-09 ruling F7).
 *
 *     norm = NFKC  →  remove ALL whitespace characters  →  Unicode case fold
 *
 * so `bug` ≡ `Bug` ≡ `B u g` ≡ `"  bug  "`, and `code review` ≡ `codereview`.
 * Whitespace *inside* a name is removed, not collapsed: the key is an identity,
 * not a display string.
 *
 * This module is the one place the rule is written down. `core/domain/dictionary`
 * re-exports it as `normalizeName` (the historical name, kept because the
 * `assignees`/`reporters` column is `normalized_name` — that column **is** `norm`;
 * see ARCHITECTURE §4.1/§4.4) and `core/domain/labels` builds on it too.
 *
 * Case folding is approximated with `String.prototype.toLowerCase()`, like every
 * other JS surface: it is exact for ASCII and the common multilingual cases, and
 * is not a full Unicode case-fold (`ß`, `İ` remain the documented edge).
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "./errors.mjs";

/**
 * @param {unknown} raw
 * @returns {string} the normalised key
 * @throws {DomainError} `DICTIONARY_INVALID` for a non-string or a name that
 *   normalises to nothing (empty, or whitespace only)
 */
export function norm(raw) {
  if (typeof raw !== "string") {
    throw new DomainError("DICTIONARY_INVALID", {
      message: "a dictionary name must be a string",
      details: { field: "name", received: typeof raw },
    });
  }
  const normalized = raw
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (normalized === "") {
    throw new DomainError("DICTIONARY_INVALID", {
      message: "a dictionary name must not be empty",
      details: { field: "name", received: raw },
    });
  }
  return normalized;
}
