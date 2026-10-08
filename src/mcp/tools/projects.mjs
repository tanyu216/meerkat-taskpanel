/**
 * `project_list` — the one project tool.
 *
 * Reads only. `project create/update` exist on the HTTP surface, but they are
 * *setup*: a project is created once, by the person who owns the working
 * directory, and it carries a workspace path that has to exist on this machine.
 * An agent mid-task does not create projects, and a tool that let it would let a
 * typo fork the board's history. Creating one stays a CLI act.
 *
 * It is nonetheless here rather than omitted, because `task_create` needs a
 * `project_id` and a caller that cannot list projects cannot discover one.
 */

import { boolean, input, string } from "./schema.mjs";

export const PROJECT_TOOLS = [
  {
    name: "project_list",
    readOnly: true,
    description:
      "List the board's projects. A task must belong to one, so this is how a caller discovers the project_id that task_create needs.",
    inputSchema: input(
      { include_archived: boolean("Include archived projects (default false).") },
      [],
    ),
    async handler(args, ctx) {
      const { projects } = await ctx.client.get("/api/v1/projects", {
        query: { include_archived: args.include_archived },
      });
      return { payload: { projects } };
    },
  },
];
