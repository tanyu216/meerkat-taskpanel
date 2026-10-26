/**
 * `GET /api/v1/tasks/:ref/activities` — a task's audit trail (§5.1);
 * `GET /api/v1/activities` — the same rows across the board.
 *
 * The same rows the SSE stream pushes, read on demand: "what happened to this
 * card, and who did it". It is also the honest answer to "was this delivered
 * without a report" — the `report_waived` events are here, in order.
 *
 * `?after=<revision>` makes it a cursor read, which is what a client that lost
 * the stream (or never had it) uses to catch up. The board-wide read is the
 * activity ledger's backfill: one request instead of one per card. It carries
 * every project's rows; a caller scopes them by the task set it already has
 * (the web feed does exactly that).
 */

import { DomainError } from "../../foundation/errors.mjs";
import { activityToWire } from "../../foundation/wire.mjs";
import { shape, str } from "../requests.mjs";
import { resolveTask } from "../task-view.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
//
// `after` is a revision, and a revision arrives as a *string* because it is read
// off the query string — the handler is what parses it.
//
// `order` is the drawer's read: `desc` with `limit` returns the newest N. The
// default stays `asc` because the SSE cursor reads forward by revision; a
// `desc` read with `after` still filters `revision > after`, so it is not a
// "previous page" cursor.
const LIST_QUERY = shape({ after: str(), limit: str(), order: str() });

/** The board's own cursor values are 64-bit integers; anything larger is a typo. */
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
/** The drawer asks for 50; the whole-trail reads are bounded too. */
const MAX_LIMIT = 1_000;

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

/**
 * A bounded non-negative integer, or `undefined` so the repository default
 * applies. Unlike the shared `intOrUndefined`, a value that is present but
 * unparseable is refused: silently ignoring `?after=nope` would replay the
 * whole trail, and `?limit=-1` reaches SQLite as an unbounded `LIMIT -1`.
 *
 * @param {string|null} raw
 * @param {{field: string, min: number, max: number}} bounds
 * @returns {number|undefined}
 */
function readBoundedInt(raw, { field, min, max }) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number.parseInt(text, 10) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`,
      details: { field, received: raw, min, max },
    });
  }
  return value;
}

/** @param {object} router @param {{board: object}} surface */
export function registerActivityRoutes(router, surface) {
  const { repos } = surface.board;

  router.get("/api/v1/tasks/:ref/activities", ({ params, query }) => {
    const task = resolveTask(repos, params.ref);
    const after = readBoundedInt(query.get("after"), { field: "after", min: 0, max: MAX_REVISION });
    const limit = readBoundedInt(query.get("limit"), { field: "limit", min: 1, max: MAX_LIMIT });
    return {
      task_id: task.id,
      activities: repos.activities
        .list({
          taskId: task.id,
          ...(after === undefined ? {} : { afterRevision: after }),
          ...(limit === undefined ? {} : { limit }),
          order: readOrder(query.get("order")),
        })
        .map(activityToWire),
    };
  }, { query: LIST_QUERY });

  router.get("/api/v1/activities", ({ query }) => {
    const after = readBoundedInt(query.get("after"), { field: "after", min: 0, max: MAX_REVISION });
    const limit = readBoundedInt(query.get("limit"), { field: "limit", min: 1, max: MAX_LIMIT });
    return {
      activities: repos.activities
        .list({
          ...(after === undefined ? {} : { afterRevision: after }),
          ...(limit === undefined ? {} : { limit }),
          order: readOrder(query.get("order")),
        })
        .map(activityToWire),
    };
  }, { query: LIST_QUERY });
}
