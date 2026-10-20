/**
 * The assignee narrowing, shared by the board, the waiting queue and the
 * activity feed.
 *
 * The sidebar's roster and the board bar's Assignee control both write one
 * value (`board.filters.assignee`): the four static values `all | me | human |
 * agent`, or a **given name** the roster holds (`design/fidelity-r13.md` §10.1).
 * The board has always read that value through `visibleTasks`; the activity and
 * waiting views did not, so a roster press narrowed only board/list. This module
 * is the one predicate all three use, so a press cannot mean three things.
 *
 * It is pure and browser-free — the store, the feed builder and the queue
 * builder all import it, and `test/web/assignee-filter.test.mjs` pins it without
 * Vue. The caller supplies `me`, the local human's name (`stores/board.js#ME`),
 * so this file does not hard-code an identity.
 */

import { kindLabel } from "./actor-kind.js";

/**
 * Does one actor pass the assignee condition?
 *
 * @param {string|null|undefined} value the filter: `all` / `me` / `human` /
 *   `agent` / a given name. `""` and `null` read as `all`.
 * @param {string|null|undefined} actor the actor's display name. Empty means
 *   **nobody is assigned**, and that actor passes no narrowing at all — the
 *   board's long-standing rule: an unassigned card is in neither the human row
 *   nor the agent row, because there is nobody to ask about.
 * @param {unknown} kind the actor's kind (a platform, `agent`, `human`, or
 *   nothing). Read through `kindLabel`, so a platform counts as an agent.
 * @param {string} me the local human's name, for the `me` value.
 * @returns {boolean}
 */
export function actorMatches(value, actor, kind, me) {
  const filter = value == null || value === "" ? "all" : String(value);
  if (filter === "all") return true;
  const name = String(actor ?? "");
  if (name === "") return false;
  if (filter === "me") return name === me;
  if (filter === "human" || filter === "agent") return kindLabel(kind) === filter;
  return name === filter;
}
