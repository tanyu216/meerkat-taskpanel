/**
 * Comment routes — append and read. There is deliberately no PATCH and no
 * DELETE: `comments` refuses UPDATE/DELETE at the database level (I4), so
 * exposing either here could only ever produce a 500.
 */

import { commentToWire } from "../../shared/wire.mjs";
import { arr, REQUEST, shape, str } from "../requests.mjs";
import { intOrUndefined } from "./projects.mjs";
import { resolveTask } from "./tasks.mjs";

// Declared request schemas, frozen by the contract snapshot (`routes[].request`)
// — see `src/server/requests.mjs` for the vocabulary and the "declared, not
// enforced" stance.

/** `GET /api/v1/tasks/:ref/comments` — a cursor read by `after`, filtered by kind. */
const LIST_QUERY = shape({ kind: REQUEST.commentKind, limit: str(), after: str() });

/** `POST /api/v1/tasks/:ref/comments` — append. `body` is the comment's text. */
const CREATE_BODY = shape({ body: str(), kind: REQUEST.commentKind, refs: arr(str()), agent_session: str() });

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
  }, { query: LIST_QUERY });

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
  }, { body: CREATE_BODY });
}
