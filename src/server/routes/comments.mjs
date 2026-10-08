/**
 * Comment routes — append and read. There is deliberately no PATCH and no
 * DELETE: `comments` refuses UPDATE/DELETE at the database level (I4), so
 * exposing either here could only ever produce a 500.
 */

import { commentToWire } from "../../shared/wire.mjs";
import { intOrUndefined } from "./projects.mjs";
import { resolveTask } from "./tasks.mjs";

/** @param {object} router @param {{board: object}} surface */
export function registerCommentRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks/:ref/comments", ({ params, query }) => {
    const task = resolveTask(repos, params.ref);
    return {
      comments: commands
        .listComments({
          taskId: task.id,
          ...(query.get("kind") === null ? {} : { kind: query.get("kind") }),
          ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
          ...(query.get("after") === null ? {} : { after: query.get("after") }),
        })
        .map(commentToWire),
    };
  });

  router.post("/api/v1/tasks/:ref/comments", ({ params, body, actor, session }) => {
    const task = resolveTask(repos, params.ref);
    const comment = commands.addComment({
      taskId: task.id,
      body: body.body,
      kind: body.kind,
      refs: body.refs,
      agentSession: body.agent_session ?? session,
      actor,
    });
    return { comment: commentToWire(comment) };
  });
}
