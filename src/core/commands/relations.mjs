/**
 * Relation use-cases.
 *
 * The shape rules are checked here (so a bad edge is reported with a precise
 * reason code and the chain it would create), then again by the triggers — the
 * database is what actually guarantees them.
 */

import { DomainError } from "../../shared/errors.mjs";
import { assertParentEdgeAllowed, normalizeRelation } from "../domain/relation.mjs";
import { transaction } from "../storage/unit-of-work.mjs";
import { actorOf } from "./context.mjs";

/** Look a task up by id or by identifier, since callers legitimately have either. */
function loadTask(ctx, ref) {
  const task = ctx.repos.tasks.get(ref) ?? ctx.repos.tasks.findByIdentifierAnyProject(ref);
  if (task === null) {
    throw new DomainError("NOT_FOUND", { message: `no task ${ref}`, details: { taskRef: ref } });
  }
  return task;
}

/**
 * @param {object} ctx
 * @param {{type: "parent"|"blocks"|"related", source: string, target: string, actor: object, origin?: string, force?: boolean}} input
 */
export function addRelation(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const source = loadTask(ctx, input.source);
      const target = loadTask(ctx, input.target);
      const edge = normalizeRelation({ type: input.type, source: source.id, target: target.id });

      if (edge.type === "parent" && input.force !== true) {
        const projectOf = (id) => (id === source.id ? source.projectId : id === target.id ? target.projectId : undefined);
        assertParentEdgeAllowed(edge, {
          edges: ctx.repos.relations.listParentEdges(),
          projectOf,
          parent: source,
        });
      }

      const relation = ctx.repos.relations.insert({
        type: edge.type,
        source: edge.source,
        target: edge.target,
        origin: input.origin ?? null,
        now,
      });

      ctx.repos.activities.append({
        taskId: target.id,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "relation_added",
        changes: { relationId: relation.id, type: relation.type, source: relation.source, target: relation.target },
        createdAt: now,
      });
      return relation;
    },
    { op: "relations.add" },
  );
}

/**
 * @param {object} ctx
 * @param {{relationId: number, actor: object}} input
 */
export function removeRelation(ctx, input) {
  const actor = actorOf(input.actor);
  const now = ctx.now();

  return transaction(
    ctx.db,
    () => {
      const relation = ctx.repos.relations.get(input.relationId);
      if (relation === null) {
        throw new DomainError("NOT_FOUND", {
          message: `no relation ${input.relationId}`,
          details: { relationId: input.relationId },
        });
      }
      const removed = ctx.repos.relations.remove(input.relationId);
      if (!removed) {
        throw new DomainError("NOT_FOUND", {
          message: `relation ${input.relationId} disappeared`,
          details: { relationId: input.relationId },
        });
      }
      ctx.repos.activities.append({
        taskId: relation.target,
        actorKind: actor.kind,
        actorId: actor.id,
        event: "relation_removed",
        changes: { relationId: relation.id, type: relation.type },
        createdAt: now,
      });
      return { removed: true, relation };
    },
    { op: "relations.remove" },
  );
}

/**
 * Everything around one task: its edges, its parent chain and its blockers.
 * @param {object} ctx
 * @param {{taskId: string}} input
 */
export function listRelations(ctx, input) {
  const task = loadTask(ctx, input.taskId);
  return {
    taskId: task.id,
    relations: ctx.repos.relations.listByTask(task.id),
    children: ctx.repos.relations.listChildren(task.id),
    ancestors: ctx.repos.relations.listAncestors(task.id),
    blockedBy: ctx.repos.relations.listBlockerOf(task.id),
    blocks: ctx.repos.relations.listBlockedBy(task.id),
  };
}
