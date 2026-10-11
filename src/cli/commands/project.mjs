/**
 * `project create|update|list|readme` (A1/A6).
 *
 * A project is the identifier scope: its id becomes the identifier prefix
 * (`demo` → `DEMO-0001`). `--meta k=v` is repeatable and merges.
 *
 * A project owns **no** working directory — the board holds no path for it.
 * Which local directory maps to which project is decided on the agent side (the
 * skill's local `projects.json`), never here.
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
    usage: "project create --id <id> --name <name> [--meta k=v]…",
    positionals: [],
    flags: [
      { flag: "id", key: "id", as: "string", value: "<id>", required: true, summary: "Project id; also the identifier prefix." },
      { flag: "name", key: "name", as: "string", value: "<name>", required: true },
      { flag: "meta", key: "meta", as: "kv", summary: "Repeatable key=value metadata." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
    ],
    async run(ctx) {
      const { project } = await ctx.client.post("/api/v1/projects", {
        id: ctx.flags.id,
        name: ctx.flags.name,
        labels: ctx.flags.labels,
        meta: metaOf(ctx.flags),
        readme: ctx.flags.readme,
      });
      return {
        data: { project },
        human: `created project ${project.id}  ${project.name}`,
      };
    },
  },

  {
    name: "update",
    summary: "Update a project's name, labels, metadata or readme.",
    usage: "project update <id> [--name <name>] [--meta k=v]…",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "name", key: "name", as: "string", value: "<name>" },
      { flag: "meta", key: "meta", as: "kv" },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
    ],
    async run(ctx) {
      const body = {};
      if (ctx.flags.name !== undefined) body.name = ctx.flags.name;
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
        : table(["id", "name"], projects.map((p) => [p.id, p.name]));
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
