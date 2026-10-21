/**
 * `GET /api/v1/tasks/:ref/activities` — a task's audit trail (§5.1).
 *
 * The same rows the SSE stream pushes, read on demand: "what happened to this
 * card, and who did it". It is also the honest answer to "was this delivered
 * without a report" — the `report_waived` events are here, in order.
 *
 * `?after=<revision>` makes it a cursor read, which is what a client that lost
 * the stream (or never had it) uses to catch up one card at a time.
 */

import { DomainError } from "../../foundation/errors.mjs";
import { activityToWire } from "../../foundation/wire.mjs";
import { intOrUndefined, shape, str } from "../requests.mjs";
import { resolveTask } from "../task-view.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
//
// `after` is a revision, and a revision arrives as a *string* because it is read
// off the query string — the handler is what parses it.
//
// `order` is the drawer's read: `desc` with `limit` returns the newest N. The
// default stays `asc` because the SSE replay cursor pages forward by `id`; a
// `desc` read with `after` still filters `id > cursor`, so it is not a
// "previous page" cursor.
const LIST_QUERY = shape({ after: str(), limit: str(), order: str() });

/**
 * Validate `?order=` the way `GET /tasks?order=` does (`tasks.mjs#resolveOrder`):
 * case/space tolerant, empty means the default, an unknown word is refused.
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

/** @param {object} router @param {{board: object}} surface */
export function registerActivityRoutes(router, surface) {
  const { repos } = surface.board;

  router.get("/api/v1/tasks/:ref/activities", ({ params, query }) => {
    const task = resolveTask(repos, params.ref);
    return {
      task_id: task.id,
      activities: repos.activities
        .list({
          taskId: task.id,
          ...(intOrUndefined(query.get("after")) === undefined ? {} : { afterRevision: intOrUndefined(query.get("after")) }),
          ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
          order: readOrder(query.get("order")),
        })
        .map(activityToWire),
    };
  }, { query: LIST_QUERY });
}
