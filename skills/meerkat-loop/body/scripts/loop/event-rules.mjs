/**
 * Which board activities wake the loop, and which are the loop's own echo.
 *
 * The subscriber is a **signal**, not a mutation path: a dispatched event only
 * asks the existing continue turn to scan the board. That is what makes replay,
 * duplicate frames and bursts harmless — the scan is state-based and idempotent.
 *
 * The suppression rule is about **who wrote the event**, not what role word a
 * writer used:
 *   * a human's event is never suppressed;
 *   * the board's own housekeeping is authored by `taskd` (the concrete platform
 *     name; legacy rows may carry the old vague `system` with the same id);
 *   * this loop's own agents write claims and workflow moves under their own
 *     ids, so an event authored by one of `opts.agents` is our echo.
 *
 * `import_completed` is authored by `taskd`/`md-import`, not by `taskd`/`taskd`,
 * so it survives suppression — which is the point: an import that changed the
 * board is work the loop must discover.
 *
 * Node builtins only; no network, no dependencies.
 */

import { HUMAN_KIND, TASKD_KIND } from "../../src/shared/constants.mjs";

/**
 * Events that can make work newly actionable or complete. Everything else is
 * either noise for dispatch (comments, sessions, progress, attachments) or a
 * project-level change the UI reloads but the loop does not act on.
 */
export const DISPATCH_EVENTS = Object.freeze([
  "task_created",
  "task_moved",
  "task_delivered",
  "report_written",
  "report_waived",
  "epic_auto_start",
  "relation_added",
  "relation_removed",
  "import_completed",
]);

/**
 * `task_updated` is field-dependent: a title edit is not a dispatch, a
 * reassignment or a workflow `meta` flag is.
 */
export const TASK_UPDATED_DISPATCH_FIELDS = Object.freeze([
  "assigneeId",
  "assigneeKind",
  "kind",
  "labels",
  "meta",
]);

const DISPATCH = new Set(DISPATCH_EVENTS);
const UPDATED_FIELDS = new Set(TASK_UPDATED_DISPATCH_FIELDS);

/**
 * Did this loop (or the board itself) write the activity?
 *
 * @param {object} activity an `activityToWire` payload
 * @param {{agents: string[]}} context
 * @returns {boolean}
 */
export function isOwnWrite(activity, context) {
  if (activity?.actor_kind === HUMAN_KIND) return false;
  const id = activity?.actor_id;
  if (typeof id !== "string" || id === "") return false;
  if (id === TASKD_KIND) return true;
  return Array.isArray(context?.agents) && context.agents.includes(id);
}

/**
 * `"dispatch"` asks for a continue turn; `"ignore"` does nothing.
 *
 * @param {object} activity
 * @param {{agents: string[]}} context
 * @returns {"dispatch"|"ignore"}
 */
export function classify(activity, context) {
  if (isOwnWrite(activity, context)) return "ignore";
  const event = activity?.event;
  if (event === "task_updated") {
    const fields = Array.isArray(activity?.changes?.fields) ? activity.changes.fields : [];
    return fields.some((field) => UPDATED_FIELDS.has(field)) ? "dispatch" : "ignore";
  }
  return DISPATCH.has(event) ? "dispatch" : "ignore";
}

/**
 * The reconnect cursor is the largest `id:` seen. It is a revision, and the
 * server replays rows strictly newer than it.
 *
 * @param {number|null} cursor
 * @param {{id: string|null}} frame
 * @returns {number|null}
 */
export function advanceCursor(cursor, frame) {
  const next = Number.parseInt(frame?.id ?? "", 10);
  if (!Number.isFinite(next)) return cursor;
  return cursor === null || next > cursor ? next : cursor;
}
