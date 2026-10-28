/**
 * The machine-local project → directory map — the *rule* behind `projects.json`
 * (one file per install, at the config root beside `.env.<kind>`).
 *
 * The board holds no directory (O3): a board project is an id, a name and an
 * identifier prefix, and nothing else. "Which directory does work for this
 * project happen in?" is decided **locally, per install**, by `projects.json`,
 * and `skills/meerkat/references/projects-json.md` documents it. This module is
 * that document in code — the read rules, and the write rules `taskctl project
 * map` uses — so the CLI, the poll pass and the tests all read one map the same
 * way, and a project with no mapped directory is a loud, coded answer instead of
 * a silent guess.
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
 * There is no reverse lookup: `run_dir` is a launch pad (an inbox, `$HOME`) and
 * must not claim every directory under it, so "which project is this directory?"
 * is a question for the user, not a command.
 *
 * The read and edit rules are pure and the filesystem is injected (`inspect`,
 * `read`, and the writer's `deps`), so every branch is exercised without touching
 * a disk — the split `src/foundation/scheduling.mjs` already uses for the
 * supervisor's decision half.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { resolveConfigDir } from "./agent-paths.mjs";

/** The map's file name under the config root. */
export const PROJECT_MAP_FILENAME = "projects.json";

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
  /** The map exists (or could) but this process cannot write it. */
  MAP_UNWRITABLE: "PROJECT_MAP_UNWRITABLE",
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
 * Parse the map, keeping the document raw enough to write back.
 *
 * A malformed file is a failure with a code — never an empty map that would
 * quietly read as "no project is registered" (and never a file a writer may
 * overwrite from that empty start).
 *
 * @param {unknown} text
 * @param {{file?: string|null}} [options]
 * @returns {{ok: true, root: object, projects: unknown[], file: string|null} | {ok: false, code: string, message: string, file?: string|null}}
 */
export function parseProjectMapDocument(text, options = {}) {
  const file = options.file ?? null;
  const where = file ? ` (${file})` : "";

  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch (err) {
    return failure(PROJECT_DIR_CODES.MAP_UNREADABLE, `the project map${where} is not valid JSON: ${err?.message ?? err}`, { file });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.projects)) {
    return failure(PROJECT_DIR_CODES.MAP_UNREADABLE, `the project map${where} needs a \`projects\` array.`, { file });
  }

  return { ok: true, root: parsed, projects: parsed.projects, file };
}

/**
 * Parse the map for *reading*. Entries that are not objects are dropped rather
 * than raising: the file is hand-written, and one stray string must not take the
 * whole map down.
 *
 * @param {unknown} text
 * @param {{file?: string|null}} [options]
 * @returns {{ok: true, entries: object[], file: string|null} | {ok: false, code: string, message: string, file?: string|null}}
 */
export function parseProjectMap(text, options = {}) {
  const document = parseProjectMapDocument(text, options);
  if (!document.ok) return document;
  const entries = document.projects.filter(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  return { ok: true, entries, file: document.file };
}

/**
 * Read the map for an edit. A missing file is the empty map a first write
 * starts from; an unreadable or malformed file is a refusal, so a writer never
 * replaces a file it did not understand.
 *
 * @param {string} file
 * @param {{read?: (path: string, encoding: string) => string}} [options]
 * @returns {{ok: true, present: boolean, root: object, projects: unknown[], file: string} | {ok: false, code: string, message: string, file: string}}
 */
export function readProjectMapForEdit(file, options = {}) {
  const read = options.read ?? readFileSync;
  let text;
  try {
    text = read(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: true, present: false, root: {}, projects: [], file };
    }
    return failure(
      PROJECT_DIR_CODES.MAP_UNREADABLE,
      `cannot read the project map at ${file} (${err?.code ?? err?.message ?? "unknown error"}).`,
      { file },
    );
  }
  const document = parseProjectMapDocument(text, { file });
  if (!document.ok) return document;
  return { ok: true, present: true, root: document.root, projects: document.projects, file };
}

/** @param {unknown} entry */
function isEntryObject(entry) {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry);
}

/**
 * Set one project's directory: update the first matching entry in place, or
 * append a new one. Pure — the input array and its entries are never mutated.
 *
 * Exactly one mode is applied. `local_path` and `run_dir` are mutually
 * exclusive by construction (`dir = local_path ?? run_dir`), so setting one
 * removes the other; `noDir` removes both and leaves the documented "this
 * project has no local directory" answer. Everything else on the entry —
 * including keys this module does not interpret — survives a write.
 *
 * @param {unknown[]} projects
 * @param {{project: string, localPath?: string, runDir?: string, noDir?: boolean}} input
 * @returns {{entries: unknown[], entry: object, created: boolean}}
 */
export function upsertProjectEntry(projects, input) {
  const list = Array.isArray(projects) ? projects : [];
  const index = list.findIndex((entry) => isEntryObject(entry) && entry.project === input.project);
  const current = index === -1 ? { project: input.project } : { ...list[index] };

  if (input.noDir === true) {
    delete current.local_path;
    delete current.run_dir;
  } else if (typeof input.localPath === "string") {
    current.local_path = input.localPath;
    delete current.run_dir;
  } else if (typeof input.runDir === "string") {
    current.run_dir = input.runDir;
    delete current.local_path;
  }

  if (index === -1) return { entries: [...list, current], entry: current, created: true };
  const entries = list.slice();
  entries[index] = current;
  return { entries, entry: current, created: false };
}

