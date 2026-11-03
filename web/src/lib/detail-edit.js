/**
 * B09 · the drawer's property-edit rules (TP-0075 round 2).
 *
 * The people rows outlive their edit window. Terry's ruling of 2026-11-04:
 * the assignee may change only while the card is still unstarted (`backlog`
 * or `todo`); once it is in flight, parked or terminal the value is read-only.
 * The reporter is never editable in the drawer — it is decided at creation.
 *
 * The predicate lives here, pure and Vue-free, for the same reason
 * `lib/detail-relations.js` does: the status window is a decision worth
 * asserting without a browser. `DetailDrawer.vue` is its only caller, and it
 * passes the same value to both the control's `disabled` prop and the commit
 * guard, so the two cannot disagree.
 */

/**
 * The two stages in which the assignee may still be changed. `awaiting` is an
 * attention overlay on an in-flight card, not a stage, so it is not here.
 */
export const ASSIGNEE_EDITABLE_STATUSES = Object.freeze(["backlog", "todo"]);

/**
 * May the drawer edit this card's assignee? An absent or unknown status reads
 * as read-only — the conservative side, since the value was already decided.
 *
 * @param {unknown} status the card's stored status
 * @returns {boolean}
 */
export function assigneeEditable(status) {
  return ASSIGNEE_EDITABLE_STATUSES.includes(status);
}
