/**
 * The wire view of one card, shared by every route that answers with a task.
 *
 * These four helpers used to live in `routes/tasks.mjs`, which made a feature
 * route the de-facto shared module for comments, relations, sessions,
 * activities and attachments. The seam they belong to is not "the task routes";
 * it is "how this server turns a task into a payload", so they live here and
 * every route imports from this module.
 *
 * They take `repos` rather than a `board`: addressing a card and projecting it
 * reads the repositories and nothing else, which keeps the helpers usable from
 * `handleAttachmentContent` (matched outside the router) without dragging the
 * HTTP surface along.
 *
 * Pure composition — no writes, no clock.
 */

import { taskToWire, waiversFromActivities } from "../foundation/wire.mjs";

/**
 * `PROJ-0007` or a UUID — whichever the caller has.
 *
 * @param {object} repos
 * @param {string} ref
 */
export function resolveTask(repos, ref) {
  return repos.tasks.requireAnyRef(ref);
}

/** Dictionary lookup for the wire projection (`display_name` for an id). */
export function lookupFor(repos) {
  return (kind, id) => repos.dictionary.getById(kind, id);
}

/**
 * The parent edge of one card, as a wire value.
 *
 * `parent_id` is deliberately a projection and not a column: the board models
 * parenthood as a `parent` relation in `task_relations`, and copying it onto the
 * card would be a second answer that could drift.
 */
export function parentIdOf(repos, taskId) {
  return repos.relations.getParent(taskId)?.source ?? null;
}

/** A task plus the audit trail a reviewer needs: who waived delivery, and why. */
export function taskPayload(repos, task) {
  const wire = taskToWire(task, { lookup: lookupFor(repos), parentId: parentIdOf(repos, task.id) });
  // The review card's readable target, resolved from the structural column.
  // `meta.review_of` is only a mirror; a column-only row must still display the
  // original's identifier rather than its internal id.
  wire.review_of =
    task.reviewOfId === null || task.reviewOfId === undefined
      ? null
      : (repos.tasks.get(task.reviewOfId)?.identifier ?? null);
  return {
    task: wire,
    report_waivers: waiversFromActivities(repos.activities.list({ taskId: task.id, limit: 1000 })),
  };
}
