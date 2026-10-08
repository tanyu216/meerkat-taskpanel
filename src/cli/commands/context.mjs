/**
 * `context current` (A6, §F-C3).
 *
 * "Which project am I working in?" — answered from the working directory, with
 * ancestor matching (`/tmp/demo/sub` belongs to `/tmp/demo`).
 *
 * A miss returns a **synthetic** `local` project with `matched: false` and does
 * not create a row: reads never write. Creating it for real is one command, and
 * the hint prints that command.
 */

import { fields } from "../output/human.mjs";

export const COMMANDS = [
  {
    name: "current",
    summary: "Show the project that owns the current directory.",
    usage: "context current [--path <dir>]",
    positionals: [],
    flags: [{ flag: "path", key: "path", as: "string", value: "<dir>", summary: "Directory to match (default: cwd)." }],
    async run(ctx) {
      const cwd = ctx.flags.path ?? ctx.cwd;
      const data = await ctx.client.get("/api/v1/projects/current", { query: { path: cwd } });
      const project = data.project;
      const human = data.matched
        ? fields([
            ["project", project.id],
            ["name", project.name],
            ["workspace_path", project.workspace_path],
            ["matched", "true"],
          ])
        : fields([
            ["project", `${project.id} (not a real project yet)`],
            ["workspace_path", project.workspace_path],
            ["matched", "false"],
            ["create it", data.hint.create],
          ]);
      return { data, human };
    },
  },
];
