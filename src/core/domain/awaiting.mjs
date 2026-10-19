/**
 * The `awaiting` state's own rules (M1 · design §2).
 *
 * `status.mjs` owns the *transition* (`in_progress → awaiting` is the only
 * entry; `awaiting → in_progress` the only way back into the work). This module
 * owns the three things that sit on either side of it:
 *
 *   1. **The entry reason is an enumeration, never free text** (§2.1). The
 *      vocabulary is `E1..E5` and `assertAwaitingReason` is the one place that
 *      decides whether a value is one of them.
 *
 *   2. **The payload is the triggering human comment** (§2.2) — *read*, never
 *      stored twice. `payloadOf` is the single derivation of "what is this card
 *      waiting on", so the badge, the view and any patrol scan cannot disagree
 *      about it.
 *
 *   3. **Resume is human-only and idempotent** (§2.3, and the card's D/F2).
 *      `resumeDecision` answers "does this card's `awaiting` episode end, and
 *      on which comment?" from a *cursor* the caller supplies, so replaying the
 *      same read twice yields the same answer and the same next cursor. A
 *      comment written by an agent never resumes the card — the
 *      `author_kind === "human"` test is the whole point and is explicit rather
 *      than implied.
 *
 * What this module deliberately does **not** do: persist anything, and take a
 * lock. The cursor is the loop's own watermark (design §2.3: "the loop cursor
 * `?after=<revision>` … the 'already consumed' test persisted"); this is the
 * pure decision half, matching `shared/scheduling.mjs`'s split between "what to
 * do" and "doing it". The write it leads to — `awaiting → in_progress` — goes
 * through the existing `moveStatus` CAS, so no new concurrency judgement is
 * introduced (card D: "复用既有 CAS … 不得新造并发判据").
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { AWAITING_REASONS, STATUS } from "./enums.mjs";

export { AWAITING_REASONS };

/** @param {unknown} value */
export function isAwaitingReason(value) {
  return AWAITING_REASONS.includes(/** @type {string} */ (value));
}

/**
 * Assert that a value is a usable entry reason.
 *
 * `null`/`""`/`undefined` is refused: entering `awaiting` must say *which*
 * category of question it is, and an unlabelled card is a black box (§2.1:
 * "Entry is never payload-less").
 *
 * @param {unknown} value
 * @returns {string} the reason, for chaining
 */
export function assertAwaitingReason(value) {
  if (typeof value === "string" && isAwaitingReason(value)) return value;
  throw new DomainError("VALIDATION_FAILED", {
    message: `awaiting needs a reason code (one of ${AWAITING_REASONS.join(", ")}), got ${JSON.stringify(value)}`,
    details: { field: "awaiting_reason", received: value, allowed: AWAITING_REASONS },
    hint: { fix: `pick one of ${AWAITING_REASONS.join("|")} — the reason stays an attribute, the question is the comment` },
  });
}

/**
 * Does a card carry the payload its `awaiting` state promises?
 *
 * The payload **is** the human comment that triggered the entry (§2.2), so a
 * card whose `awaiting_reason` is set but whose comment history holds no human
 * comment is a defect, not an empty state — the view renders "nothing to show"
 * as a bug, never as silence.
 *
 * @param {{authorKind?: unknown}} [comment]
 * @returns {boolean}
 */
export function isHumanComment(comment) {
  return comment?.authorKind === "human";
}

/**
 * The comment that `awaiting` is showing, or `null`.
 *
 * Reads only — "the newest human comment on the card". Which comment that is
 * belongs to the caller (`repos.comments.list({ author_kind: "human" })`), so
 * this stays a pure projection.
 *
 * @param {{comments?: object[]}} input
 * @returns {object|null}
 */
export function payloadOf(input = {}) {
  const comments = Array.isArray(input.comments) ? input.comments : [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (isHumanComment(comments[i])) return comments[i];
  }
  return null;
}

/**
 * The "first sentence" of a payload comment — the text up to the first
 * sentence-final punctuation (`。．.！!？?`) or the first newline, whichever
 * comes first (§2.2). The character itself is **kept**, because it is part of
 * the sentence; what is dropped is everything after it, which the expanded
 * `<details>` carries verbatim.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function firstSentence(body) {
  const text = String(body ?? "");
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n" || "。．.！!？?".includes(ch)) return text.slice(0, i + 1).trim();
  }
  return text.trim();
}

/**
 * Has this comment already been consumed?
 *
 * The cursor is an **opaque watermark** — the id of the human comment the loop
 * last acted on — so the only honest test is identity: the comment at the
 * watermark is consumed, anything else is new. Ordering is deliberately *not*
 * inferred from the value (a cursor is opaque; guessing "greater" from string
 * order would be a second, invented rule), which is what lets the caller key it
 * on whatever monotonic field the loop already persists.
 *
 * The comparison is pure, so asking the same question twice gives the same
 * answer — the idempotence of the whole resume path rests on that.
 *
 * @param {string|number|null|undefined} cursor
 * @param {string|number|null|undefined} commentId
 * @returns {boolean}
 */
export function isConsumed(cursor, commentId) {
  if (cursor === null || cursor === undefined) return false; // nothing consumed yet
  if (commentId === null || commentId === undefined) return false; // nothing to match
  return String(cursor) === String(commentId);
}

/**
 * The resume decision for one `awaiting` card.
 *
 * @param {{
 *   task?: {status?: string},
 *   comments?: object[],
 *   cursor?: string|number|null,
 * }} input
 * @returns {{resume: boolean, reason: string, comment: object|null, nextCursor: string|number|null}}
 *   `resume: true` only when **all** of these hold:
 *
 *     * the card is `awaiting` (nothing else has a resume to decide);
 *     * the newest comment on the card is written by a **human**
 *       (`author_kind === "human"` — an agent comment is just a comment, and it
 *       neither satisfies the payload nor resumes the card, §2.3);
 *     * that comment is **strictly after the cursor**, so the same comment can
 *       never resume the card twice — the second read returns `resume: false`
 *       with the cursor unmoved (the idempotence the card's F2 asks for).
 *
 *   `nextCursor` is always safe to persist: it only advances when a resume is
 *   decided, so a rejected comment cannot silently swallow a later one.
 */
export function resumeDecision(input = {}) {
  const task = input.task ?? {};
  const comments = Array.isArray(input.comments) ? input.comments : [];
  const cursor = input.cursor ?? null;
  const settled = { comment: null, nextCursor: cursor };

  if (task.status !== STATUS.AWAITING) {
    return { resume: false, reason: "not_awaiting", ...settled };
  }

  const newest = comments.length > 0 ? comments[comments.length - 1] : null;
  if (newest === null) {
    return { resume: false, reason: "no_comment", ...settled };
  }
  if (!isHumanComment(newest)) {
    return { resume: false, reason: "not_human", ...settled };
  }
  if (isConsumed(cursor, newest.id)) {
    return { resume: false, reason: "already_consumed", comment: newest, nextCursor: cursor };
  }
  return { resume: true, reason: "human_reply", comment: newest, nextCursor: newest.id ?? cursor };
}
