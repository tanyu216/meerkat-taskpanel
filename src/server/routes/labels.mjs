/**
 * Label reads (§4.4, F6-A) — the *only* label endpoint there is.
 *
 * The registry grows when a task names a label and the GC prunes it; there is no
 * create, rename or delete to expose. `GET /api/v1/labels?q=&project_id=` is the
 * read the CLI's `labels list` and, later, a board's autocomplete both use — the
 * same shape as the assignee/reporter reads next door.
 */

import { labelToWire } from "../../shared/wire.mjs";
import { shape, str } from "../requests.mjs";
import { intOrUndefined, truthy } from "./projects.mjs";

// Declared request schema, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
const LIST_QUERY = shape({ project_id: str(), q: str(), limit: str(), include_archived: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerLabelRoutes(router, surface) {
  const { commands } = surface.board;

  router.get("/api/v1/labels", ({ query }) => ({
    labels: commands
      .listLabels({
        ...(query.get("project_id") === null ? {} : { projectId: query.get("project_id") }),
        ...(query.get("q") === null ? {} : { q: query.get("q") }),
        ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
        includeArchived: truthy(query.get("include_archived")),
      })
      .map(labelToWire),
  }), { query: LIST_QUERY });
}
