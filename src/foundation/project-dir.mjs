/**
 * The agent-local project → directory map — the *rule* behind `projects.json`
 * (the file that lives beside the installed skill).
 *
 * The board holds no directory (O3): a board project is an id, a name and an
 * identifier prefix, and nothing else. "Which directory does work for this
 * project happen in?" is decided **locally, per agent kind**, by `projects.json`, and
 * `skills/meerkat-taskpanel/references/projects-json.md` documents it. This
 * module is that document in code, so the `taskctl` shim, the poll pass and the
 * tests all read one map the same way — and a project with no mapped directory
 * is a loud, coded answer instead of a silent guess.
 *
 * The directory is a **worker's** directory, not a data location: taskpanel
 * neither stores nor cares where a project keeps its results. Two keys may name
 * it, in one order — `local_path` (the project's own directory) then `run_dir`
 * (the launch pad a project with no directory of its own gives its workers):
 *
 *     dir = local_path ?? run_dir
 *
 * Three answers come out of that, and they stay distinguishable:
 *
 *   * a usable directory → `{ok: true, dir}`;
 *   * an entry that names **none** → `{ok: true, dir: null}`. That is a
 *     complete answer for a project that has no local directory at all (an
 *     operations project may never touch the disk), not a missing one;
 *   * **no entry** for the identity → `UNMAPPED`, the documented "no directory
 *     is registered — stop and ask the user" failure.
 *
 * Whatever key answers, it is **validated**: absolute, exists, is a directory.
 * Any of the three failing is a failure, not a fallback — a supplied-but-blank
 * value never quietly falls through to the other key either (`??`, deliberately
 * not `||`), because running a worker in the wrong directory is exactly the bug
 * this exists to prevent. So is an unusable `run_dir`.
 *
 * `run_dir` is **never** used in the other direction: the directory → project
 * lookup (`references/projects-json.md` §How a directory resolves to a project)
 * reads `local_path` only. A launch pad can be a generic place — an inbox,
 * `$HOME` — and must not claim every directory under it.
 *
 * The rules are pure and the filesystem is injected (`inspect`), so every branch
 * is exercised without touching a disk — the split `src/foundation/scheduling.mjs`
 * already uses for the supervisor's decision half.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { repoRoot } from "./runtime-locator.mjs";

/**
 * Point an installed shim at the map beside its skill — the shim lives in
 * `<agent-dir>/bin/`, one level under the skill directory, and the poll pass is
 * handed the same path. An explicit value always wins, so a user with a second
 * board can point at it.
 */
export const PROJECTS_JSON_ENV = "MEERKAT_TASKPANEL_PROJECTS_JSON";

/** Every way a directory can fail to be usable, as a stable code. */
export const PROJECT_DIR_CODES = Object.freeze({
  /**
   * A key that was handed over is not a usable path — blank, the wrong type —
   * or a caller needed a directory to run in and the entry names none.
   * An entry that simply *omits* both keys is not this: that is the documented
   * "this project has no local directory" answer.
   */
  REQUIRED: "PROJECT_DIR_REQUIRED",
  /** A relative path: a directory the board would have to interpret. Never allowed. */
  NOT_ABSOLUTE: "PROJECT_DIR_NOT_ABSOLUTE",
  /** An absolute path that is not there (a moved or deleted checkout). */
  MISSING: "PROJECT_DIR_MISSING",
  /** There, but a file — or something else that is not a directory. */
  NOT_A_DIRECTORY: "PROJECT_DIR_NOT_A_DIRECTORY",
  /** The project has no entry in the map: a complete answer, not a missing one. */
  UNMAPPED: "PROJECT_DIR_UNMAPPED",
  /** The map itself is absent or is not the documented shape. */
  MAP_UNREADABLE: "PROJECT_MAP_UNREADABLE",
});

/**
 * What a path is, for the validator. Kept to the four answers the rules care
 * about, so a test can inject any of them without a filesystem.
 *
 * @param {string} path
 * @returns {"directory"|"file"|"missing"|"other"}
 */
export function inspectPath(path) {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch (err) {
    return err?.code === "ENOENT" ? "missing" : "other";
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{project?: string|null, path?: string|null, file?: string|null}} [context]
 */
function failure(code, message, context = {}) {
  return {
    ok: false,
    code,
    message,
    ...(context.project === undefined ? {} : { project: context.project }),
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.file === undefined ? {} : { file: context.file }),
  };
}

