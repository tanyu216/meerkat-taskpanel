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

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/** A lock older than this belongs to a start that died; it may be reclaimed. */
export const LOCK_STALE_MS = 60_000;

/** How long a process start token is cached before it is read again. */
const START_TOKEN_CACHE_MS = 5_000;

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
 * An atomic, durable, owner-only JSON file. The temp file's data is fsynced
 * before the rename; the rename is the visible publish, so a reader sees either
 * the previous value or the whole new one, never a torn write. The directory is
 * deliberately not fsynced.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {{fsyncSync?: Function, renameSync?: Function}} [fs] test seam for the
 *   external filesystem; production passes nothing.
 */
export function writeJsonFile(path, value, fs = {}) {
  const fsync = typeof fs.fsyncSync === "function" ? fs.fsyncSync : fsyncSync;
  const rename = typeof fs.renameSync === "function" ? fs.renameSync : renameSync;
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsync(fd);
    } finally {
      closeSync(fd);
    }
    rename(temp, path);
  } finally {
    // A failed write or publish must not leave a temp file behind; after a
    // successful rename this is a no-op.
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

/** @type {Map<number, {token: string|null, at: number}>} */
const startTokens = new Map();

/**
 * The platform's start token for `pid`, or `null` when it cannot be read.
 *
 * A pid is reused by the OS, so "the pid exists" is not the same process as the
 * one a lock recorded. The token is a fact that survives the pid: Linux's
 * `/proc/<pid>/stat` field 22 (starttime) and macOS's `ps -o lstart=` both
 * change when the pid is reused. Cached per pid for a few seconds because it is
 * read from a syscall or a child process, and liveness is checked often.
 *
 * @param {unknown} pid
 * @returns {string|null}
 */
export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const now = Date.now();
  const cached = startTokens.get(pid);
  if (cached !== undefined && now - cached.at <= START_TOKEN_CACHE_MS) return cached.token;
  const token = readStartToken(pid);
  startTokens.set(pid, { token, at: now });
  return token;
}

/**
 * @param {number} pid
 * @returns {string|null}
 */
function readStartToken(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 2 (`comm`) may contain spaces and parentheses; the fields after
      // the final `)` start at field 3, so starttime (field 22) is index 19.
      const end = stat.lastIndexOf(")");
      if (end === -1) return null;
      return stat.slice(end + 2).trim().split(/\s+/)[19] ?? null;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
      const token = out.trim();
      return token === "" ? null : token;
    }
  } catch {
    // Gone, unreadable, or no `ps`: the caller degrades to pid-only liveness.
  }
  return null;
}

/**
 * Is `pid` alive *and* the same process that wrote `token`?
 *
 * A null/empty token, or a platform that cannot report one, degrades to the
 * pid-only answer — the behaviour before tokens existed. A live pid whose token
 * differs is a reused pid: it is dead to the record that stored the token.
 *
 * @param {unknown} pid
 * @param {unknown} token
 * @param {{isAlive?: (pid: number) => boolean}} [options]
 * @returns {boolean}
 */
export function pidMatches(pid, token, options = {}) {
  const isAlive = typeof options.isAlive === "function" ? options.isAlive : pidAlive;
  if (!isAlive(pid)) return false;
  if (token === null || token === undefined || token === "") return true;
  const current = processStartToken(pid);
  if (current === null) return true;
  return String(current) === String(token);
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
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          pidStart: processStartToken(process.pid),
          startedAt: Date.now(),
        }),
      );
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
  if (!pidMatches(lock.pid, lock.pidStart)) return true;
  return now() - Number(lock.startedAt ?? 0) > staleMs;
}
