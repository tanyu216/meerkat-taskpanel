/**
 * The dictionary reads — and the whole dictionary surface.
 *
 * Three list tools, no create, no rename, no delete, no merge. That is a
 * product decision (§4.4), not a gap: the dictionary grows when a task names
 * somebody new, and `task_create`'s `assignee`/`reporter` arguments are the way
 * in. A management tool would need a management UI, a permission story and a
 * conflict story; the shortest way to avoid needing all three is to have
 * nowhere to hook one.
 *
 * `test/mcp/protocol.test.mjs` proves this structurally rather than by
 * inspection: the advertised tool set must *equal* the frozen list, and a
 * blacklist assertion checks that nothing matching `(assignee|reporter|label)_(create|update|…)`
 * is in it. A tool that was added by accident fails that test.
 */

import { input, integer, string } from "./schema.mjs";

export const DICTIONARY_TOOLS = [
  {
    name: "label_list",
    readOnly: true,
    description:
      "List labels known to the board, with their colours. Labels have no management surface: a label is created by naming it on a task, and pruned when unused.",
    inputSchema: input(
      {
        q: string("Substring match on the label name."),
        project_id: string("Only labels known in this project."),
        limit: integer("Maximum number of labels to return."),
      },
      [],
    ),
    async handler(args, ctx) {
      const { labels } = await ctx.client.get("/api/v1/labels", {
        query: { q: args.q, project_id: args.project_id, limit: args.limit },
      });
      return { payload: { labels } };
    },
  },

  {
    name: "assignee_list",
    readOnly: true,
    description:
      "List assignees known to the board, most recently used first. Assignees are created by naming one on a task; there is no add or rename tool.",
    inputSchema: input(
      {
        q: string("Substring match on the assignee's display name."),
        limit: integer("Maximum number of assignees to return."),
      },
      [],
    ),
    async handler(args, ctx) {
      const { entries } = await ctx.client.get("/api/v1/assignees", { query: { q: args.q, limit: args.limit } });
      return { payload: { assignees: entries } };
    },
  },

  {
    name: "reporter_list",
    readOnly: true,
    description:
      "List reporters known to the board, most recently used first. Reporters are created by naming one on a task; there is no add or rename tool.",
    inputSchema: input(
      {
        q: string("Substring match on the reporter's display name."),
        limit: integer("Maximum number of reporters to return."),
      },
      [],
    ),
    async handler(args, ctx) {
      const { entries } = await ctx.client.get("/api/v1/reporters", { query: { q: args.q, limit: args.limit } });
      return { payload: { reporters: entries } };
    },
  },
];
