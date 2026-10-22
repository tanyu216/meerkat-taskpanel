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
 *   * **The reason is an attribute.** `data-waiting-reason-kind` is `question`
 *     or `blocked` for the `awaiting` overlay, and `acceptance` for an
 *     `in_review` card the board's policy leaves to a human; the chip's copy
 *     comes from `waiting.reason.<kind>`.
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
import { kindLabel } from "./actor-kind.js";
import { feedTime } from "./activity-feed.js";
import { identifierText } from "./identifier.js";

/**
 * B27's reason domain.
 *
 * `question` and `blocked` are the `awaiting` overlay's two readings; M6 adds
 * `acceptance` — an `in_review` top-level card the board's policy says a human
 * must close (`human-only` / `both`). It shares the view (both are "on my
 * side") but not the trigger: nothing was asked, a delivery is waiting.
 */
export const WAITING_REASON_KINDS = Object.freeze(["question", "blocked", "acceptance"]);

/** The policies under which a human still has acceptance work on the board. */
export const HUMAN_ACCEPTANCE_POLICIES = Object.freeze(["human-only", "both"]);

const TERMINAL = new Set(["done", "canceled"]);

/** Is this card terminal? */
export function isTerminalTask(task) {
  return TERMINAL.has(task?.status);
}

/**
 * Does this card still have acceptance work for a human?
 *
 * The predicate is the client-side twin of the board's gates
 * (`commands/acceptance.mjs`), deliberately: the board refuses the human's
 * accept when these are false, so listing the card would be offering an action
 * that cannot succeed. It is derived from the **whole task list** rather than a
 * server-computed flag because the live stream refreshes one card at a time —
 * when a review card or a child lands, only *that* card arrives, and the
 * original's derived value must change with it.
 *
 * @param {object} task a wire task
 * @param {object[]} tasks the whole board reading
 * @param {string} policy `human-only` | `both` | `agent-only`
 * @returns {boolean}
 */
export function isAcceptanceWaiting(task, tasks, policy) {
  if (!HUMAN_ACCEPTANCE_POLICIES.includes(policy)) return false;
  if (task?.status !== "in_review") return false;
  // A review card is the loop's/human's bookkeeping, never an acceptance item.
  if (task.review_of_id !== null && task.review_of_id !== undefined) return false;
  // Children are the agents' to close; only top-level cards are a human's.
  if (task.parent_id !== null && task.parent_id !== undefined) return false;

  const others = Array.isArray(tasks) ? tasks : [];
  const children = others.filter((other) => other?.parent_id === task.id);
  if (children.some((child) => !isTerminalTask(child))) return false;

  const round = Number.isInteger(task.delivery_round) ? task.delivery_round : 0;
  const currentReviews = others.filter(
    (other) =>
      other?.review_of_id === task.id &&
      (other.review_round === null || other.review_round === undefined || other.review_round === round),
  );
  return currentReviews.every(isTerminalTask);
}

/**
 * The cards a human still has to accept, oldest first (the queue's own order
 * applies later).
 *
 * @param {object[]} tasks the whole board reading
 * @param {string} policy
 * @returns {object[]}
 */
export function acceptanceWaitingTasks(tasks, policy) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => isAcceptanceWaiting(task, tasks, policy));
}

/** The instant an acceptance wait began: the delivery that put it in review. */
export function acceptanceSinceOf(task) {
  return task?.status_changed_at ?? task?.updated_at ?? "";
}

/**
 * The comment a waiting row is showing: the newest `question`, else the newest
 * human comment (the M1 reading, for a card that predates the kind).
 *
 * Mirrors `src/core/domain/awaiting.mjs#payloadOf` — the web cannot import
 * `src/`, so this is a copy held in step by `test/web/waiting.queue.test.mjs`.
 *
 * @param {object[]} comments wire comments (`kind`, `author_kind`, …)
 * @returns {object|null}
 */
export function payloadCommentOf(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.kind === "question") return list[i];
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.author_kind === "human") return list[i];
  }
  return null;
}

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
    // The design attribute's two values: is the assignee *not* the human?
    actorKind: kindLabel(task.assignee?.kind),
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

/**
 * One acceptance card → one queue row. Same six fields as an awaiting row, so
 * the view renders one table; `reasonKind` is what tells the two apart.
 *
 * @param {object} task a wire card whose `in_review` delivery is the human's
 */
export function acceptanceRow(task) {
  return {
    id: task.id,
    identifier: task.identifier,
    display: identifierText(task.identifier),
    title: task.title ?? "",
    // The agent that delivered it, not the human it waits for.
    actor: task.assignee?.display_name ?? "",
    actorKind: kindLabel(task.assignee?.kind),
    reasonKind: "acceptance",
    reasonKey: reasonKeyOf("acceptance"),
    since: acceptanceSinceOf(task),
    payload: null,
    kind: "acceptance",
  };
}

/**
 * Turn an **already-derived** acceptance set into rows.
 *
 * Separate from `acceptanceRows` because the predicate needs the *whole* board
 * reading (children and review cards) while the view may show only the rows an
 * assignee narrowing leaves. Re-running `acceptanceWaitingTasks` on the narrowed
 * list would judge a card against the cards that survived the filter — a child
 * assigned to another agent would silently count as resolved — so the narrow
 * step must happen **after** the derivation, on its result.
 *
 * @param {object[]} tasks acceptance cards (`acceptanceWaitingTasks`' answer)
 * @param {number} [now]
 */
export function acceptanceRowsFrom(tasks, now = Date.now()) {
  return (Array.isArray(tasks) ? tasks : [])
    .map(acceptanceRow)
    .map((row) => ({ ...row, stamp: feedTime(row.since, now) }));
}

/**
 * The acceptance half of the queue, ordered with the awaiting half.
 *
 * @param {object[]} tasks the **whole** board reading (the derivation needs
 *   children and review cards, not only the cards it returns)
 * @param {string} policy
 * @param {number} [now]
 */
export function acceptanceRows(tasks, policy, now = Date.now()) {
  return acceptanceRowsFrom(acceptanceWaitingTasks(tasks, policy), now);
}

/**
 * The merged queue: waiting questions and waiting acceptances, oldest first.
 * Rows tie on `since` keep their input order (awaiting rows first), so re-reads
 * are stable.
 *
 * @param {object[]} awaitingRows
 * @param {object[]} acceptanceRows
 */
export function mergeWaitingRows(awaitingRows, acceptanceRows) {
  const row = (item) => item.since ?? "";
  return [...(Array.isArray(awaitingRows) ? awaitingRows : []), ...(Array.isArray(acceptanceRows) ? acceptanceRows : [])]
    .map((item) => ({ ...item, kind: item.kind ?? "question" }))
    .sort((a, b) => (row(a) === row(b) ? 0 : row(a) < row(b) ? -1 : 1));
}
