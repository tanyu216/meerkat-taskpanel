/**
 * SSE event handling — the pure half (F4).
 *
 * `services/events.js` owns the `EventSource` and the reconnect plumbing; the
 * decisions it makes — how the cursor advances and what a given activity means
 * for the board — are pure and live here so they can be unit-tested without a
 * browser or a network.
 *
 * The stream is a cursor over the audit trail (`src/server/sse.mjs`):
 *   * every frame is **unnamed**, so only `onmessage` fires;
 *   * `id:` is the activity's `revision`, which is what a native `EventSource`
 *     resends as `Last-Event-ID` — so the cursor is simply the max revision seen;
 *   * the activity's own name is inside the JSON (`event`), not an SSE field.
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

/** The `?after=` query string for a resync, or `""` when there is no cursor yet. */
export function resyncQuery(cursor) {
  if (cursor === null || cursor === undefined) return "";
  const value = Number(cursor);
  return Number.isFinite(value) ? `?after=${value}` : "";
}
