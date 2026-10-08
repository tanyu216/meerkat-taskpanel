/**
 * Project use-cases. Small on purpose: a project is a workspace anchor, and the
 * only interesting rule (a unique absolute `workspace_path`) is a database
 * constraint.
 */

import { DomainError } from "../../shared/errors.mjs";
import { normalizeWorkspacePath } from "../domain/task.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/**
 * @param {object} ctx
 * @param {{id?: string, name: string, workspacePath: string, labels?: string[], meta?: object, readme?: string, actor?: object}} input
 */
export function createProject(ctx, input) {
  const actor = actorOf(input.actor ?? { kind: "human", id: "local" });
  return transaction(
    ctx.db,
    () => {
      const project = ctx.repos.projects.create({ ...input, now: ctx.now() });
      ctx.repos.activities.append({
        taskId: null,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "project_created",
        changes: { project: project.id, workspacePath: project.workspacePath },
        createdAt: ctx.now(),
      });
      return project;
    },
    { op: "projects.create" },
  );
}

/**
 * @param {object} ctx
 * @param {{id: string, patch: {name?: string, workspacePath?: string, labels?: string[], meta?: object, readme?: string|null}, actor?: object}} input
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

/** The project the current directory belongs to (§4.4). */
export function projectForPath(ctx, input) {
  const candidates = ctx.repos.projects.listForPath(normalizeWorkspacePath(input.path));
  return candidates[0] ?? null;
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
