/**
 * `key` → sentence, and `error code` → key (T-20261014-152924 ④).
 *
 * Two jobs, both pure — no Vue, so `node --test` asserts the same sentences the
 * bundle renders (`test/web/error-text.test.mjs`):
 *
 *   1. `resolveText` is **the one lookup**: the implementation's own table
 *      (`extra.mjs`) first, then the frozen prototype catalogue. `i18n/index.js`
 *      binds it to a reactive language ref and nothing else re-implements it.
 *   2. `errorTextKey` is **the one place a failure code becomes words** — from
 *      the code, and from `details` for the one code that covers more than one
 *      refusal shape (`SHAPE_TEXT_KEYS`).
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
  // T-20261014-212017-4 — the four refusals the drawer's new edit surfaces can
  // actually provoke: an illegal move, a dependency loop, and the two file
  // verdicts. `SELF_REFERENCE` shares the loop's sentence: "a card cannot wait
  // on itself" is the one-node case of exactly that statement.
  //
  // `RELATION_CYCLE` is the one code in this table that covers more than one
  // *shape*; the shape that is **not** a loop answers from `SHAPE_TEXT_KEYS`
  // below, and this entry is what every other shape (and a wire with no
  // `details` at all) falls back to.
  RELATION_CYCLE: "error.relationCycle",
  SELF_REFERENCE: "error.relationCycle",
  CROSS_PROJECT_RELATION: "error.relationCrossProject",
  ATTACHMENT_TOO_LARGE: "error.attachTooLarge",
  ATTACHMENT_TYPE_UNSUPPORTED: "error.attachType",
});

/**
 * A code whose sentence depends on the failure's *shape*, not on the code alone.
 *
 * `RELATION_CYCLE` covers three refusals — a `blocks` loop, a parent-chain cycle,
 * and an edge joining an ancestor and a descendant of the parent chain — and the
 * third is **not** a loop at all: no edge closes a cycle and nothing waits on
 * itself, so the loop's sentence is simply wrong for it.
 *
 * That shape is already distinct on the wire. `domain/relation.mjs`
 * (`assertBlockEdgeAllowed`) sets `details.chain = "ancestor"` for it, and
 * `test/contract/invariants.test.mjs` asserts the chain reason is
 * "distinguishable from a loop". This table is where that distinction reaches
 * the screen: the mapper reads `details` — the machine-readable half of an
 * error, never its prose — before it reads the flat code table.
 *
 * A rule names both halves of the pair on purpose. `chain` on some other code,
 * or `ancestor` on another field, is not this refusal; a rule only fires when
 * its own code carries its own field with its own value. A code may hold more
 * than one rule (first match wins), which is why this is a list and not a map.
 *
 * @type {{code: string, field: string, value: string, key: string}[]}
 */
export const SHAPE_TEXT_KEYS = Object.freeze([
  Object.freeze({
    code: "RELATION_CYCLE",
    field: "chain",
    value: "ancestor",
    key: "error.relationAncestor",
  }),
]);

/**
 * Every sentence key this vocabulary can render through — both tables plus the
 * fallback — so a completeness sweep covers the shape entries too.
 */
export const ERROR_VOCABULARY_KEYS = Object.freeze([
  ...Object.values(ERROR_TEXT_KEYS),
  ...SHAPE_TEXT_KEYS.map((rule) => rule.key),
]);

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
 * The shape a code's `details` names, or `undefined` when it names none.
 *
 * @param {string} code
 * @param {unknown} details
 * @returns {string|undefined}
 */
function shapeKey(code, details) {
  const fields = typeof details === "object" && details !== null ? details : undefined;
  for (const rule of SHAPE_TEXT_KEYS) {
    if (rule.code === code && fields?.[rule.field] === rule.value) return rule.key;
  }
  return undefined;
}

/**
 * The key an error renders through. Anything without a sentence of its own —
 * unknown codes, internal codes, a thrown value that is not an error at all —
 * resolves to `error.generic`; a raw `message` is never a fallback.
 *
 * A code that covers more than one shape (`SHAPE_TEXT_KEYS`) answers from its
 * `details` first: `RELATION_CYCLE` with `details.chain = "ancestor"` is not a
 * loop, and must not read as one. Everything else — the same code without that
 * field, a wire from a server older than the field, a thrown value with no
 * `details` at all — takes the flat code table exactly as before.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorTextKey(err) {
  const error = typeof err === "object" && err !== null ? err : undefined;
  const code = error?.code;
  if (typeof code !== "string") return GENERIC_ERROR_KEY;
  const shaped = shapeKey(code, error?.details);
  if (shaped !== undefined) return shaped;
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