/**
 * Refuse a directory that cannot be run in — the "usable, absolute, exists, is
 * a directory" rule, in that order, so the message names the *first* thing wrong
 * rather than all of them.
 *
 * This validates **one value** and is deliberately intolerant of `undefined`,
 * `null`, `""` and non-strings: `resolveProjectDir` decides *which* key answers
 * (and whether an entry naming none is the legitimate "no local directory"
 * answer), while the poll pass reuses this function's `REQUIRED` refusal when it
 * needs a launch directory that the entry does not supply.
 *
 * @param {unknown} value the value carried by `local_path` / `run_dir`
 * @param {{inspect?: (path: string) => string, key?: string, project?: string|null, file?: string|null}} [options]
 * @returns {{ok: true, dir: string} | {ok: false, code: string, message: string, project?: string|null, path?: string|null, file?: string|null}}
 */
export function checkTargetDirectory(value, options = {}) {
  const inspect = options.inspect ?? inspectPath;
  const key = options.key ?? "local_path";
  const where = options.file ? ` in ${options.file}` : "";
  const whose = options.project ? ` for project ${options.project}` : "";

  if (typeof value !== "string" || value.trim() === "") {
    return failure(
      PROJECT_DIR_CODES.REQUIRED,
      `no usable directory${whose}${where}: \`${key}\` must be an absolute path that exists and is a directory — ` +
        "or omit `local_path` and `run_dir` to say this project has no local directory.",
      { project: options.project ?? null, path: null, file: options.file ?? null },
    );
  }

  const dir = value.trim();
  if (!isAbsolute(dir)) {
    return failure(
      PROJECT_DIR_CODES.NOT_ABSOLUTE,
      `\`${key}\`${whose}${where} is not an absolute path: '${dir}'.`,
      { project: options.project ?? null, path: dir, file: options.file ?? null },
    );
  }

  const kind = inspect(dir);
  if (kind === "missing") {
    return failure(
      PROJECT_DIR_CODES.MISSING,
      `\`${key}\`${whose}${where} does not exist: '${dir}'.`,
      { project: options.project ?? null, path: dir, file: options.file ?? null },
    );
  }
  if (kind !== "directory") {
    return failure(
      PROJECT_DIR_CODES.NOT_A_DIRECTORY,
      `\`${key}\`${whose}${where} is not a directory: '${dir}'.`,
      { project: options.project ?? null, path: dir, file: options.file ?? null },
    );
  }

  return { ok: true, dir };
}

/**
 * Parse the map. A malformed file is a failure with a code — never an empty map
 * that would quietly read as "no project is registered".
 *
 * @param {unknown} text
 * @param {{file?: string|null}} [options]
 * @returns {{ok: true, entries: object[], file: string|null} | {ok: false, code: string, message: string, file?: string|null}}
 */
export function parseProjectMap(text, options = {}) {
  const file = options.file ?? null;
  const where = file ? ` (${file})` : "";

  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch (err) {
    return failure(PROJECT_DIR_CODES.MAP_UNREADABLE, `the project map${where} is not valid JSON: ${err?.message ?? err}`, { file });
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
    return failure(PROJECT_DIR_CODES.MAP_UNREADABLE, `the project map${where} needs a \`projects\` array.`, { file });
  }

  // Entries that are not objects are dropped rather than raising: the file is
  // hand-written, and one stray string must not take the whole map down.
  const entries = parsed.projects.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry));
  return { ok: true, entries, file };
}

/**
 * A board project identity → the directory work for it happens in.
 *
 * The identity is matched against each entry's `project` — the board project's
 * **id** (what `issue create --project <id>` takes and what a card carries) or
 * its name, per the document. Which key answers is decided here and nowhere
 * else, in one order: `local_path` (the project's own directory) first, then
 * `run_dir` (the launch pad). `??` and not `||`: a value that is *given* but
 * blank is a failure to report, never a reason to fall through to the other key.
 *
 * An identity matching no entry is `UNMAPPED`: the documented "no directory is
 * registered" answer, which the caller must surface and *ask about*, never
 * paper over with a guess. An entry that exists and names **no** directory is
 * the other, quieter answer — `dir: null` — and callers must tell the two apart.
 *
 * @param {{entries?: object[], project?: unknown, inspect?: (path: string) => string, file?: string|null}} input
 * @returns {{ok: true, dir: string|null, project: string, entry: object} | {ok: false, code: string, message: string, project?: string|null, path?: string|null, file?: string|null}}
 */
