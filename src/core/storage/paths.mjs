/**
 * Where the board lives on disk.
 *
 * The *resolvers* live in `src/shared/runtime-locator.mjs` and are re-exported
 * here: the CLI is an HTTP client (F-A1) and must be able to find the token and
 * the runtime pointer without importing `src/core/storage` at all, so the path
 * arithmetic was lifted into `shared` and this module became the core-side
 * facade. There is exactly one implementation.
 *
 * What stays here is the one thing that *writes*: `ensureDir`.
 */

import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SECRET_DIR_MODE } from "../../shared/constants.mjs";
import {
  isAbsolutePath,
  logsDir,
  repoRoot,
  resolveDataDir,
  resolveDbPath,
  resolveRuntimePointerPath,
  tokenPath,
} from "../../shared/runtime-locator.mjs";

export {
  isAbsolutePath,
  logsDir,
  repoRoot,
  resolveDataDir,
  resolveDbPath,
  resolveRuntimePointerPath,
  tokenPath,
};

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
