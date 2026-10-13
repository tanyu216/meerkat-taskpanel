/**
 * The `blocked_reason` card field — its vocabulary, and the one place that
 * decides whether a value may be written.
 *
 * `status.mjs` owns the *transition* into and out of `blocked`;
 * `repositories/tasks.mjs#moveCas` owns the *write* (set on entry, cleared on
 * exit, in the same UPDATE as the status). This module owns the value itself:
 * what may be written, and what "no reason" is spelled as.
 *
 * Two rules, both deliberate:
 *
 *   1. **Absent is legal and is not a member of the list.** `null`/`""`/missing
 *      normalizes to `null`, which is the column's unset state. A card blocked
 *      without a reason is valid — the inspector treats it as `clarify` — and
 *      the exporter omits the key entirely for it, so a card that never carried
 *      a reason stays byte-identical. `unknown` in the vocabulary is therefore
 *      *not* the spelling of "absent": it is a writer saying "there is a block
 *      and I cannot classify it", which is a different statement.
 *
 *   2. **A value that is not a literal is refused, not coerced.** No folding to
 *      `unknown`, no case-normalisation to the nearest literal — a caller bug
 *      must surface as one. This is the same discipline `parsePriority` applies
 *      to `priority`, and it is what keeps a legal value byte-stable on the
 *      round trip: the stored word is the written word.
 *
 *      **Surrounding whitespace is the one exception, and it is deliberate.**
 *      `"  dependency  "` normalises to `dependency` — the value is trimmed
 *      before it is tested, exactly as every other card scalar is (the
 *      frontmatter reader trims a bare value, so an untrimmed one can only
 *      arrive quoted). Space around a word is not a second spelling of it, and
 *      refusing the card over it would be pedantry that loses work; a *word*
 *      that differs — case included, `Dependency` is not `dependency` — is still
 *      refused. The consequence on the round trip is stated where it is
 *      observable: an import of `blocked_reason: "  dependency  "` exports
 *      `blocked_reason: dependency`, because the column stores what the domain
 *      normalised, and the trim is not remembered anywhere.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { BLOCKED_REASONS } from "./enums.mjs";

/** @param {unknown} value */
export function isBlockedReason(value) {
  return BLOCKED_REASONS.includes(/** @type {string} */ (value));
}

/**
 * Normalise a raw `blocked_reason` value.
 *
 * @param {unknown} value
 * @param {string} [field] the name to report the field under (the markdown edge
 *   reads a card's frontmatter, the domain reads a payload — the offending field
 *   should be named the way the caller wrote it)
 * @returns {string|null} the literal, or `null` when the caller supplied nothing
 */
export function normalizeBlockedReason(value, field = "blocked_reason") {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be a string, got ${typeof value}`,
      details: { field, received: typeof value, allowed: BLOCKED_REASONS },
    });
  }
  const text = value.trim();
  if (text === "") return null;
  if (!isBlockedReason(text)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown ${field} ${JSON.stringify(value)}`,
      details: { field, received: value, allowed: BLOCKED_REASONS },
      hint: {
        fix: `pick one of ${BLOCKED_REASONS.join("|")}, or omit it — a blocked card without a reason is legal`,
      },
    });
  }
  return text;
}
