/**
 * Dictionary reads (§4.4) — the *only* dictionary endpoints there are.
 *
 * No create, no rename, no delete: the dictionary grows when a task names
 * somebody new. That is a product decision, and the shortest way to keep it is
 * to have nowhere to hook a management UI into.
 */

import { dictionaryEntryToWire } from "../../shared/wire.mjs";
import { intOrUndefined } from "./projects.mjs";

/** @param {object} router @param {{board: object}} surface */
export function registerDictionaryRoutes(router, surface) {
  const { commands } = surface.board;

  const list = (run) => ({ query }) => ({
    entries: run({
      ...(query.get("q") === null ? {} : { q: query.get("q") }),
      ...(intOrUndefined(query.get("limit")) === undefined ? {} : { limit: intOrUndefined(query.get("limit")) }),
    }).map(dictionaryEntryToWire),
  });

  router.get("/api/v1/assignees", list((input) => commands.listAssignees(input)));
  router.get("/api/v1/reporters", list((input) => commands.listReporters(input)));
}
