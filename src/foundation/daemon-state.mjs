/**
 * Generic host-state primitives: owner-only directories, atomic JSON, pid
 * liveness and `O_EXCL` locks.
 *
 * The event hub and the loop orchestrator both keep state in a per-user
 * directory and both need the same crash-safe file discipline. This module is
 * that discipline; it knows nothing about a board, a hub or a loop.
 *
 * Node builtins only; no I/O beyond the functions named here.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/** A lock older than this belongs to a start that died; it may be reclaimed. */
export const LOCK_STALE_MS = 60_000;

/** Create a directory only this user can read or traverse. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a shared filesystem may refuse chmod; the contents are still 0600 */
  }
}

/** Read JSON, or `null` for missing/corrupt content. */
export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * An atomic, owner-only JSON file. The temp name is unique per process and
 * moment; the rename is the visible publish.
 */
export function writeJsonFile(path, value) {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

/** Remove a file if it is there. */
export function removeFile(path) {
  rmSync(path, { force: true });
}

/**
 * `kill(pid, 0)` with the repo's EPERM-means-alive convention.
 *
 * @param {unknown} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Claim a mutex with `O_EXCL`. Returns `{ok:false}` when another owner holds it.
 *
 * @param {string} path
 * @returns {{ok: boolean}}
 */
export function acquireLock(path) {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
    return { ok: true };
  } catch (err) {
    if (err?.code === "EEXIST") return { ok: false };
    throw err;
  }
}

/** Release a lock this process owns. */
export function releaseLock(path) {
  removeFile(path);
}

/**
 * A lock is stale when its owner is gone or it has been held far longer than a
 * start should take. A stale lock is removed by the next starter.
 *
 * @param {string} path
 * @param {() => number} [now]
 * @param {number} [staleMs]
 */
export function lockIsStale(path, now = Date.now, staleMs = LOCK_STALE_MS) {
  const lock = readJsonFile(path);
  if (lock === null) return true;
  if (!pidAlive(lock.pid)) return true;
  return now() - Number(lock.startedAt ?? 0) > staleMs;
}
