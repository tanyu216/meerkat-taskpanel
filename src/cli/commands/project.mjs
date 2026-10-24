/**
 * `project create|update|list|dir|readme` (A1/A6).
 *
 * A project is the identifier scope: its id becomes the identifier prefix
 * (`demo` → `DEMO-0001`). `--meta k=v` is repeatable and merges.
 *
 * A project owns **no** working directory — the board holds no path for it.
 * Which local directory maps to which project is decided on the agent side (the
 * skill's local `projects.json`), never here. `project dir` is that lookup, and
 * it is a *local read*: a project with no registered directory is a coded
 * failure that asks the user which directory it should be, never a guess. The
 * whole point is that a caller which needs a directory stops instead of
 * continuing somewhere unintended.
 */

import { resolve } from "node:path";

import { DomainError } from "../../foundation/errors.mjs";
import { PROJECTS_JSON_ENV, PROJECT_DIR_CODES, parseProjectMap, resolveProjectDir } from "../../foundation/project-dir.mjs";
import { repoRoot } from "../../foundation/runtime-locator.mjs";
import { fields, table } from "../output/human.mjs";

/** `--meta k=v` repeated, in order, as a plain object. */
function metaOf(flags) {
  return flags.meta === undefined ? undefined : flags.meta;
}

/**
 * Where this machine's map is, in the order a user expects: an explicit flag,
 * then `$MEERKAT_TASKPANEL_PROJECTS_JSON` (what an installed shim points beside
 * its own skill), else the one beside the skill in this checkout.
 */
function projectsJsonPath(env = {}, flag = null) {
  if (typeof flag === "string" && flag.trim() !== "") return resolve(flag);
  const override = env[PROJECTS_JSON_ENV];
  if (typeof override === "string" && override.trim() !== "") return resolve(override);
  return resolve(repoRoot(), "skills", "meerkat-taskpanel", "projects.json");
}

/**
 * Resolve a project identity to the local directory it works in, or raise the
 * documented "nothing is registered" failure.
 *
 * The board is asked first so an unknown *project* is a board error, not a map
 * error: "no such project" and "this project has no directory yet" are different
 * answers, and only the second one is a question for the user.
 */
