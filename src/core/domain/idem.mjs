/**
 * Idempotency keys for task creation — the *mechanical* backstop.
 *
 * L1 reading: `PROTOCOL §㉙` + `guides/task-interface.md §14`. The key is
 * `<kind> | <assignee> | <source> | <target>` (each field `String(x).trim()`,
 * joined with a single space-padded pipe, exactly as the md base derives it so
 * the two bases agree on the same card). `source` is `review_of`, else `parent`,
 * else `""` — a review card is identified by what it reviews.
 *
 * ## Scope, and what this is *not*
 *
 * The **main gate is an LLM semantic check, not this key.** Before creating a
 * card the creator (Elon/LLM) must read the existing non-terminal cards —
 * `taskctl issue list` — and decide whether the *intent* is already covered;
 * if it is, do not create: reuse the existing card. The mechanical key below
 * cannot see intent, so it only catches the mechanical duplicate (two cards
 * derived from the same kind/assignee/source/target), and it deliberately does
 * **not** look at the title. Treat a key match as "the same card re-submitted",
 * not as proof that no conceptual duplicate exists.
 *
 * On a match the create is *refused and the existing task returned*: the caller
 * gets the existing `id`/`identifier` (the answer), no row is written and no
 * activity is recorded. Terminal cards (`done`/`canceled`) release the key.
 * `--allow-dup` writes `NULL` and bypasses the guard entirely.
 *
 * Pure: no `node:` specifiers — `domain/` stays I/O free
 * (`test/core/domain/purity.test.mjs`).
 */

import { isTerminalStatus } from "./status.mjs";

/**
 * Is this status still holding its idempotency key? Non-terminal = active.
 * @param {unknown} status
 */
export function isIdemActive(status) {
  return !isTerminalStatus(status);
}

/**
 * The `source` slot of the key: `review_of` wins, then `parent`, then empty.
 * @param {{reviewOf?: unknown, parent?: unknown}} [input]
 * @returns {string}
 */
export function idemSource({ reviewOf, parent } = {}) {
  const review = normalizeIdem(reviewOf);
  if (review !== null) return review;
  const parentId = normalizeIdem(parent);
  if (parentId !== null) return parentId;
  return "";
}

/**
 * Build the mechanical key. Every field is trimmed; missing fields keep their
 * slot so the columns never shift.
 *
 * @param {{kind?: unknown, assignee?: unknown, source?: unknown, target?: unknown}} [parts]
 * @returns {string}
 */
export function idemKey({ kind = "task", assignee = "", source = "", target = "" } = {}) {
  return `${String(kind).trim()} | ${String(assignee).trim()} | ${String(source).trim()} | ${String(target).trim()}`;
}

/**
 * A blank/absent value is "no key" (`null`), anything else is its trimmed form.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeIdem(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Does the payload carry something that *distinguishes* this card from every
 * other? Without one, the derived key would be the degenerate
 * `task |  |  | ` and every generic card would collide — so the guard stays off
 * for those, and two ordinary cards can both be created.
 *
 * @param {{assignee?: unknown, source?: unknown, target?: unknown}} [fields]
 * @returns {boolean}
 */
export function hasIdemDiscriminator({ assignee = "", source = "", target = "" } = {}) {
  return normalizeIdem(assignee) !== null || normalizeIdem(source) !== null || normalizeIdem(target) !== null;
}
