/**
 * Project use-cases. Small on purpose: a project is a name, a label set and
 * free-form meta — the board does no directory management, so there is no path
 * rule left to enforce here.
 *
 * The one identity rule that lives here is the **identifier prefix**: a project
 * id is normalized to the prefix its tasks are numbered with (see
 * `identifierPrefix`), and two projects sharing a prefix are indistinguishable
 * on the board — both would hand out `OPENCLAW-TEAM-0007`. Creation therefore
 * refuses a prefix another project already owns.
 */

import { DomainError } from "../../shared/errors.mjs";
import { identifierPrefix } from "../../shared/ids.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/**
 * Refuse a project whose id normalizes to a prefix an existing project already
 * uses. Runs inside the caller's create transaction, so the read and the insert
 * cannot be split by another writer (`BEGIN IMMEDIATE`), and a refusal leaves no
 * row behind.
 *
 * The comparison is against **every** project, archived included: archiving does
 * not retire a prefix, because the identifiers it handed out are still on cards.
 * A row whose id is *exactly* the requested id is not a collision — that is the
 * same project, and `repos.projects.create` already answers it with
 * `ID_CONFLICT`.
 *
 * An id that normalizes to the empty prefix (`###`) is left to the pre-existing
 * guard in `identifierFor`, which refuses to allocate an identifier for it; this
 * check is about collisions, not emptiness, so it steps aside when the prefix is
 * "".
 *
 * @param {object} repos
 * @param {string} id the requested project id (a caller-supplied one)
 */
function assertPrefixAvailable(repos, id) {
  const prefix = identifierPrefix(id);
  if (prefix === "") return;
  const conflict = repos.projects
    .list({ includeArchived: true })
    .filter((project) => project.id !== id && identifierPrefix(project.id) === prefix)
    // Several projects can already share a prefix (history the board never
    // rejected). Name the same one every time so the refusal is deterministic.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (conflict === undefined) return;
  throw new DomainError("VALIDATION_FAILED", {
    message:
      `project id ${JSON.stringify(id)} normalizes to identifier prefix ` +
      `${JSON.stringify(prefix)}, already used by project ${JSON.stringify(conflict.id)}`,
    details: { field: "id", projectId: id, prefix, conflictProjectId: conflict.id },
  });
}

/**
 * @param {object} ctx
 * @param {{id?: string, name: string, labels?: string[], meta?: object, readme?: string, actor?: object}} input
 */
export function createProject(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  return transaction(
    ctx.db,
    () => {
      // Only an explicit id is checked: a project created without one gets a
      // freshly minted UUID, whose prefix is unique by construction.
      if (input.id !== undefined) assertPrefixAvailable(ctx.repos, input.id);
      const project = ctx.repos.projects.create({ ...input, now: ctx.now() });
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "project_created",
        changes: { project: project.id },
        createdAt: ctx.now(),
      });
      return project;
    },
    { op: "projects.create" },
  );
}

/**
 * @param {object} ctx
 * @param {{id: string, patch: {name?: string, labels?: string[], meta?: object, readme?: string|null}, actor?: object}} input
 */
export function updateProject(ctx, input) {
  return ctx.repos.projects.update(input.id, { ...input.patch, now: ctx.now() });
}

/** @param {object} ctx @param {{id: string}} input */
export function getProject(ctx, input) {
  return ctx.repos.projects.get(input.id);
}

/** @param {object} ctx @param {{includeArchived?: boolean}} [filter] */
export function listProjects(ctx, filter = {}) {
  return ctx.repos.projects.list(filter);
}

/** @param {object} ctx @param {{id: string, readme: string|null}} input */
export function readmeSet(ctx, input) {
  return ctx.repos.projects.update(input.id, { readme: input.readme, now: ctx.now() });
}

/** @param {object} ctx @param {{id: string}} input */
export function readmeGet(ctx, input) {
  const project = ctx.repos.projects.get(input.id);
  if (project === null) {
    throw new DomainError("NOT_FOUND", { message: `no project ${input.id}`, details: { projectId: input.id } });
  }
  return project.readme;
}