/**
 * Remove every entry registered for `project` (duplicates included — a map may
 * carry them, and leaving one behind would make `remove` look broken).
 *
 * @param {unknown[]} projects
 * @param {string} project
 * @returns {{entries: unknown[], removed: number}}
 */
export function removeProjectEntry(projects, project) {
  const list = Array.isArray(projects) ? projects : [];
  const entries = list.filter((entry) => !(isEntryObject(entry) && entry.project === project));
  return { entries, removed: list.length - entries.length };
}

/**
 * Merge a source map into a target map: the target wins on the same `project`,
 * source-only entries are appended in source order, and each entry is copied
 * whole so its unknown keys survive. Malformed and duplicate source entries are
 * skipped and counted.
 *
 * @param {unknown[]} target
 * @param {unknown[]} incoming
 * @returns {{entries: unknown[], added: number, kept: number, skipped: number}}
 */
export function mergeProjectEntries(target, incoming) {
  const entries = Array.isArray(target) ? target.slice() : [];
  const known = new Set(
    entries.filter(isEntryObject).map((entry) => entry.project).filter((id) => typeof id === "string"),
  );
  let added = 0;
  let kept = 0;
  let skipped = 0;

  for (const entry of Array.isArray(incoming) ? incoming : []) {
    if (!isEntryObject(entry) || typeof entry.project !== "string" || entry.project.trim() === "") {
      skipped += 1;
      continue;
    }
    if (known.has(entry.project)) {
      kept += 1;
      continue;
    }
    known.add(entry.project);
    entries.push({ ...entry });
    added += 1;
  }

  return { entries, added, kept, skipped };
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

  const entry = entries.find(
    (candidate) => candidate !== null && typeof candidate === "object" && candidate.project === project,
  );
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
 * The one machine-local map: `projects.json` under the config root (the
 * program root, or `MEERKAT_TASKPANEL_CONFIG_DIR`). There is no broader
 * override — a second board is a second install.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{cwd?: string, root?: string}} [options]
 * @returns {string} an absolute path
 */
export function defaultProjectsJson(env = process.env, options = {}) {
  return join(resolveConfigDir({ env, cwd: options.cwd, root: options.root }), PROJECT_MAP_FILENAME);
}

/** Distinguishes concurrent temp files in one process. */
let writeCounter = 0;

/**
 * Write the map atomically: a same-directory temp file, then a rename over the
 * target. A reader never sees a half-written map, and a failed write leaves the
 * previous file untouched.
 *
 * `root` is the parsed document's top-level object, so keys this module does not
 * interpret survive a rewrite. An existing file's mode is preserved (a
 * hand-created map may be `0600`).
 *
 * @param {string} file
 * @param {unknown[]} projects
 * @param {{
 *   root?: object,
 *   deps?: {
 *     mkdirSync?: Function, writeFileSync?: Function, renameSync?: Function,
 *     unlinkSync?: Function, statSync?: Function,
 *   },
 * }} [options]
 * @returns {{ok: true, file: string} | {ok: false, code: string, message: string, file: string}}
 */
export function writeProjectMap(file, projects, options = {}) {
  const deps = {
    mkdirSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    statSync,
    ...(options.deps ?? {}),
  };
  const text = `${JSON.stringify({ ...(options.root ?? {}), projects }, null, 2)}\n`;
  const temp = `${file}.tmp-${process.pid}-${writeCounter}`;
  writeCounter += 1;

  let mode;
  try {
    mode = deps.statSync(file).mode & 0o777;
  } catch {
    mode = null;
  }

  try {
    deps.mkdirSync(dirname(file), { recursive: true });
    deps.writeFileSync(temp, text, mode === null ? "utf8" : { encoding: "utf8", mode });
    deps.renameSync(temp, file);
    return { ok: true, file };
  } catch (err) {
    try {
      deps.unlinkSync(temp);
    } catch {
      // The temp file was never created (or is already gone): nothing to clean.
    }
    return failure(
      PROJECT_DIR_CODES.MAP_UNWRITABLE,
      `cannot write the project map at ${file} (${err?.code ?? err?.message ?? "unknown error"}). ` +
        "Point MEERKAT_TASKPANEL_CONFIG_DIR at a writable directory, or fix the file's permissions.",
      { file },
    );
  }
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
export function resolveWakeTarget(input = {}) {
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
        "Register the project with `taskctl project map set <id> --local-path <dir>` — " +
        "see references/projects-json.md.",
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
    const checked = checkTargetDirectory(undefined, {
      project: typeof input.project === "string" ? input.project : null,
      file: projectsJson,
      ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
    });
    if (!checked.ok) return checked;
    return { ok: true, dir: checked.dir, project: resolved.project, entry: resolved.entry };
  }

  return { ok: true, dir: resolved.dir, project: resolved.project, entry: resolved.entry };
}

/**
 * The wake directory alone. Kept as the narrow read the callers that do not
 * need the project entry (and its `base_ref`) already use.
 *
 * @param {object} [input]
 * @returns {{ok: true, dir: string} | {ok: false, code: string, message: string}}
 */
export function resolveWakeDir(input = {}) {
  const target = resolveWakeTarget(input);
  return target.ok ? { ok: true, dir: target.dir } : target;
}
