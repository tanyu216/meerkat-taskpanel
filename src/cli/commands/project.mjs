/**
 * `project create|update|list|readme` (A1/A6).
 *
 * A project is the workspace anchor: its id becomes the identifier prefix
 * (`demo` → `DEMO-0001`), and its `workspace_path` is what `context current`
 * matches a working directory against. `--meta k=v` is repeatable and merges.
 */

import { fields, table } from "../output/human.mjs";

/** `--meta k=v` repeated, in order, as a plain object. */
function metaOf(flags) {
  return flags.meta === undefined ? undefined : flags.meta;
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a project.",
    usage: "project create --id <id> --name <name> --workspace-path <abs> [--meta k=v]…",
    positionals: [],
    flags: [
      { flag: "id", key: "id", as: "string", value: "<id>", required: true, summary: "Project id; also the identifier prefix." },
      { flag: "name", key: "name", as: "string", value: "<name>", required: true },
      { flag: "workspace-path", key: "workspacePath", as: "string", value: "<abs>", required: true, summary: "Absolute path this project owns." },
      { flag: "meta", key: "meta", as: "kv", summary: "Repeatable key=value metadata." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
    ],
    async run(ctx) {
      const { project } = await ctx.client.post("/api/v1/projects", {
        id: ctx.flags.id,
        name: ctx.flags.name,
        workspace_path: ctx.flags.workspacePath,
        labels: ctx.flags.labels,
        meta: metaOf(ctx.flags),
        readme: ctx.flags.readme,
      });
      return {
        data: { project },
        human: `created project ${project.id}  ${project.name}  ${project.workspace_path}`,
      };
    },
  },

  {
    name: "update",
    summary: "Update a project's name, path, labels, metadata or readme.",
    usage: "project update <id> [--name <name>] [--workspace-path <abs>] [--meta k=v]…",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "name", key: "name", as: "string", value: "<name>" },
      { flag: "workspace-path", key: "workspacePath", as: "string", value: "<abs>" },
      { flag: "meta", key: "meta", as: "kv" },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
    ],
    async run(ctx) {
      const body = {};
      if (ctx.flags.name !== undefined) body.name = ctx.flags.name;
      if (ctx.flags.workspacePath !== undefined) body.workspace_path = ctx.flags.workspacePath;
      if (ctx.flags.meta !== undefined) body.meta = ctx.flags.meta;
      if (ctx.flags.labels !== undefined) body.labels = ctx.flags.labels;
      if (ctx.flags.readme !== undefined) body.readme = ctx.flags.readme;
      const { project } = await ctx.client.patch(`/api/v1/projects/${ctx.args.id}`, body);
      return { data: { project }, human: `updated project ${project.id}` };
    },
  },

  {
    name: "list",
    summary: "List projects.",
    usage: "project list [--include-archived]",
    positionals: [],
    flags: [{ flag: "include-archived", key: "includeArchived", as: "boolean" }],
    async run(ctx) {
      const { projects } = await ctx.client.get("/api/v1/projects", {
        query: { include_archived: ctx.flags.includeArchived === true ? "1" : undefined },
      });
      const human = projects.length === 0
        ? "no projects"
        : table(["id", "name", "workspace_path"], projects.map((p) => [p.id, p.name, p.workspace_path]));
      return { data: { projects }, human };
    },
  },

  {
    name: "readme",
    summary: "Print a project's readme, or set it from text, a file or stdin.",
    usage: "project readme <id> [--set <text> | --file <path|->]",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "set", key: "set", as: "string", value: "<text>", summary: "Set the readme to this text." },
      { flag: "file", key: "file", as: "string", value: "<path|->", summary: "Read the readme from a file, or `-` for stdin." },
    ],
    async run(ctx) {
      const id = ctx.args.id;
      if (ctx.flags.set === undefined && ctx.flags.file === undefined) {
        const { readme } = await ctx.client.get(`/api/v1/projects/${id}/readme`);
        return { data: { readme }, human: readme ?? "" };
      }
      const text = ctx.flags.file === undefined
        ? ctx.flags.set
        : ctx.flags.file === "-"
          ? await ctx.readStdin()
          : await ctx.readFile(ctx.flags.file);
      const { readme } = await ctx.client.put(`/api/v1/projects/${id}/readme`, { readme: text });
      return {
        data: { readme },
        human: fields([["project", id], ["readme", `${readme.length} characters written`]]),
      };
    },
  },
];
