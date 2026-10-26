/**
 * Comment routes — append and read. There is deliberately no PATCH and no
 * DELETE: `comments` refuses UPDATE/DELETE at the database level (I4), so
 * exposing either here could only ever produce a 500.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { commentToWire } from "../../foundation/wire.mjs";
import { arr, intOrUndefined, REQUEST, shape, str } from "../requests.mjs";
import { lookupFor, resolveTask } from "../task-view.mjs";

// Declared request schemas, frozen by the contract snapshot (`routes[].request`)
// — see `src/server/requests.mjs` for the vocabulary and the "declared, not
// enforced" stance.

/**
 * `GET /api/v1/tasks/:ref/comments` — a cursor read by `after`, filtered by kind.
 *
 * `order` is the display read: `desc` with `limit` returns the **newest** N,
 * which is what the CLI table/JSON and the drawer show. The default stays `asc`
 * for the internal predicates that walk the trail oldest-first.
 */
const LIST_QUERY = shape({ kind: REQUEST.commentKind, limit: str(), after: str(), order: str() });

/**
 * Validate `?order=` the same way the activity read does
 * (`routes/activities.mjs#readOrder`): case/space tolerant, empty means the
 * default, an unknown word is refused.
 * @param {string|null|undefined} value
 */
function readOrder(value) {
  if (value === undefined || value === null || value === "") return "asc";
  const word = String(value).trim().toLowerCase();
  if (word === "asc" || word === "desc") return word;
  throw new DomainError("VALIDATION_FAILED", {
    message: `unknown order ${JSON.stringify(value)}`,
    details: { field: "order", received: value, allowed: ["asc", "desc"] },
  });
}

/** `POST /api/v1/tasks/:ref/comments` — append. `body` is the comment's text. */
const CREATE_BODY = shape({ body: str(), kind: REQUEST.commentKind, refs: arr(str()), agent_session: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerCommentRoutes(router, surface) {
  const { commands, repos } = surface.board;

  router.get("/api/v1/tasks/:ref/comments", ({ params, query }) => {
    const task = resolveTask(repos, params.ref);
    const lookup = lookupFor(repos);
    return {
      comments: commands
        .listComments({
          taskId: task.id,
          ...(query.get("kind") === null ? {} : { kind: query.get("kind") }),
          ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
          ...(query.get("after") === null ? {} : { after: query.get("after") }),
          order: readOrder(query.get("order")),
        })
        .map((comment) => commentToWire(comment, { lookup })),
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
    return { comment: commentToWire(comment, { lookup: lookupFor(repos) }) };
  }, { body: CREATE_BODY });
}
