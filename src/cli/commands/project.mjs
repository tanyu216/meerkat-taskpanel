/**
 * `project create|update|list|dir|map|readme` (A1/A6).
 *
 * A project is the identifier scope: its cards are numbered with a 1-4
 * `A-Z0-9` prefix. `--prefix` declares it (`tp` → `TP-0001`) and beats the id;
 * without one the id supplies it (`demo` → `DEMO-0001`), and a create with
 * neither is refused by the server. `--meta k=v` is repeatable and merges;
 * `--prefix` is sugar over the reserved `meta.prefix` key, so the two spellings
 * must agree.
 *
 * A project owns **no** working directory — the board holds no path for it.
 * Which local directory maps to which project lives in one machine-local
 * `projects.json` at the config root, and `project map` is its only writer.
 * `project dir` is the read: a project with no registered directory is a coded
 * failure that asks the user which directory it should be, never a guess. The
 * whole point is that a caller which needs a directory stops instead of
 * continuing somewhere unintended.
 */

import { spawnSync } from "node:child_process";

import { DomainError } from "../../foundation/errors.mjs";
import { probeGitRef, probeLocalBranch, readCurrentBranch } from "../../foundation/git-ref.mjs";
import {
  PROJECT_DIR_CODES,
  checkTargetDirectory,
  defaultProjectsJson,
  parseProjectMap,
  readProjectMapForEdit,
  removeProjectEntry,
  resolveProjectDir,
  resolveWakeDir,
  upsertProjectEntry,
  writeProjectMap,
} from "../../foundation/project-dir.mjs";
import { fields, table } from "../output/human.mjs";

/** `--meta k=v` repeated, in order, as a plain object. */
function metaOf(flags) {
  return flags.meta === undefined ? undefined : flags.meta;
}

/**
 * `metaOf` with `--prefix <p>` folded in as `meta.prefix`.
 *
 * `--prefix` is the friendly spelling of the one reserved metadata key, so the
 * two must not disagree: a contradiction is a usage error (exit 2) decided here,
 * before any request is sent, while the same value is accepted. Without
 * `--prefix` the meta object comes back untouched, so every other request body
 * stays byte-identical.
 *
 * @param {object} flags
 */
function metaWithPrefix(flags) {
  if (flags.prefix === undefined) return metaOf(flags);
  const declared = flags.meta === undefined ? undefined : flags.meta.prefix;
  if (declared !== undefined && declared !== flags.prefix) {
    throw new DomainError("CLI_USAGE", {
      message:
        `--prefix ${JSON.stringify(flags.prefix)} contradicts --meta prefix=${JSON.stringify(declared)}; ` +
        "they name the same field",
      hint: { fix: "pass the prefix once — with --prefix <p>, or with --meta prefix=<p>" },
    });
  }
  return { ...(flags.meta ?? {}), prefix: flags.prefix };
}

/** The one map every local read and write uses. */
function mapFile(ctx) {
  return defaultProjectsJson(ctx.env ?? {}, { cwd: ctx.cwd });
}

