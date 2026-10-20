/**
 * Where the board lives on disk — the *single* source of truth, shared by the
 * CLI (an HTTP client that must find the running service and its token) and by
 * `src/core` (which owns the data directory).
 *
 *   data dir   explicit → `TASKD_DATA_DIR` → `<repo>/.data`
 *   database   explicit → `TASKD_DB` (absolute wins) → `<dataDir>/board.sqlite`
 *   token      `<dataDir>/token`
 *   pointer    `TASKD_RUNTIME_POINTER` → per-user state dir (macOS: Application
 *              Support, Linux: XDG_STATE_HOME); its data-dir twin is
 *              `runtimePointerPathForDataDir`
 *
 * Every resolver takes an optional `env` object so tests never touch the real
 * environment, and nothing here writes anything at all.
 *
 * This module is pure path arithmetic: no filesystem calls, so `src/cli` can use
 * it without touching `src/core/storage` (see `test/cli/imports.test.mjs`).
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_DIR_ENV,
  DB_FILENAME,
  DB_PATH_ENV,
  DEFAULT_DATA_DIR,
  ENV_FILE_ENV,
  ENV_FILE_FILENAME,
  LOGS_DIRNAME,
  RUNTIME_FILENAME,
  RUNTIME_POINTER_ENV,
  TOKEN_FILENAME,
} from "./constants.mjs";

/** Repository root, derived from this file's location (`src/foundation/`). */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/** @param {unknown} value */
export function isAbsolutePath(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

/**
 * @param {{dataDir?: string|null, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string} absolute data directory (not created)
 */
export function resolveDataDir(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.dataDir;
  if (typeof explicit === "string" && explicit.trim() !== "") return resolve(explicit);

  const fromEnv = env[DATA_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);

  return resolve(repoRoot(), DEFAULT_DATA_DIR);
}

/**
 * @param {{dataDir?: string|null, dbPath?: string|null, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string} absolute database path
 */
export function resolveDbPath(options = {}) {
  const env = options.env ?? process.env;

  if (typeof options.dbPath === "string" && options.dbPath.trim() !== "") {
    return resolve(options.dbPath);
  }

  const fromEnv = env[DB_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    // `TASKD_DB` is a *file* path; a bare name is resolved against the data dir
    // so `TASKD_DB=board.sqlite` behaves the way a shell user expects.
    return isAbsolute(fromEnv) ? resolve(fromEnv) : join(resolveDataDir(options), fromEnv);
  }

  return join(resolveDataDir(options), DB_FILENAME);
}

/** @param {string} dataDir */
export function tokenPath(dataDir) {
  return join(resolve(dataDir), TOKEN_FILENAME);
}

/** @param {string} dataDir */
export function logsDir(dataDir) {
  return join(resolve(dataDir), LOGS_DIRNAME);
}

/**
 * The file a board is addressed at when the machine-wide slot is somebody
 * else's: beside its own `token` and `writer.lock` (§7.1).
 *
 * The write side's twin is
 * `core/storage/secrets/runtime-pointer.mjs#runtimePointerPathForDataDir`; this
 * is the seam-side copy the CLI and the transport share. It exists because the
 * *read* side has to look at that file too — and, since
 * T-20261014-044653, because the parent that spawns a daemon waits on it as
 * well: with no named pointer the child picks this file itself (the write side's
 * "never displace a live board" rule), so the parent cannot know in advance
 * which of the two it wrote.
 *
 * @param {string} dataDir
 * @returns {string} absolute file path
 */
export function runtimePointerPathForDataDir(dataDir) {
  return join(resolve(dataDir), RUNTIME_FILENAME);
}

/**
 * The one config file read by both `taskd` and `taskctl`: `<program root>/.env`.
 *
 * `MEERKAT_TASKPANEL_ENV_FILE` overrides the whole path (tests, containers, a
 * read-only package root). A relative override is resolved against `cwd`, like
 * every other path a shell hands over.
 *
 * Pure path arithmetic, like the rest of this module — the caller reads bytes.
 *
 * @param {{root?: string, env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 * @returns {string} absolute file path
 */
export function resolveEnvFilePath(options = {}) {
  const root = options.root ?? repoRoot();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const override = env[ENV_FILE_ENV];
  if (typeof override === "string" && override.trim() !== "") return resolve(cwd, override);
  return join(resolve(root), ENV_FILE_FILENAME);
}

/**
 * Per-user runtime pointer location (§7.1) — how an agent in any cwd finds the
 * running board.
 *
 * `TASKD_RUNTIME_POINTER` overrides the whole thing. That exists for the test
 * suite (F-E: every case gets its own temp data dir and must not disturb a
 * developer's running board) and for a user who keeps several boards.
 *
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {string} absolute file path
 */
export function resolveRuntimePointerPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const override = env[RUNTIME_POINTER_ENV];
  if (typeof override === "string" && override.trim() !== "") return resolve(override);

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "MeerkatTaskPanel", "runtime.json");
  }

  const xdg = env.XDG_STATE_HOME;
  const base =
    typeof xdg === "string" && xdg.trim() !== "" ? resolve(xdg) : join(home, ".local", "state");
  return join(base, "meerkat-taskpanel", "runtime.json");
}
