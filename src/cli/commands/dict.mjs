/**
 * `assignees list` / `reporters list` (A5, §4.4).
 *
 * Read-only, and the *group* is read-only in a structural sense too: there is no
 * `assignees add`, no `assignees rm`, no `assignees rename`. The dictionary
 * grows when a task names somebody new (`--assignee "<text>"`), and that is the
 * whole interface. A caller who tries anyway gets a usage error, because the
 * command does not exist — this is the contract, not an oversight.
 */

import { table } from "../output/human.mjs";

/** The two groups differ only in which read they call. */
function listCommand(group, kind, endpoint, summary) {
  return {
    name: "list",
    summary,
    usage: `${group} list [--query <text>] [--limit <n>]`,
    positionals: [],
    flags: [
      { flag: "query", key: "query", as: "string", value: "<text>", summary: "Substring match on name." },
      { flag: "limit", key: "limit", as: "number", value: "<n>" },
    ],
    async run(ctx) {
      const { entries } = await ctx.client.get(endpoint, {
        query: { q: ctx.flags.query, limit: ctx.flags.limit },
      });
      const human = entries.length === 0
        ? `no ${group}`
        : table(["display_name", "id", "kind", "used"], entries.map((e) => [
            e.display_name,
            e.id,
            e.kind,
            e.use_count,
          ]));
      return { data: { [group]: entries, entries, kind }, human };
    },
  };
}

export const COMMANDS = [listCommand("assignees", "assignee", "/api/v1/assignees", "List known assignees.")];
export const REPORTER_COMMANDS = [listCommand("reporters", "reporter", "/api/v1/reporters", "List known reporters.")];
