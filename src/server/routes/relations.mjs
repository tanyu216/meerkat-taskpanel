/**
 * Relation routes — add, remove, list. Add/remove only: a relation is a fact
 * with a timestamp, and rewriting one would rewrite history (§4.1).
 */

import { relationToWire } from "../../shared/wire.mjs";
import { bool, REQUEST, shape, str } from "../requests.mjs";
import { resolveTask } from "./tasks.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
const ADD_BODY = shape({ target: str(), type: REQUEST.relationType, force: bool(), origin: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerRelationRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks/:ref/relations", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    const listing = commands.listRelations({ taskId: task.id });
    return {
      task_id: task.id,
      relations: listing.relations.map(relationToWire),
      children: listing.children.map(relationToWire),
      ancestors: listing.ancestors.map(relationToWire),
      blocked_by: listing.blockedBy.map(relationToWire),
      blocks: listing.blocks.map(relationToWire),
    };
  });

  router.post("/api/v1/tasks/:ref/relations", ({ params, body, actor }) => {
    const source = resolveTask(repos, params.ref);
    const target = resolveTask(repos, body.target);
    const relation = commands.addRelation({
      type: body.type,
      source: source.id,
      target: target.id,
      force: body.force === true,
      origin: body.origin,
      actor,
    });
    return { relation: relationToWire(relation) };
  }, { body: ADD_BODY });

  router.delete("/api/v1/tasks/:ref/relations/:relationId", ({ params, actor }) => {
    resolveTask(repos, params.ref);
    const removed = commands.removeRelation({ relationId: Number(params.relationId), actor });
    return { removed: removed.removed, relation: relationToWire(removed.relation) };
  });
}
