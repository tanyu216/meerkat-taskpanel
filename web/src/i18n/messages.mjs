/**
 * `key` → sentence, and `error code` → key (T-20261014-152924 ④).
 *
 * Two jobs, both pure — no Vue, so `node --test` asserts the same sentences the
 * bundle renders (`test/web/error-text.test.mjs`):
 *
 *   1. `resolveText` is **the one lookup**: the implementation's own table
 *      (`extra.mjs`) first, then the frozen prototype catalogue. `i18n/index.js`
 *      binds it to a reactive language ref and nothing else re-implements it.
 *   2. `errorTextKey` is **the one place a failure code becomes words**.
 *
 * Why a code, and never a message: the `message` half of an error is written for
 * whoever wrote the failing code — for a refused write that means the storage
 * engine's own words (`CHECK constraint failed: claimed_by IS NULL OR status <>
 * 'backlog'`, the string that used to appear on a drag). A `code` is the half a
 * client is allowed to branch on, so it is the half the board reads. A code with
 * no sentence here — an internal one such as `EXECUTION_STATE_CORRUPT`, a
 * validation code, or one a newer server invents — falls back to
 * `error.generic`, which is readable in both languages and says nothing it
 * cannot back up.
 */

import { DEFAULT_LANGUAGE, translate } from "./catalogue.mjs";
import { EXTRA } from "./extra.mjs";

/** The fallback every unmapped code resolves to (both languages carry it). */
export const GENERIC_ERROR_KEY = "error.generic";

/**
 * Failure code → the sentence the board shows for it.
 *
 * Only codes whose meaning a reader of the board can act on appear here. The
 * `toast.*` entries are the ones M6b already authored for the move path — they
 * are reused rather than re-worded, so one refusal has one sentence wherever it
 * is reported.
 */
export const ERROR_TEXT_KEYS = Object.freeze({
  // A refused move, and the two reasons the reader can repair by hand.
  INVALID_TRANSITION: "toast.moveFailed",
  TERMINAL_STATE: "toast.moveFailed",
  REPORT_REQUIRED: "toast.reportRequired",
  VERSION_CONFLICT: "toast.moveConflict",
  // The routing lock and the two states a claim can be refused from.
  not_assignee: "error.notAssignee",
  EXECUTION_ACTIVE: "error.executionActive",
  // The `tasks` CHECK: a backlog card may not hold a claim. Defensive — the
  // service releases the claim on the way out of the work cycle
  // (`src/core/domain/status.mjs#CLAIM_HOLDING_STATUSES`), so this is what a
  // foreign writer or an import would produce.
  CLAIM_ON_BACKLOG: "error.claimOnBacklog",
  // Transport and availability.
  NOT_FOUND: "error.notFound",
  DB_BUSY: "error.busy",
  NETWORK: "error.network",
});

/** The `%s`-carrying keys above — a sentence may name the card it is about. */
const TAKES_REF = new Set([
  "toast.moveFailed",
  "toast.reportRequired",
  "toast.moveConflict",
  "error.notFound",
  "error.notAssignee",
  "error.executionActive",
  "error.claimOnBacklog",
]);

/** The implementation's own table for a language, falling back to the default. */
function extraTable(language) {
  return EXTRA[language] ?? EXTRA[DEFAULT_LANGUAGE];
}

/**
 * Resolve a key in a given language: the implementation's own strings first,
 * then the frozen prototype catalogue.
 *
 * @param {"en"|"zh"|string} language
 * @param {string} key
 * @param {unknown[]} [args] positional `%s` values
 * @returns {string}
 */
export function resolveText(language, key, args = []) {
  const table = extraTable(language);
  if (Object.prototype.hasOwnProperty.call(table, key)) {
    let out = table[key];
    for (const arg of args) if (arg !== undefined && arg !== null) out = out.replace("%s", String(arg));
    return out;
  }
  return translate(language, key, ...args);
}

/**
 * The key an error renders through. Anything without a sentence of its own —
 * unknown codes, internal codes, a thrown value that is not an error at all —
 * resolves to `error.generic`; a raw `message` is never a fallback.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorTextKey(err) {
  const code = typeof err === "object" && err !== null ? err.code : undefined;
  if (typeof code !== "string") return GENERIC_ERROR_KEY;
  return Object.prototype.hasOwnProperty.call(ERROR_TEXT_KEYS, code)
    ? ERROR_TEXT_KEYS[code]
    : GENERIC_ERROR_KEY;
}

/**
 * The sentence for an error, in one language. Pure, so a test can read both
 * languages without a browser; the app calls it through `t()` (reactive).
 *
 * @param {"en"|"zh"|string} language
 * @param {unknown} err
 * @param {unknown[]} [args] positional `%s` values (typically the card's ref)
 * @returns {string}
 */
export function errorText(language, err, args = []) {
  const key = errorTextKey(err);
  // A sentence that does not name a card must not be handed one: the `%s` is
  // filled only for the keys that carry a placeholder.
  return resolveText(language, key, TAKES_REF.has(key) ? args : []);
}
