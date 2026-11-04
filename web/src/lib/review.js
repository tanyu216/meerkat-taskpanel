/**
 * The Acceptance tab's **review rounds** projection (ADR 0014).
 *
 * A review card stores its identity in `review_of_id` / `review_round`, and
 * since ADR 0014 it also carries `kind='review'`. The drawer's Acceptance panel
 * answers "what has audited this card, and how did each round end?" — so it
 * needs the review cards *of* the open card, oldest round first.
 *
 * Derived from the whole board reading (`board.tasks`), never a second request:
 * `loadTasks` keeps reviews in the list even while the board and list hide
 * them, precisely so the waiting queue, the roster and this panel can read them.
 *
 * The marker is the identity. A row matches when its internal `review_of_id`
 * names the open card, or — the documented legacy fallback — when its wire
 * `review_of` identifier does. `kind` is deliberately not the predicate: an
 * unresolvable legacy mirror stays `kind='task'` and must still appear.
 *
 * Pure: no Vue, no DOM, no clock.
 */

/**
 * A review card's round number, or `null` when the wire carries none.
 * @param {object} task
 * @returns {number|null}
 */
function roundOf(task) {
  return Number.isInteger(task?.review_round) ? task.review_round : null;
}

/**
 * Every card that reviews `task`, oldest round first.
 *
 * @param {{id?: string, identifier?: string}|null|undefined} task the open card
 * @param {object[]|null|undefined} tasks the whole board reading
 * @returns {{id: string, identifier: string, round: number|null, status: string,
 *   role: string, title: string, assignee: string}[]}
 */
export function reviewRoundsFor(task, tasks) {
  const id = task?.id;
  const identifier = task?.identifier;
  if (id === undefined && identifier === undefined) return [];

  const rows = (Array.isArray(tasks) ? tasks : [])
    .filter((other) => {
      if (other === null || typeof other !== "object") return false;
      // A card never reviews itself, even if a malformed row says so.
      if (other.id === id) return false;
      if (id !== undefined && other.review_of_id === id) return true;
      return identifier !== undefined && other.review_of === identifier;
    })
    .map((other) => ({
      id: other.id,
      identifier: other.identifier ?? "",
      round: roundOf(other),
      status: typeof other.status === "string" ? other.status : "",
      role: other.role ?? (other.kind === "review" ? "review" : "task"),
      title: other.title ?? "",
      assignee: other.assignee?.display_name ?? "",
    }));

  // A null round sorts before any numbered round; two rows of the same round
  // keep the board's own order, so a re-read never reshuffles the panel.
  return rows.sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
}
