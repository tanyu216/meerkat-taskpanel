/**
 * Dictionary reads (§4.4) — the *only* dictionary endpoint there is.
 *
 * No create, no rename, no delete: the dictionary grows when a task names
 * somebody new. That is a product decision, and the shortest way to keep it is
 * to have nowhere to hook a management UI into.
 *
 * One endpoint since `0019`: there is one actor table, so `assignees` and
 * `reporters` stopped being two resources and became two roles a card fills. The
 * read returns the whole dictionary; a client that wants "who can I assign"
 * filters what it gets (the role is a property of the `task` column, not of the
 * actor).
 */

import { dictionaryEntryToWire } from "../../shared/wire.mjs";
import { intOrUndefined, shape, str } from "../requests.mjs";

// The declared request schema the read takes — frozen by the contract snapshot
// (`routes[].request`); see `src/server/requests.mjs`.
const LIST_QUERY = shape({ q: str(), limit: str() });

/** @param {object} router @param {{board: object}} surface */
export function registerDictionaryRoutes(router, surface) {
  const { commands } = surface.board;

  const list = (run) => ({ query }) => ({
    entries: run({
      ...(query.get("q") === null ? {} : { q: query.get("q") }),
      ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
    }).map(dictionaryEntryToWire),
  });

  router.get("/api/v1/actors", list((input) => commands.listActors(input)), { query: LIST_QUERY });
}