/** The process boundary for the ref probes: the same timeout as the loop's runner. */
function runGit(cmd, argv) {
  try {
    const result = spawnSync(cmd, argv, { encoding: "utf8", timeout: 10_000 });
    if (result.error !== undefined && result.error !== null) return null;
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch {
    return null;
  }
}

const REF_FLAGS = Object.freeze({ base_ref: "--base-ref", merge_ref: "--merge-ref" });

/**
 * Validate one declared ref against the directory it is a promise about.
 * `base_ref` is a commit-ish; `merge_ref` must be a local branch — the loop
 * merges into it, and a tag or a raw commit can never be the checked-out
 * integration branch.
 */
function checkRef({ key, value, dir, file }) {
  const probe =
    key === "base_ref"
      ? probeGitRef({ projectDir: dir, ref: value, run: runGit })
      : probeLocalBranch({ projectDir: dir, ref: value, run: runGit });
  if (probe.ok === true && probe.exists === true) return;

  const why = probe.ok === true
    ? key === "merge_ref"
      ? "it is not a local branch"
      : "it does not resolve to a commit"
    : probe.reason === "unavailable"
      ? "git could not be started"
      : probe.reason === "unresolvable"
        ? `git could not resolve it${probe.stderr ? `: ${probe.stderr}` : ""}`
        : "it is empty";

  throw new DomainError(PROJECT_DIR_CODES.REF_UNRESOLVED, {
    message: `cannot set ${key} to '${value}' in ${dir}: ${why}`,
    details: { key, ref: value, dir, file },
    hint: {
      fix: `check it with \`git -C ${dir} rev-parse --verify ${value}\`, then re-run \`taskctl project map set <id> ${REF_FLAGS[key]} <ref>\``,
    },
  });
}

/**
 * Why a local command fails: the same shape `resolveWakeDir` reports, raised as
 * a domain error so the envelope's `hint.fix` names the next command.
 */
function mapFailure(result, file) {
  return new DomainError(result.code, {
    message: result.message,
    details: { ...(result.project ? { project: result.project } : {}), file },
    hint: { fix: `run \`taskctl project map set <id> --local-path <dir>\` (or \`--run-dir\`), then retry` },
  });
}

/** Read the map for an edit. A missing file is the empty map a first write starts from. */
function readForEdit(ctx, file) {
  const result = readProjectMapForEdit(file, { read: ctx.readFile });
  if (!result.ok) {
    throw new DomainError(result.code, {
      message: result.message,
      details: { file },
      hint: { fix: `fix the JSON at ${file} (or move it aside and register the projects again with taskctl project map set)` },
    });
  }
  return result;
}

/** Write the map, or fail with the documented write code. */
function writeMap(file, projects, root) {
  const result = writeProjectMap(file, projects, { root });
  if (!result.ok) {
    throw new DomainError("PROJECT_MAP_UNWRITABLE", {
      message: result.message,
      details: { file },
      hint: { fix: `set MEERKAT_TASKPANEL_CONFIG_DIR to a writable directory, or fix the permissions of ${file}` },
    });
  }
}

/** @param {string} message */
function usageError(message) {
  return new DomainError("CLI_USAGE", { message, hint: { fix: "run `taskctl project map --help`" } });
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
  const file = mapFile(ctx);
  let text;
  try {
    text = ctx.readFile(file);
  } catch (err) {
    throw new DomainError("PROJECT_MAP_UNREADABLE", {
      message: `cannot read the local project map at ${file} (${err?.code ?? "unreadable"}).`,
      details: { file },
      hint: { fix: `register project ${id} with \`taskctl project map set ${id} --local-path <dir>\` — see references/projects-json.md` },
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
    // with `project map set --no-dir`, which is a legitimate answer now.
    const fix =
      resolved.code === PROJECT_DIR_CODES.UNMAPPED
        ? `ask which local directory project ${id} works in, then register it with \`taskctl project map set ${id} --local-path <dir>\``
        : `fix the entry for project ${id} with \`taskctl project map set ${id} --local-path <dir>\` — or use --no-dir if this project has no local directory (references/projects-json.md)`;
    throw new DomainError(resolved.code, {
      message: resolved.message,
      details: { project: id, file, ...(resolved.path ? { path: resolved.path } : {}) },
      hint: { fix },
    });
  }
  return { dir: resolved.dir, file };
}

/**
 * `project map <action> [id] [--local-path|--run-dir|--no-dir]` — the local
 * map, read and written without a board, a token or an identity.
 *
 * All four actions are local by construction (`local: true`); nothing here can
 * send a directory to `taskd`. `set` validates the directory first and never
 * overwrites a file it could not parse; `remove` and `show` on an absent entry
 * are the documented `PROJECT_DIR_UNMAPPED` refusal.
 */
function runProjectMap(ctx) {
  const action = ctx.args.action ?? "";
  const id = typeof ctx.args.id === "string" ? ctx.args.id.trim() : "";
  const hasLocalPath = ctx.flags.localPath !== undefined;
  const hasRunDir = ctx.flags.runDir !== undefined;
  const noDir = ctx.flags.noDir === true;
  const hasBaseRef = ctx.flags.baseRef !== undefined;
  const hasMergeRef = ctx.flags.mergeRef !== undefined;
  const noBaseRef = ctx.flags.noBaseRef === true;
  const noMergeRef = ctx.flags.noMergeRef === true;
  const refFlags = hasBaseRef || hasMergeRef || noBaseRef || noMergeRef;
  const modes = [hasLocalPath, hasRunDir, noDir].filter(Boolean).length;
  const file = mapFile(ctx);

  if (!["list", "show", "set", "remove"].includes(action)) {
    throw usageError(`unknown action '${action}' — expected list, show, set or remove`);
  }

  if (action === "list") {
    if (id !== "" || modes > 0 || refFlags) {
      throw usageError("`project map list` takes no project id and no directory or ref flag");
    }
    const map = readForEdit(ctx, file);
    const entries = map.projects.filter(
      (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );
    const human = entries.length === 0
      ? `no project is registered in ${file}`
      : table(
          ["project", "local_path", "run_dir"],
          entries.map((entry) => [
            entry.project ?? "-",
            entry.local_path ?? "-",
            entry.run_dir ?? "-",
          ]),
        );
    return { data: { file, present: map.present, projects: map.projects }, human };
  }

  if (id === "") throw usageError(`\`project map ${action}\` needs a project id`);
  if (action !== "set" && (modes > 0 || refFlags)) {
    throw usageError(`\`project map ${action}\` takes no directory or ref flag`);
  }

  if (action === "show") {
    const map = readForEdit(ctx, file);
    const resolved = resolveProjectDir({ entries: map.projects, project: id, file });
    if (!resolved.ok) throw mapFailure(resolved, file);
    const entry = resolved.entry;
    const human = resolved.dir === null
      ? `project ${id} is registered in ${file} with no local directory` +
        ` (base_ref=${entry.base_ref ?? "-"}, merge_ref=${entry.merge_ref ?? "-"})`
      : fields([
          ["project", id],
          ["local_path", entry.local_path ?? "-"],
          ["run_dir", entry.run_dir ?? "-"],
          ["dir", resolved.dir],
          ["base_ref", entry.base_ref ?? "-"],
          ["merge_ref", entry.merge_ref ?? "-"],
        ]);
    return { data: { file, project: id, entry, dir: resolved.dir }, human };
  }

  if (action === "set") {
    if (modes > 1) {
      throw usageError(
        "`project map set` takes at most one of --local-path <dir>, --run-dir <dir> or --no-dir",
      );
    }
    if (modes + [hasBaseRef, hasMergeRef, noBaseRef, noMergeRef].filter(Boolean).length === 0) {
      throw usageError(
        "`project map set` needs at least one of --local-path <dir>, --run-dir <dir>, --no-dir, " +
          "--base-ref <ref>, --merge-ref <ref>, --no-base-ref or --no-merge-ref",
      );
    }
    if (hasBaseRef && noBaseRef) throw usageError("`--base-ref` and `--no-base-ref` are mutually exclusive");
    if (hasMergeRef && noMergeRef) throw usageError("`--merge-ref` and `--no-merge-ref` are mutually exclusive");
    if (noDir && refFlags) {
      throw usageError(
        "`--no-dir` cannot be combined with a ref flag: a ref needs a directory to validate against",
      );
    }

    const map = readForEdit(ctx, file);
    const mode = hasLocalPath ? { key: "local_path", value: ctx.flags.localPath } : hasRunDir ? { key: "run_dir", value: ctx.flags.runDir } : null;
    let dir = null;
    if (mode !== null) {
      const checked = checkTargetDirectory(mode.value, { key: mode.key, project: id, file });
      if (!checked.ok) throw mapFailure(checked, file);
      dir = checked.dir;
    } else if (!noDir) {
      const resolved = resolveProjectDir({ entries: map.projects, project: id, file });
      if (!resolved.ok) throw mapFailure(resolved, file);
      dir = resolved.dir;
    }

    // A ref is a promise about a checkout; without one there is nothing to probe.
    // Clearing a rule (`--no-base-ref` / `--no-merge-ref`) needs no directory.
    if ((hasBaseRef || hasMergeRef) && (dir === null || dir === undefined)) {
      throw new DomainError(PROJECT_DIR_CODES.REQUIRED, {
        message: `project ${id} has no local directory, so a ref cannot be validated`,
        details: { project: id, file },
        hint: {
          fix: `register the directory first: \`taskctl project map set ${id} --local-path <dir> --base-ref <ref> --merge-ref <ref>\``,
        },
      });
    }

    // `--no-dir` on an entry that carries refs would leave rules pointing at
    // nothing. Make the operator clear them explicitly, never silently.
    if (noDir) {
      const existing = map.projects.find(
        (entry) => entry !== null && typeof entry === "object" && entry.project === id,
      );
      if (existing && (existing.base_ref !== undefined || existing.merge_ref !== undefined)) {
        throw new DomainError("CLI_USAGE", {
          message: `project ${id} still declares base_ref/merge_ref; --no-dir would leave them pointing at nothing`,
          details: { project: id, file },
          hint: {
            fix: `clear them first: \`taskctl project map set ${id} --no-base-ref --no-merge-ref\`, then retry --no-dir`,
          },
        });
      }
    }

    const baseRef = hasBaseRef ? String(ctx.flags.baseRef).trim() : undefined;
    const mergeRef = hasMergeRef ? String(ctx.flags.mergeRef).trim() : undefined;
    if (baseRef !== undefined) checkRef({ key: "base_ref", value: baseRef, dir, file });
    if (mergeRef !== undefined) checkRef({ key: "merge_ref", value: mergeRef, dir, file });

    const warnings = [];
    if (mergeRef !== undefined) {
      const current = readCurrentBranch({ projectDir: dir, run: runGit });
      if (current.ok === true && current.ref !== mergeRef) {
        warnings.push(
          `${dir} is on ${current.ref}, but merge_ref is ${mergeRef}; landing will refuse until it is checked out`,
        );
      }
    }

    const updated = upsertProjectEntry(map.projects, {
      project: id,
      // Store the validated (trimmed) path, not the raw token.
      ...(hasLocalPath ? { localPath: dir } : {}),
      ...(hasRunDir ? { runDir: dir } : {}),
      ...(noDir ? { noDir: true } : {}),
      ...(baseRef !== undefined ? { baseRef } : {}),
      ...(noBaseRef ? { noBaseRef: true } : {}),
      ...(mergeRef !== undefined ? { mergeRef } : {}),
      ...(noMergeRef ? { noMergeRef: true } : {}),
    });
    writeMap(file, updated.entries, map.root);

    const parts = [];
    if (hasLocalPath) parts.push(`local_path=${dir}`);
    if (hasRunDir) parts.push(`run_dir=${dir}`);
    if (noDir) parts.push("no local directory");
    if (baseRef !== undefined) parts.push(`base_ref=${baseRef}`);
    if (noBaseRef) parts.push("base_ref cleared");
    if (mergeRef !== undefined) parts.push(`merge_ref=${mergeRef}`);
    if (noMergeRef) parts.push("merge_ref cleared");
    const human = `project ${id}: ${parts.join(", ")} in ${file}`;
    return {
      data: { file, project: id, entry: updated.entry, dir, created: updated.created },
      human,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // remove
  const map = readForEdit(ctx, file);
  const removed = removeProjectEntry(map.projects, id);
  if (removed.removed === 0) throw mapFailure({ code: PROJECT_DIR_CODES.UNMAPPED, message: `no local directory is registered for project ${id} (${file}).`, project: id }, file);
  writeMap(file, removed.entries, map.root);
  const human = removed.removed === 1
    ? `project ${id}: removed from ${file}`
    : `project ${id}: removed ${removed.removed} entries from ${file}`;
  return { data: { file, project: id, removed: removed.removed }, human };
}

export const COMMANDS = [
  {
    name: "create",
    summary: "Create a project.",
    usage:
      "project create [--id <id>] [--prefix <p>] --name <name> [--meta k=v]…",
    positionals: [],
    flags: [
      { flag: "id", key: "id", as: "string", value: "<id>", summary: "Project id; also the identifier prefix when --prefix is absent (must be unique across projects after normalization). Optional when --prefix is declared — the server mints an id." },
      {
        flag: "prefix",
        key: "prefix",
        as: "string",
        value: "<p>",
        summary:
          "Identifier prefix for the project's cards: 1-4 characters of A-Z and 0-9 (normalized). Beats the id-derived prefix; needed only when no valid id supplies one.",
      },
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
        meta: metaWithPrefix(ctx.flags),
        readme: ctx.flags.readme,
      });
      return {
        data: { project },
        human: `created project ${project.id}  ${project.name}`,
      };
    },
  },

  {
    name: "ensure",
    summary: "Create a project if it does not exist; leave an existing one untouched.",
    usage:
      "project ensure <id> [--name <name>] [--prefix <p>] " +
      "[--meta k=v]… [--label <label>]… [--readme <text>]",
    positionals: [{ name: "id", summary: "Project id." }],
    flags: [
      { flag: "name", key: "name", as: "string", value: "<name>", summary: "Required only when the project does not exist yet." },
      {
        flag: "prefix",
        key: "prefix",
        as: "string",
        value: "<p>",
        summary:
          "Identifier prefix for a project this call creates: 1-4 characters of A-Z and 0-9 (normalized). Beats the id-derived prefix; ignored for an existing project.",
      },
      { flag: "meta", key: "meta", as: "kv", summary: "Repeatable key=value metadata (used only on creation)." },
      { flag: "label", key: "labels", as: "string", value: "<label>", repeat: true },
      { flag: "readme", key: "readme", as: "string", value: "<text>" },
    ],
    async run(ctx) {
      const { project, created } = await ctx.client.put(
        `/api/v1/projects/${encodeURIComponent(ctx.args.id)}`,
        {
          name: ctx.flags.name,
          labels: ctx.flags.labels,
          meta: metaWithPrefix(ctx.flags),
          readme: ctx.flags.readme,
        },
      );
      return {
        data: { project, created },
        human: created
          ? `created project ${project.id}  ${project.name}`
          : `project ${project.id} already exists  ${project.name}`,
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
      return {
        data: { project },
        human: `updated project ${project.id}`,
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
            ["id", "name"],
            projects.map((p) => [p.id, p.name]),
          );
      return { data: { projects }, human };
    },
  },

  {
    name: "map",
    summary: "Read or edit the machine-local project → directory map (never the board).",
    usage:
      "project map list | show <id> | set <id> [--local-path <dir> | --run-dir <dir> | --no-dir] " +
      "[--base-ref <ref> | --no-base-ref] [--merge-ref <ref> | --no-merge-ref] | remove <id>",
    positionals: [
      { name: "action", summary: "list | show | set | remove." },
      { name: "id", required: false, summary: "Project id; required for show, set and remove." },
    ],
    // Local by construction: no identity, no token, no board session. Nothing a
    // directory does here can reach `taskd`.
    local: true,
    flags: [
      {
        flag: "local-path",
        key: "localPath",
        as: "string",
        value: "<dir>",
        summary: "Register the project's own directory (absolute, existing, a directory).",
      },
      {
        flag: "run-dir",
        key: "runDir",
        as: "string",
        value: "<dir>",
        summary: "Register the launch directory for a project with no checkout of its own.",
      },
      {
        flag: "no-dir",
        key: "noDir",
        as: "boolean",
        summary: "Register the project with no local directory (clears local_path and run_dir).",
      },
      {
        flag: "base-ref",
        key: "baseRef",
        as: "string",
        value: "<ref>",
        summary: "The ref a card's worktree branches from (loop-only; validated in the registered directory).",
      },
      {
        flag: "no-base-ref",
        key: "noBaseRef",
        as: "boolean",
        summary: "Clear the project's declared base_ref.",
      },
      {
        flag: "merge-ref",
        key: "mergeRef",
        as: "string",
        value: "<ref>",
        summary: "The local branch acceptance merges into (loop-only; must be a local branch).",
      },
      {
        flag: "no-merge-ref",
        key: "noMergeRef",
        as: "boolean",
        summary: "Clear the project's declared merge_ref.",
      },
    ],
    run: runProjectMap,
  },

  {
    name: "dir",
    summary: "Print the local directory a project's workers run in (from projects.json).",
    usage: "project dir <id> [--require-dir]",
    positionals: [{ name: "id", summary: "Project id (or the name registered in projects.json)." }],
    // `--require-dir` is the wake shape: map-only, no identity, no board. The
    // dispatcher runs it on the local path so a wake still works with the board
    // down; without the flag this stays an ordinary board command.
    localWhen: (parsed) => parsed.flags.requireDir === true,
    flags: [
      {
        flag: "require-dir",
        key: "requireDir",
        as: "boolean",
        summary:
          "Resolve from the project map only (no board check); exit 3 when no directory is registered — the wake shape.",
      },
    ],
    async run(ctx) {
      const id = ctx.args.id;
      // The wake shape: a worker is started *somewhere*, so this is map-only and
      // a `dir: null` / unmapped answer is a no-verdict exit 3, not a success.
      // It deliberately does not ask the board: a wake must work with the board
      // down, and the directory is a host-local fact.
      if (ctx.flags.requireDir === true) {
        const file = mapFile(ctx);
        const resolved = resolveWakeDir({ project: id, projectsJson: file, read: ctx.readFile });
        if (!resolved.ok) {
          return {
            data: { project: id, dir: null, code: resolved.code, message: resolved.message, file },
            human: "",
            warnings: [`${resolved.code}: ${resolved.message}`],
            exit: 3,
          };
        }
        return { data: { project: id, dir: resolved.dir }, human: resolved.dir };
      }
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
