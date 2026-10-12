/**
 * B27 · the waiting queue's projection (R12x).
 *
 * Authority: `design/BLOCKS.md` B27, `design/DESIGN.md` §30. The view answers
 * one question — "what is on *my* side" — and the projection is the whole of it,
 * as pure functions, so the order and the six fields a row owes can be asserted
 * without a browser.
 *
 * Three rules are load-bearing:
 *
 *   * **Oldest first.** The queue's top row has waited longest, so the list reads
 *     as an overdue-first inbox. B26's feed is deliberately the reverse — a
 *     chronology — and the reversal is the point: newest-first would hide the item
 *     that has waited five days behind the one that arrived a minute ago.
 *   * **A row states only the instant it carries.** `since` is the moment the wait
 *     began — the human comment that triggered it when M1 has read one, the card's
 *     own last change otherwise — and it is both the row's `data-since` and the
 *     `datetime` its visible stamp is printed from, so the two cannot disagree.
 *   * **The reason is a two-value attribute.** `data-waiting-reason-kind` is
 *     `question` or `blocked` (the design's whole domain) and the chip's copy comes
 *     from `waiting.reason.<kind>`.
 *
 * **One data note, stated rather than papered over.** The core's awaiting
 * categories are `E1`–`E5` (`src/core/domain/enums.mjs#AWAITING_REASONS`), and
 * every one of them is a question put to a human — nothing parks a card as
 * *blocked* on somebody. So the shipped queue renders `question`, and `blocked`
 * exists in the domain and in the prototype's sample without a producer here
 * (B27's own consistency item 5 asks for both, which M1's data domain cannot
 * satisfy). The category itself is not lost: the **card** keeps saying which of
 * the five it is (`[data-waiting-reason="E1"]`, on the badge's own `title`),
 * which is where M1 put it.
 *
 * The time ladder is B26's, imported rather than restated — B27 asks for "one
 * time vocabulary" across the two views, and a second copy of the same ladder is
 * exactly how the two would drift apart.
 */
import { feedTime } from "./activity-feed.js";
import { identifierText } from "./identifier.js";

/** B27's reason domain — both values, whatever the data can currently produce. */
export const WAITING_REASON_KINDS = Object.freeze(["question", "blocked"]);

/** The awaiting categories the core writes, all of them questions to a human. */
export const AWAITING_CATEGORIES = Object.freeze(["E1", "E2", "E3", "E4", "E5"]);

/**
 * The kind a card's awaiting category maps to.
 *
 * @param {{awaiting_reason?: string|null}} [task]
 * @returns {"question"|"blocked"}
 */
export function reasonKindOf(task) {
  const raw = String(task?.awaiting_reason ?? "").toLowerCase();
  return WAITING_REASON_KINDS.includes(raw) ? raw : "question";
}

/** The chip's copy key for a kind. */
export function reasonKeyOf(kind) {
  return `waiting.reason.${WAITING_REASON_KINDS.includes(kind) ? kind : "question"}`;
}

/**
 * The instant a card's wait began: the triggering comment's own stamp when M1 has
 * read it, else the card's last change — never a clock read *here*, so a row is
 * reproducible.
 *
 * @param {{updated_at?: string}} task
 * @param {{created_at?: string}|null} payload
 */
export function sinceOf(task, payload) {
  return payload?.created_at ?? task?.updated_at ?? "";
}

/**
 * One awaiting card → one queue row.
 *
 * @param {object} task a wire task with the `awaiting` overlay
 * @param {{created_at?: string}|null} [payload] the comment that triggered it
 */
export function waitingRow(task, payload = null) {
  const reasonKind = reasonKindOf(task);
  return {
    id: task.id,
    identifier: task.identifier,
    // R8 ③ — the cell is a character slice (`lib/identifier.js`), and the `title`
    // carries the whole value.
    display: identifierText(task.identifier),
    title: task.title ?? "",
    // "Who is waiting on you": the agent the card is parked on, not the human it
    // is parked *for*.
    actor: task.assignee?.display_name ?? "",
    actorKind: task.assignee?.kind ?? "human",
    reasonKind,
    reasonKey: reasonKeyOf(reasonKind),
    since: sinceOf(task, payload),
    payload: payload ?? null,
  };
}

/**
 * The queue: every awaiting card as a row, **oldest first**. Two rows that began
 * in the same instant keep the board's own order, so the list is stable across
 * re-reads.
 *
 * @param {object[]} tasks the awaiting cards (`stores/board.js#waitingTasks`)
 * @param {Record<string, object|null>} [payloads] task id → the triggering comment
 * @param {number} [now] epoch ms — injected by the tests, never by the app
 */
export function waitingRows(tasks, payloads = {}, now = Date.now()) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => waitingRow(task, payloads[task.id] ?? null))
    .map((row) => ({ ...row, stamp: feedTime(row.since, now) }))
    .sort((a, b) => (a.since === b.since ? 0 : a.since < b.since ? -1 : 1));
}
