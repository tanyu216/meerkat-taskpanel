/**
 * SSE event handling — the pure half (F4).
 *
 * `services/events.js` owns the `EventSource` and the reconnect plumbing; the
 * decisions it makes — how the cursor advances and what a given activity means
 * for the board — are pure and live here so they can be unit-tested without a
 * browser or a network.
 *
 * The stream is a cursor over the audit trail (`src/server/sse.mjs`):
 *   * every *activity* frame is **unnamed**, so only `onmessage` fires;
 *   * `id:` is the activity's `revision`, which is what a native `EventSource`
 *     resends as `Last-Event-ID` — so the cursor is simply the max revision seen;
 *   * the activity's own name is inside the JSON (`event`), not an SSE field;
 *   * one frame *is* named — [`SHUTDOWN_EVENT`](#shutdownevent), the server
 *     saying it is going away on purpose. It carries no `id:`, so it can never
 *     move the cursor, and `onmessage` never sees it.
 */

/**
 * The cursor after seeing a frame. Revision is non-decreasing, so the cursor
 * never moves backwards even if a replay delivers a stale frame.
 *
 * @param {number|null} current
 * @param {unknown} revision
 * @returns {number|null}
 */
export function advanceCursor(current, revision) {
  const value = Number(revision);
  if (!Number.isFinite(value)) return current;
  return current === null || current === undefined ? value : Math.max(current, value);
}

/**
 * What a received activity should make the board refetch.
 *
 * A task-scoped event names one task (`task_id`); a project-scoped or
 * task-less event (schema changes, project rows) forces a full reload. Heartbeat
 * events never reach the client — the server filters them — but an unknown
 * shape is treated as "reload everything", which is the safe direction.
 *
 * @param {object|null} activity the wire activity (`activityToWire`)
 * @returns {{scope: "task"|"all", taskId: string|null}}
 */
export function eventTargets(activity) {
  const taskId = activity?.task_id ?? null;
  if (typeof taskId === "string" && taskId !== "") return { scope: "task", taskId };
  return { scope: "all", taskId: null };
}

/* ------------------------------------------------------- refresh decisions */

/**
 * Task-scoped events that change the card row itself. Comments, sessions,
 * relations and attachments are task-scoped too, but they change a sub-resource
 * (or nothing the board renders), so they are handled by `detailRefetch` and do
 * not cost a task read on every keystroke.
 */
const TASK_REFRESH_EVENTS = new Set([
  "task_created",
  "task_updated",
  "task_claimed",
  "task_moved",
  "task_reopened",
  "task_archived",
  "task_delivered",
  "report_written",
  "report_waived",
  "epic_auto_start",
]);

/** Events with no task: an unknown one is treated as a full reload, the safe direction. */
const TASKLESS_RELOAD_EVENTS = new Set([
  "project_created",
  "project_updated",
  "label_gc",
  "import_completed",
]);

/** Events that can change the waiting queue's question / `since`. */
const WAITING_INVALIDATING_EVENTS = new Set([
  "task_created",
  "task_updated",
  "task_claimed",
  "task_moved",
  "task_reopened",
  "task_archived",
  "task_delivered",
  "report_waived",
  "comment_added",
]);

/**
 * @param {string|null|undefined} event
 * @returns {boolean}
 */
export function taskEventNeedsRefresh(event) {
  return TASK_REFRESH_EVENTS.has(event);
}

/**
 * A task-less event that should reload the board's shared lists. Unknown
 * task-less events take the same path — never a silent drop.
 *
 * @param {string|null|undefined} event
 * @returns {boolean}
 */
export function tasklessNeedsReload(event) {
  return TASKLESS_RELOAD_EVENTS.has(event) || !isKnownEvent(event);
}

/**
 * @param {string|null|undefined} event
 * @returns {boolean}
 */
export function invalidatesWaitingPayload(event) {
  return WAITING_INVALIDATING_EVENTS.has(event);
}

/** Every event the UI understands, for the unknown-event warning. */
const KNOWN_EVENTS = new Set([
  ...TASK_REFRESH_EVENTS,
  ...TASKLESS_RELOAD_EVENTS,
  "comment_added",
  "relation_added",
  "relation_removed",
  "session_registered",
  "session_closed",
  "progress",
  "attachment_added",
  "attachment_updated",
  "attachment_removed",
  "task_heartbeat",
]);

/** @param {string|null|undefined} event */
export function isKnownEvent(event) {
  return KNOWN_EVENTS.has(event);
}

/**
 * Which drawer sub-resources an activity invalidates. The drawer is a snapshot
 * loaded in `openDetail`; this is the map that keeps it live without refetching
 * everything on every frame.
 *
 * `activities` is on every row because the drawer's trail is a projection of the
 * same stream.
 *
 * @param {{event?: string}} activity
 * @returns {string[]} a subset of `task|comments|relations|activities|sessions|reports|attachments`
 */
export function detailRefetch(activity) {
  const event = activity?.event ?? "";
  switch (event) {
    case "comment_added":
      return ["comments", "activities"];
    case "relation_added":
    case "relation_removed":
      return ["relations", "activities"];
    case "session_registered":
    case "session_closed":
      return ["sessions", "activities"];
    case "report_written":
      return ["task", "reports", "activities"];
    case "task_delivered":
    case "report_waived":
      return ["task", "reports", "activities"];
    case "attachment_added":
    case "attachment_updated":
    case "attachment_removed":
      return ["attachments", "activities"];
    case "progress":
      return ["activities"];
    case "epic_auto_start":
      return ["task", "relations", "activities"];
    default:
      // task_created/updated/claimed/moved/archived and any unknown event: the
      // task row is the safe, bounded thing to reread.
      return ["task", "activities"];
  }
}

/** The `?after=` query string for a resync, or `""` when there is no cursor yet. */
export function resyncQuery(cursor) {
  if (cursor === null || cursor === undefined) return "";
  const value = Number(cursor);
  return Number.isFinite(value) ? `?after=${value}` : "";
}

/**
 * The reconnect ladder (T-20261014-213238).
 *
 * A dropped stream is re-opened by the client itself, never by the browser's
 * built-in retry: that retry is a *fixed* interval that repeats forever, which is
 * exactly the storm the card rules out. Ours doubles from `base`, and stops
 * doubling at `max` — so a `taskd` that is down for an hour costs two requests a
 * minute, not two a second, and the board heals by itself when it comes back.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * The delay before reconnect attempt `attempt` (0-based): `base`, doubling, held
 * at `max`. Pure, so the ladder is asserted rather than slept through.
 *
 * @param {number} attempt
 * @param {number} [base]
 * @param {number} [max]
 * @returns {number} milliseconds
 */
export function backoffDelay(attempt, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS) {
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // Clamped exponent: `2 ** 1024` is `Infinity`, and `Infinity * base` is a
  // delay nothing can honour.
  return Math.min(base * 2 ** Math.min(step, 30), Math.max(base, max));
}

/** The named frame `taskd` sends as it ends the stream on purpose (`src/server/sse.mjs`). */
export const SHUTDOWN_EVENT = "shutdown";
