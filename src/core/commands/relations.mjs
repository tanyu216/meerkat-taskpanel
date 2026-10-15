/**
 * Relation use-cases.
 *
 * The shape rules are checked here (so a bad edge is reported with a precise
 * reason code and the chain it would create), then again by the triggers — the
 * database is what actually guarantees them.
 */

import { DomainError } from "../../shared/errors.mjs";
import { assertBlockEdgeAllowed, assertParentEdgeAllowed, normalizeRelation, parentChainOf } from "../domain/relation.mjs";
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

      // A `blocks` edge is a `depends_on` link (the drawer's ④): source is the
      // prerequisite, target is the card that waits on it. `README.md` §3 makes
      // the dependency graph a DAG, so a cycle is refused here for the same
      // reason a parent cycle is — it is a deadlock, not a shape nobody minds.
      // T-20261014-212017-4 added this; before it the table's only `blocks`
      // guards were self-reference and cross-project, and `a → b → a` went in.
      //
      // The parent chain is read as well, because the two orders together are
      // what makes a deadlock: a card waiting on its own ancestor, or on a child
      // it contains, is never offered to the poll either however acyclic the
      // `blocks` graph is on its own (T-20261015-063755, ruling 乙). Reading it
      // is the one extra query this command does, and it is on the write path
      // only — the same shape as the `parent` guard above, which already reads
      // the chain.
      if (edge.type === "blocks" && input.force !== true) {
        assertBlockEdgeAllowed(edge, {
          edges: ctx.repos.relations.listBlockEdges(),
          parentEdges: ctx.repos.relations.listParentEdges(),
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
 *
 * `parentChain` is the card's **ancestor and descendant ids, either direction**
 * — the set a `blocks` edge to or from this card would be refused on
 * (`domain/relation.mjs#isOnSameParentChain`, `0019_block_chain.sql`). It is
 * read here, on the same response the drawer already fetches when it opens, so
 * the prerequisite picker's candidate list can be filtered by the board's own
 * answer instead of by a second graph walk in the browser. The picker offered
 * ancestors before this existed; the refusal was the only half that was built
 * (T-20261015-104813).
 *
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
    parentChain: parentChainOf(ctx.repos.relations.listParentEdges(), task.id),
  };
}
