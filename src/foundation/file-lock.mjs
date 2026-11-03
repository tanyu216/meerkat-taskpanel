/**
 * One advisory interprocess lock for the loop's state files.
 *
 * The supervisor runs as more than one process: the tick (`taskctl loop run
 * --continue-once`) enqueues handoffs while the resident pool (`taskctl loop
 * session`) claims and requeues them, and both write `cards.queue.json`. The
 * file's writes are atomic (temp + rename), but a read-modify-write is not: two
 * writers can each read the old list and the last rename wins, deleting the
 * other's row. This module is the smallest thing that closes that window
 * without a dependency.
 *
 * The contract:
 *
 *   * `openSync(path, "wx")` is the atomic point — two processes cannot both
 *     create the file, and the winner writes its owner record before returning;
 *   * a holder whose pid is gone is reclaimed; a live holder is not (unless the
 *     caller explicitly allows it or the lock outlived `maxAgeMs`);
 *   * an unreadable lock is reclaimed only after `UNREADABLE_STALE_MS`, so a
 *     holder that has created the file but not yet written it is not stolen;
 *   * release is owner-checked by token, so a slow ex-holder that lost the lock
 *     cannot delete the next holder's file;
 *   * re-entry in the same process nests (a mutator may call another mutator).
 *
 * Node builtins only. The lock is advisory: every loop writer must take it.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { pidMatches, processStartToken } from "./daemon-state.mjs";

export const FILE_LOCK_VERSION = 1;
/** A fresh unreadable lock is a holder between create and write. */
export const UNREADABLE_STALE_MS = 10_000;

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_MS = 15;
/** How many dead-holder files this call may reclaim before giving up. */
const DEFAULT_TAKEOVERS = 3;

/** `path` → `{ depth, token, holder }` for the locks this process holds. */
const held = new Map();

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

/** Block this thread for a few milliseconds (synchronous callers only). */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a lock's owner record, or `null` when it is missing or unreadable.
 *
 * @param {string} path
 * @returns {object|null}
 */
export function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Is the lock file present at all (readable or not)? */
export function isLockHeld(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path @param {number} now */
function ageMs(path, now) {
  try {
    return Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Should the existing lock be taken over? `null` means "still a holder".
 *
 * @param {string} path
 * @param {object|null} existing
 * @param {{isAlive: Function, now: number, stealAlive: boolean, maxAgeMs: number}} input
 * @returns {string|null}
 */
function staleReason(path, existing, input) {
  if (existing === null) {
    const age = ageMs(path, input.now);
    return age !== null && age > UNREADABLE_STALE_MS ? "unreadable" : null;
  }
  const alive = input.isAlive(Number(existing.pid));
  if (!alive) return "holder-gone";
  // A reused pid is alive but is not this holder; its start token says so.
  if (!pidMatches(Number(existing.pid), existing.pidStart, { isAlive: input.isAlive })) {
    return "pid-reused";
  }
  if (input.stealAlive) return "stolen";
  if (input.maxAgeMs > 0) {
    const started = Date.parse(String(existing.at ?? ""));
    const elapsed = Number.isFinite(started) ? input.now - started : null;
    if (elapsed === null || elapsed >= input.maxAgeMs) return "expired";
  }
  return null;
}

/**
 * Take the lock at `path`.
 *
 * @param {string} path
 * @param {{
 *   isAlive?: (pid:number)=>boolean,
 *   now?: number,
 *   retries?: number,
 *   retryMs?: number,
 *   stealAlive?: boolean,
 *   maxAgeMs?: number,
 * }} [options]
 * @returns {{
 *   acquired: boolean,
 *   token: string|null,
 *   holder: object|null,
 *   reason?: string,
 *   reentrant?: boolean,
 * }}
 */
export function acquireFileLock(path, options = {}) {
  const isAlive = typeof options.isAlive === "function" ? options.isAlive : isProcessAlive;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const retries = Math.max(0, Number(options.retries ?? DEFAULT_RETRIES));
  const retryMs = Math.max(0, Number(options.retryMs ?? DEFAULT_RETRY_MS));
  const stealAlive = options.stealAlive === true;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0 ? options.maxAgeMs : 0;

  // Re-entry is for one owner that mutates a file through nested calls. A
  // caller with a second, independent owner in the same process (two session
  // pools) must still be refused, so it opts out.
  const current = options.reentrant === false ? undefined : held.get(path);
  if (current !== undefined) {
    current.depth += 1;
    return {
      acquired: true,
      token: current.token,
      holder: current.holder,
      reentrant: true,
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  // Each iteration is one attempt: create, take over, or wait. A takeover does
  // not consume an attempt (the holder is gone; the wait budget is for a live
  // holder), but takeovers are themselves capped so a lock that keeps being
  // recreated cannot spin this loop.
  let takeovers = 0;
  for (let attempt = 0; attempt <= retries; ) {
    const token = randomUUID();
    const holder = {
      version: FILE_LOCK_VERSION,
      pid: process.pid,
      pidStart: processStartToken(process.pid),
      token,
      at: new Date(now).toISOString(),
    };
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(holder)}\n`);
      } finally {
        closeSync(fd);
      }
      held.set(path, { depth: 1, token, holder });
      return { acquired: true, token, holder, reentrant: false };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }

    const existing = readLock(path);
    const reason = staleReason(path, existing, { isAlive, now, stealAlive, maxAgeMs });
    if (reason !== null) {
      if (takeovers >= DEFAULT_TAKEOVERS) {
        return { acquired: false, token: null, holder: readLock(path), reason: "raced" };
      }
      takeovers += 1;
      try {
        unlinkSync(path);
      } catch {
        // Somebody else took it over first; the next attempt re-reads.
      }
      continue;
    }
    if (attempt === retries) {
      return {
        acquired: false,
        token: null,
        holder: existing,
        reason: existing === null ? "unreadable" : "held",
      };
    }
    sleepSync(retryMs);
    attempt += 1;
  }
  return { acquired: false, token: null, holder: readLock(path), reason: "held" };
}

/**
 * Release the lock, but only if this caller still owns it.
 *
 * A token that does not match the file's owner leaves the file untouched: a
 * slow ex-holder that lost the lock must not delete the new holder's file.
 *
 * @param {string} path
 * @param {string} [token]
 * @returns {{released: boolean, foreign?: boolean, depth?: number}}
 */
export function releaseFileLock(path, token) {
  const current = held.get(path);
  if (current !== undefined && (token === undefined || current.token === token)) {
    current.depth -= 1;
    if (current.depth > 0) return { released: false, depth: current.depth };
    held.delete(path);
  }
  const existing = readLock(path);
  if (token !== undefined && existing !== null && existing.token !== token) {
    return { released: false, foreign: true };
  }
  try {
    unlinkSync(path);
    return { released: true };
  } catch {
    // Already gone is success.
    return { released: true };
  }
}

/**
 * Run `fn` under the lock. The caller's failure shape is preserved: `busy` is
 * returned when the lock could not be taken in time, so a tick can retry next
 * pass instead of writing a lost update.
 *
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @param {{busy: () => T}} options
 * @returns {T}
 */
export function withFileLock(path, fn, options) {
  const lock = acquireFileLock(path);
  if (!lock.acquired) return options.busy();
  try {
    return fn();
  } finally {
    releaseFileLock(path, lock.token);
  }
}