function resolveDirFor(ctx, id) {
  const file = projectsJsonPath(ctx.env ?? {}, ctx.flags?.projectsJson ?? null);
  let text;
  try {
    text = ctx.readFile(file);
  } catch (err) {
    throw new DomainError("PROJECT_MAP_UNREADABLE", {
      message: `cannot read the local project map at ${file} (${err?.code ?? "unreadable"}).`,
      details: { file },
      hint: { fix: `create ${file} beside the skill with an entry for ${id} — see references/projects-json.md` },
    });
  }

  const map = parseProjectMap(text, { file });
  if (!map.ok) throw new DomainError(map.code, { message: map.message, details: { file } });

  const resolved = resolveProjectDir({ entries: map.entries, project: id, file });
  if (!resolved.ok) {
    // Two different failures, two different things to do about them: a project
    // *absent* from the map is a question for the user (the step stops and asks,
    // references/projects-json.md §Unregistered); an entry that is there but
    // unusable is a registration to fix — or to reduce to "no local directory"
    // by dropping the key, which is a legitimate answer now.
    const fix =
      resolved.code === PROJECT_DIR_CODES.UNMAPPED
        ? `ask which local directory project ${id} works in, then add it to ${file} (references/projects-json.md)`
        : `fix the entry for project ${id} in ${file} — or drop \`local_path\`/\`run_dir\` if this project has no local directory (references/projects-json.md)`;
    throw new DomainError(resolved.code, {
      message: resolved.message,
      details: { project: id, file, ...(resolved.path ? { path: resolved.path } : {}) },
      hint: { fix },
    });
  }
  return { dir: resolved.dir, file };
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a project.",
    usage:
      "project create --id <id> --name <name> [--acceptance auto|off|agent|human] " +
      "[--review-policy required|optional|off] [--reviewer <agent>] [--meta k=v]…",
    positionals: [],
    flags: [
      { flag: "id", key: "id", as: "string", value: "<id>", required: true, summary: "Project id; also the identifier prefix (must be unique across projects after normalization)." },
      { flag: "name", key: "name", as: "string", value: "<name>", required: true },
      { flag: "meta", key: "meta", as: "kv", summary: "Repeatable key=value metadata." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
      {
        flag: "acceptance",
        key: "acceptance",
        as: "string",
        value: "<auto|off|agent|human>",
        summary:
          "The acceptance default for cards created here (default: auto — the creator decides per card).",
      },
      {
        flag: "review-policy",
        key: "reviewPolicy",
        as: "string",
        value: "<required|optional|off>",
        summary: "Legacy spelling of --acceptance (required=agent, off=off, optional=auto).",
      },
      {
        flag: "reviewer",
        key: "reviewer",
        as: "string",
        value: "<agent>",
        summary: "Reviewer for this project; empty uses the deployment-level reviewer.",
      },
    ],
    async run(ctx) {
      const { project } = await ctx.client.post("/api/v1/projects", {
        id: ctx.flags.id,
        name: ctx.flags.name,
        labels: ctx.flags.labels,
        meta: metaOf(ctx.flags),
        readme: ctx.flags.readme,
        acceptance: ctx.flags.acceptance,
        review_policy: ctx.flags.reviewPolicy,
        reviewer: ctx.flags.reviewer,
      });
      return {
        data: { project },
        human: `created project ${project.id}  ${project.name}  acceptance=${project.acceptance}`,
      };
    },
  },

  {
    name: "ensure",
    summary: "Create a project if it does not exist; leave an existing one untouched.",
    usage:
      "project ensure <id> [--name <name>] [--acceptance auto|off|agent|human] " +
      "[--review-policy required|optional|off] " +
      "[--reviewer <agent>] [--meta k=v]… [--label <label>]… [--readme <text>]",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "name", key: "name", as: "string", value: "<name>", summary: "Required only when the project does not exist yet." },
      { flag: "meta", key: "meta", as: "kv", summary: "Repeatable key=value metadata (used only on creation)." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
      {
        flag: "acceptance",
        key: "acceptance",
        as: "string",
        value: "<auto|off|agent|human>",
        summary: "Acceptance default for a newly created project (default: auto).",
      },
      {
        flag: "review-policy",
        key: "reviewPolicy",
        as: "string",
        value: "<required|optional|off>",
        summary: "Legacy spelling of --acceptance.",
      },
      {
        flag: "reviewer",
        key: "reviewer",
        as: "string",
        value: "<agent>",
        summary: "Reviewer for a newly created project; empty uses the deployment-level reviewer.",
      },
    ],
    async run(ctx) {
      const { project, created } = await ctx.client.put(
        `/api/v1/projects/${encodeURIComponent(ctx.args.id)}`,
        {
          name: ctx.flags.name,
          labels: ctx.flags.labels,
          meta: metaOf(ctx.flags),
          readme: ctx.flags.readme,
          acceptance: ctx.flags.acceptance,
          review_policy: ctx.flags.reviewPolicy,
          reviewer: ctx.flags.reviewer,
        },
      );
      return {
        data: { project, created },
        human: created
          ? `created project ${project.id}  ${project.name}  acceptance=${project.acceptance}`
          : `project ${project.id} already exists  ${project.name}`,
      };
    },
  },

  {
    name: "update",
    summary: "Update a project's name, labels, metadata, readme, acceptance default or reviewer.",
    usage:
      "project update <id> [--name <name>] [--acceptance auto|off|agent|human] " +
      "[--review-policy required|optional|off] [--reviewer <agent>] [--meta k=v]…",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "name", key: "name", as: "string", value: "<name>" },
      { flag: "meta", key: "meta", as: "kv" },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
      {
        flag: "acceptance",
        key: "acceptance",
        as: "string",
        value: "<auto|off|agent|human>",
        summary: "Change the acceptance default; it affects future cards only.",
      },
      {
        flag: "review-policy",
        key: "reviewPolicy",
        as: "string",
        value: "<required|optional|off>",
        summary: "Legacy spelling of --acceptance.",
      },
      {
        flag: "reviewer",
        key: "reviewer",
        as: "string",
        value: "<agent>",
        summary: "Set this project's reviewer; pass an empty value to fall back to the deployment one.",
      },
    ],
    async run(ctx) {
      const body = {};
      if (ctx.flags.name !== undefined) body.name = ctx.flags.name;
      if (ctx.flags.meta !== undefined) body.meta = ctx.flags.meta;
      if (ctx.flags.labels !== undefined) body.labels = ctx.flags.labels;
      if (ctx.flags.readme !== undefined) body.readme = ctx.flags.readme;
      if (ctx.flags.acceptance !== undefined) body.acceptance = ctx.flags.acceptance;
      if (ctx.flags.reviewPolicy !== undefined) body.review_policy = ctx.flags.reviewPolicy;
      if (ctx.flags.reviewer !== undefined) body.reviewer = ctx.flags.reviewer;
      const { project } = await ctx.client.patch(`/api/v1/projects/${ctx.args.id}`, body);
      return {
        data: { project },
        human: `updated project ${project.id}  acceptance=${project.acceptance}`,
      };
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
        : table(
            ["id", "name", "acceptance", "reviewer"],
            projects.map((p) => [p.id, p.name, p.acceptance, p.reviewer ?? "-"]),
          );
      return { data: { projects }, human };
    },
  },

  {
    name: "dir",
    summary: "Print the local directory a project's workers run in (from projects.json).",
    usage: "project dir <id> [--projects-json <path>]",
    positionals: [{ name: "id", summary: "Project id (or the name registered in projects.json)." }],
    flags: [
      {
        flag: "projects-json",
        key: "projectsJson",
        as: "string",
        value: "<path>",
        summary: "Project map to read (default: beside the skill, or $MEERKAT_TASKPANEL_PROJECTS_JSON).",
      },
    ],
    async run(ctx) {
      const id = ctx.args.id;
      // Ask the board first, so "unknown project" (a typo, a project from another
      // board) and "known project, no directory registered" (a question for the
      // user) stay distinguishable answers. `GET /projects/:id` answers `null`
      // for a miss rather than raising, so the check is on the payload.
      const { project } = await ctx.client.get(`/api/v1/projects/${id}`);
      if (project === null || project === undefined) {
        throw new DomainError("NOT_FOUND", {
          message: `no project ${id}`,
          details: { project: id },
        });
      }
      const { dir, file } = resolveDirFor(ctx, id);
      // `dir` is `null` when the entry exists and names no directory — a
      // complete answer for a project that has none, so it is not an error and
      // must not be silence either (an exit-0 run that prints nothing reads as
      // a broken pipeline downstream).
      return {
        data: { project: id, dir },
        human: dir ?? `no local directory for project ${id} — the entry in ${file} names no local_path or run_dir`,
      };
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
