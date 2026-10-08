/**
 * `labels list` (§4.4, A5).
 *
 * Read-only, and structurally so: there is no `labels add`, no `labels rm`, no
 * `labels rename`. The registry grows when a task names a label, and the GC
 * prunes what stops being named — a caller who tries to manage labels by hand
 * gets a usage error because the command does not exist. That is the contract,
 * not an oversight.
 *
 * The CLI is an HTTP client (it must not open SQLite), so this reads the board's
 * `/api/v1/labels` route.
 */

import { table } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "list",
    summary: "List known labels.",
    usage: "labels list [--query <text>] [--limit <n>]",
    positionals: [],
    flags: [
      { flag: "query", key: "query", as: "string", value: "<text>", summary: "Substring match on label name." },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      const { labels } = await ctx.client.get("/api/v1/labels", {
        query: { q: ctx.flags.query, limit: ctx.flags.limit },
      });
      const human =
        labels.length === 0
          ? "no labels"
          : table(["display_name", "id", "color", "used"], labels.map((label) => [
              label.display_name,
              label.id,
              label.color,
              label.use_count,
            ]));
      return { data: { labels }, human };
    },
  },
];