export function resolveProjectDir(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const project = typeof input.project === "string" ? input.project.trim() : "";
  const file = input.file ?? null;
  const where = file ? ` (${file})` : "";

  if (project === "") {
    return failure(
      PROJECT_DIR_CODES.UNMAPPED,
      `no project identity was given, so no local directory can be resolved${where}.`,
      { project: null, file },
    );
  }

  const entry = entries.find((candidate) => candidate.project === project);
  if (entry === undefined) {
    return failure(
      PROJECT_DIR_CODES.UNMAPPED,
      `no local directory is registered for project ${project}${where}.`,
      { project, file },
    );
  }

  // `null` and a missing key are the same thing here ("this entry does not name
  // that directory"); anything else is a supplied value and gets validated.
  const localPath = entry.local_path ?? null;
  const runDir = entry.run_dir ?? null;
  const key = localPath !== null ? "local_path" : runDir !== null ? "run_dir" : null;

  if (key === null) {
    // The entry exists and names no directory: a complete answer for a project
    // that has none (an operations project needs no checkout), not a failure.
    return { ok: true, dir: null, project, entry };
  }

  const checked = checkTargetDirectory(entry[key], {
    ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
    key,
    project,
    file,
  });
  if (!checked.ok) return checked;
  return { ok: true, dir: checked.dir, project, entry };
}

/**
 * The map beside the installed skill, unless a flag or the environment names
 * another one. An explicit value always wins, so a user with a second board can
 * point at it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} an absolute path
 */
export function defaultProjectsJson(env = process.env) {
  const fromEnv = env[PROJECTS_JSON_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve(repoRoot(), "skills", "meerkat-taskpanel", "projects.json");
}

/**
 * The directory a **woken worker** must run in, or a coded refusal.
 *
 * This is the wake shape, not the `project dir` answer: a wake is started
 * *somewhere*, so the map's `dir: null` ("this project has no local directory")
 * is refused with `PROJECT_DIR_REQUIRED` rather than passed on. A caller that
 * only wants to report "no directory" keeps using `resolveProjectDir`.
 *
 * The map text is read through an injected `read`, so the rule is testable
 * without a disk. It never asks a board: the directory is a host-local fact.
 *
 * @param {{
 *   project?: unknown,
 *   projectsJson?: string,
 *   env?: NodeJS.ProcessEnv,
 *   read?: (path: string, encoding: string) => string,
 *   inspect?: (path: string) => string,
 * }} [input]
 * @returns {{ok: true, dir: string} | {ok: false, code: string, message: string, project?: string|null, path?: string|null, file?: string|null}}
 */
export function resolveWakeDir(input = {}) {
  const read = input.read ?? readFileSync;
  const projectsJson = input.projectsJson ?? defaultProjectsJson(input.env ?? process.env);
  const where = projectsJson ? ` at ${projectsJson}` : "";

  let text;
  try {
    text = read(projectsJson, "utf8");
  } catch (err) {
    return failure(
      PROJECT_DIR_CODES.MAP_UNREADABLE,
      `cannot read the project map${where} (${err?.code ?? err?.message ?? "unknown error"}). ` +
        `Create it beside the installed skill — see references/projects-json.md — or point ` +
        `${PROJECTS_JSON_ENV} / --projects-json at it.`,
      { file: projectsJson },
    );
  }

  const map = parseProjectMap(text, { file: projectsJson });
  if (!map.ok) return map;

  const resolved = resolveProjectDir({
    entries: map.entries,
    project: input.project,
    file: projectsJson,
    ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
  });
  if (!resolved.ok) return resolved;

  // A worker is started *somewhere*: the map's "no directory" answer is a
  // complete answer for `project dir`, but not for a wake.
  if (resolved.dir === null) {
    return checkTargetDirectory(undefined, {
      project: typeof input.project === "string" ? input.project : null,
      file: projectsJson,
      ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
    });
  }

  return { ok: true, dir: resolved.dir };
}
