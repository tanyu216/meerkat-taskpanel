/**
 * `actors list` (A5, §4.4).
 *
 * Read-only, and the *group* is read-only in a structural sense too: there is no
 * `actors add`, no `actors rm`, no `actors rename`. The dictionary grows when a
 * task names somebody new (`--assignee "<text>"`, `--reporter "<text>"`), and
 * that is the whole interface. A caller who tries anyway gets a usage error,
 * because the command does not exist — this is the contract, not an oversight.
 *
 * One group since `0019`: the two dictionary tables became one `actors` table and
 * `assignee`/`reporter` became roles (the `tasks` column a card fills), so the two
 * list commands merged with the two endpoints.
 */

import { table } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "list",
    summary: "List known actors.",
    usage: "actors list [--query <text>] [--limit <n>]",
    positionals: [],
    flags: [
      { flag: "query", key: "query", as: "string", value: "<text>", summary: "Substring match on name." },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      const { entries } = await ctx.client.get("/api/v1/actors", {
        query: { q: ctx.flags.query, limit: ctx.flags.limit },
      });
      const human = entries.length === 0
        ? "no actors"
        : table(["display_name", "id", "kind", "used"], entries.map((e) => [
            e.display_name,
            e.id,
            e.kind,
            e.use_count,
          ]));
      return { data: { actors: entries, entries }, human };
    },
  },
];
