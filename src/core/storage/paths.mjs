/**
 * Where the board lives on disk.
 *
 *   data dir   explicit → `TASKD_DATA_DIR` → `<repo>/.data`
 *   database   explicit → `TASKD_DB` (absolute wins) → `<dataDir>/board.sqlite`
 *   token      `<dataDir>/token`
 *   pointer    per-user state dir (macOS: Application Support, Linux: XDG_STATE_HOME)
 *
 * Every resolver takes an optional `env` object so tests never touch the real
 * environment, and nothing here writes except `ensureDir`.
 */

import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_DIR_ENV,
  DB_FILENAME,
  DB_PATH_ENV,
  DEFAULT_DATA_DIR,
  LOGS_DIRNAME,
  SECRET_DIR_MODE,
  TOKEN_FILENAME,
} from "../../shared/constants.mjs";

/** Repository root, derived from this file's location (`src/core/storage/`). */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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

/** `:memory:` is a connection, not a file — callers branch on this. */
export function isMemoryPath(path) {
  return path === ":memory:" || path === "";
}

/**
 * Create `dir` (and parents) with `mode`, defeating a permissive umask.
 *
 * @param {string} dir
 * @param {{mode?: number}} [options]
 * @returns {string} `dir`
 */
export function ensureDir(dir, options = {}) {
  const { mode = SECRET_DIR_MODE } = options;
  mkdirSync(dir, { recursive: true, mode });
  // mkdir honours umask, so an explicit chmod is what actually guarantees 0700.
  const current = statSync(dir).mode & 0o777;
  if (current !== mode) chmodSync(dir, mode);
  return dir;
}

/** Create the parent directory of a file path. @param {string} filePath */
export function ensureParentDir(filePath, options = {}) {
  return ensureDir(dirname(resolve(filePath)), options);
}

/**
 * Per-user runtime pointer location (§7.1) — how an agent in any cwd finds the
 * running board.
 *
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {string} absolute file path
 */
export function resolveRuntimePointerPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "TaskPanel", "runtime.json");
  }

  const xdg = env.XDG_STATE_HOME;
  const base =
    typeof xdg === "string" && xdg.trim() !== "" ? resolve(xdg) : join(home, ".local", "state");
  return join(base, "task-panel", "runtime.json");
}
