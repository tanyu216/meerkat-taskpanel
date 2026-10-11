/**
 * The host-local project → directory map — the *rule* behind `projects.json`
 * (the file that lives beside the installed skill).
 *
 * The board holds no directory (O3): a board project is an id, a name and an
 * identifier prefix, and nothing else. "Which directory is this project working
 * in?" is decided **locally, per host**, by `projects.json`, and
 * `skills/meerkat-taskpanel/references/projects-json.md` documents it. This
 * module is that document in code, so the wake glue, `taskctl` and the tests
 * all read one map the same way — and a project with no mapped directory is a
 * loud, coded answer instead of a silent guess.
 *
 * Two jobs over one file:
 *
 *   * **resolve** — a board project identity (`T-…`'s `project` field) → the
 *     local target directory the worker for it must run in;
 *   * **validate** — that directory is absolute, exists, and *is* a directory.
 *     Any of the three failing is a failure, not a fallback: running a worker in
 *     the wrong checkout is exactly the bug this exists to prevent.
 *
 * The rules are pure and the filesystem is injected (`inspect`), so every branch
 * is exercised without touching a disk — the split `src/shared/scheduling.mjs`
 * already uses for the supervisor's decision half.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Point an installed shim / wake glue at the map beside its skill — the shim and
 * the glue both live in `<host-dir>/bin/`, one level under the skill directory.
 * An explicit value always wins, so a user with a second board can point at it.
 */
export const PROJECTS_JSON_ENV = "MEERKAT_TASKPANEL_PROJECTS_JSON";

/** Every way a target directory can fail to be usable, as a stable code. */
export const PROJECT_DIR_CODES = Object.freeze({
  /** No `local_path` in the entry at all — a directory is required, not optional. */
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
 * Refuse a target directory that cannot be run in — the "required, absolute,
 * exists, is a directory" rule, in that order, so the message names the *first*
 * thing wrong rather than all of them.
 *
 * @param {unknown} value the entry's `local_path`
 * @param {{inspect?: (path: string) => string, project?: string|null, file?: string|null}} [options]
 * @returns {{ok: true, dir: string} | {ok: false, code: string, message: string, project?: string|null, path?: string|null, file?: string|null}}
 */
export function checkTargetDirectory(value, options = {}) {
  const inspect = options.inspect ?? inspectPath;
  const where = options.file ? ` in ${options.file}` : "";
  const whose = options.project ? ` for project ${options.project}` : "";

  if (typeof value !== "string" || value.trim() === "") {
    return failure(
      PROJECT_DIR_CODES.REQUIRED,
      `no target directory is registered${whose}${where}: an entry needs an absolute \`local_path\`.`,
      { project: options.project ?? null, path: null, file: options.file ?? null },
    );
  }

  const dir = value.trim();
  if (!isAbsolute(dir)) {
    return failure(
      PROJECT_DIR_CODES.NOT_ABSOLUTE,
      `target directory${whose}${where} is not an absolute path: '${dir}'.`,
      { project: options.project ?? null, path: dir, file: options.file ?? null },
    );
  }

  const kind = inspect(dir);
  if (kind === "missing") {
    return failure(
      PROJECT_DIR_CODES.MISSING,
      `target directory${whose}${where} does not exist: '${dir}'.`,
      { project: options.project ?? null, path: dir, file: options.file ?? null },
    );
  }
  if (kind !== "directory") {
    return failure(
      PROJECT_DIR_CODES.NOT_A_DIRECTORY,
      `target directory${whose}${where} is not a directory: '${dir}'.`,
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
 * A board project identity → the directory its worker must run in.
 *
 * The identity is matched against each entry's `project` — the board project's
 * **id** (what `issue create --project <id>` takes and what a card carries) or
 * its name, per the document. An identity matching no entry is `UNMAPPED`: the
 * documented "no directory is registered" answer, which the caller must surface
 * and *ask about*, never paper over with a guess.
 *
 * @param {{entries?: object[], project?: unknown, inspect?: (path: string) => string, file?: string|null}} input
 * @returns {{ok: true, dir: string, project: string, entry: object} | {ok: false, code: string, message: string, project?: string|null, path?: string|null, file?: string|null}}
 */
export function resolveProjectDir(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const project = typeof input.project === "string" ? input.project.trim() : "";
  const file = input.file ?? null;
  const where = file ? ` (${file})` : "";

  if (project === "") {
    return failure(
      PROJECT_DIR_CODES.UNMAPPED,
      `no project identity was given, so no target directory can be resolved${where}.`,
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

  const checked = checkTargetDirectory(entry.local_path, {
    ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
    project,
    file,
  });
  if (!checked.ok) return checked;
  return { ok: true, dir: checked.dir, project, entry };
}
