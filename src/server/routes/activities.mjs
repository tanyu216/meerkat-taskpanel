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

import { activityToWire } from "../../shared/wire.mjs";
import { shape, str } from "../requests.mjs";
import { intOrUndefined } from "./projects.mjs";
import { resolveTask } from "./tasks.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
//
// `after` is a revision, and a revision arrives as a *string* because it is read
// off the query string — the handler is what parses it.
const LIST_QUERY = shape({ after: str(), limit: str() });

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
        })
        .map(activityToWire),
    };
  }, { query: LIST_QUERY });
}
