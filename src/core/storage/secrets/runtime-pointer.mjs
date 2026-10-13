/**
 * The per-user runtime pointer (ARCHITECTURE §7.1).
 *
 * An agent working in any directory needs to find the board: this file says
 * where it is. It contains **no token** — only a path to the file that has it —
 * and that promise is enforced, not documented: the serialised payload is
 * scanned for a token before it is written, and a match is a hard
 * `RUNTIME_POINTER_TOKEN_LEAK`.
 *
 * R1 — *who owns the slot, and who may remove it*. The pointer is one file for
 * the whole machine (or, under `TASKD_RUNTIME_POINTER`, one per board), and a
 * board is identified by **(pid, dataDir)** — not by `pid` alone. Both halves of
 * that pair are load-bearing, and each is one half of the same incident
 * (`writer-lock.mjs` names it a *pointer fight*): a stray board — a dev run, a
 * `TASKD_DATA_DIR=/tmp/...` test — wrote the machine-wide file over a live
 * board's address, and then, being its legitimate owner, **removed** it on exit.
 * The canonical board was still running the whole time and became unreachable.
 *
 * So both operations are ownership-checked, against the same pair:
 *
 *   * **write** — a board does not displace a live board that is already in the
 *     slot *and is a different board* (`dataDir` differs). It is addressed
 *     beside its own data directory instead (`<dataDir>/runtime.json`), so the
 *     incumbent's file is not touched and the newcomer still has an address.
 *     A stale incumbent (dead `pid`) is recovered rather than obeyed, the rule
 *     the write lock already applies, which is what makes a `SIGKILL`ed daemon
 *     cost nothing;
 *   * **remove** — the file goes only while it still names the `pid` *and* the
 *     `dataDir` the caller passes. Same pid, another board's data dir: declined.
 *
 * A pointer that carries no `pid`/`dataDir` protects nobody — there is no owner
 * named to protect — so it is written over and removed, which is also the rule
 * `autostart.mjs#waitForPointer` applies when it *reads* one.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  RUNTIME_FILENAME,
  RUNTIME_POINTER_ENV,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  VERSION,
} from "../../../shared/constants.mjs";
import { DomainError } from "../../../shared/errors.mjs";
import { redactText } from "../../../shared/redact.mjs";
import { resolveRuntimePointerPath } from "../paths.mjs";
import { isProcessAlive } from "../writer-lock.mjs";

/**
 * Keys a pointer always carries (the six the plan names, plus a timestamp).
 * `null`-ish values are dropped rather than written.
 */
export const POINTER_KEYS = Object.freeze([
  "url",
  "host",
  "port",
  "dataDir",
  "tokenFile",
  "pid",
  "version",
  "updatedAt",
]);

/** A real token — not the `td_****` placeholder a redacted log line carries. */
const LEAK_PATTERN = /td_[0-9a-f]{64}/;

/**
 * @param {object} pointer
 * @throws {DomainError} RUNTIME_POINTER_TOKEN_LEAK
 * @returns {string} the serialised payload
 */
export function serializePointer(pointer) {
  // Check the caller's *whole* input, not just the keys we keep: a token in a
  // key we would have dropped still means the caller has misunderstood what
  // this file is for, and silently dropping it would hide that.
  if (LEAK_PATTERN.test(JSON.stringify(pointer))) {
    throw new DomainError("RUNTIME_POINTER_TOKEN_LEAK", {
      message: "the runtime pointer would have contained a token",
      details: { keys: Object.keys(pointer) },
      hint: { fix: "pass tokenFile (the path), never the token itself" },
    });
  }

  const payload = {};
  for (const key of POINTER_KEYS) {
    const value = pointer[key];
    if (value !== undefined && value !== null) payload[key] = value;
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (LEAK_PATTERN.test(text)) {
    throw new DomainError("RUNTIME_POINTER_TOKEN_LEAK", {
      message: "the runtime pointer would have contained a token",
      details: { keys: Object.keys(payload) },
      hint: { fix: "pass tokenFile (the path), never the token itself" },
    });
  }
  return text;
}

/**
 * The file a board with this data directory is addressed at when the
 * machine-wide slot is somebody else's: beside `writer.lock` and `token`, in the
 * data directory the board owns (§7.1).
 *
 * @param {string} dataDir
 * @returns {string} absolute file path
 */
export function runtimePointerPathForDataDir(dataDir) {
  return join(resolve(dataDir), RUNTIME_FILENAME);
}

/**
 * Write the pointer, and pick *where* — the one decision this module makes on
 * the caller's behalf.
 *
 * A named path (an explicit `path`, or `TASKD_RUNTIME_POINTER`) is obeyed
 * verbatim: the caller has already chosen the board's namespace, which is how
 * the test suite and a multi-board host stay out of each other's way. Otherwise
 * the target is the machine-wide slot, and it is only taken when nobody live
 * holds it — see the module header for why a live *other* board is not
 * displaced, and what happens instead.
 *
 * @param {object} input
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string, path?: string}} [options]
 * @returns {{path: string, heldBy: number|null}} `heldBy` is the pid whose board
 *   kept the machine-wide slot, when this write went to the data dir instead.
 */
function choosePointerTarget(input, options) {
  const named = namedPointerPath(options);
  if (named !== null) return { path: named, heldBy: null };

  const shared = resolveRuntimePointerPath(options);
  const heldBy = liveForeignHolder(readRawPointer(shared), input);
  if (heldBy === null) return { path: shared, heldBy: null };
  return { path: runtimePointerPathForDataDir(input.dataDir), heldBy };
}

/** The path the caller named, or `null` when the machine-wide slot is in play. */
function namedPointerPath(options) {
  if (hasText(options.path)) return options.path;
  const env = options.env ?? process.env;
  return hasText(env[RUNTIME_POINTER_ENV]) ? resolveRuntimePointerPath(options) : null;
}

/**
 * The pid of a **live board that is not this one** already in `incumbent`, or
 * `null` when the slot is free for the caller.
 *
 * "Not this one" is the (pid, dataDir) pair, and the order of the tests is the
 * permissive one: an unreadable file, a pointer that names no pid or no data
 * dir, a dead pid (a `SIGKILL`ed daemon's fossil), our own pid, or the same
 * board's data dir all mean *write here*. Only a live, attributable, *different*
 * board declines the slot.
 *
 * @param {object|null} incumbent the file's contents, if it parses
 * @param {{pid?: number, dataDir?: string}} input what the caller is writing
 * @returns {number|null}
 */
function liveForeignHolder(incumbent, input) {
  if (incumbent === null) return null;
  if (incumbent.pid === undefined || !hasText(incumbent.dataDir)) return null;
  if (!isProcessAlive(incumbent.pid)) return null;
  if (incumbent.pid === (input.pid ?? process.pid)) return null;
  if (!hasText(input.dataDir) || sameDataDir(incumbent.dataDir, input.dataDir)) return null;
  return incumbent.pid;
}

/** A non-empty string, with the whitespace-only case treated as absent. */
function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Two data dirs that name the same directory, `..`/trailing-slash aside. */
function sameDataDir(a, b) {
  return hasText(a) && hasText(b) && resolve(a) === resolve(b);
}

/**
 * @param {object} input
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {{path: string, pointer: object, heldBy?: number}}
 */
export function writeRuntimePointer(input, options = {}) {
  const target = choosePointerTarget(input, options);
  const path = target.path;
  const pointer = { version: VERSION, updatedAt: input.updatedAt ?? new Date().toISOString(), ...input };
  const text = serializePointer(pointer);

  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
    if ((statSync(dir).mode & 0o777) !== SECRET_DIR_MODE) chmodSync(dir, SECRET_DIR_MODE);
  } catch (err) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `could not prepare the runtime pointer directory: ${redactText(err.message)}`,
      details: { dir },
      cause: err,
    });
  }

  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", SECRET_FILE_MODE);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, SECRET_FILE_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw new DomainError("VALIDATION_FAILED", {
      message: `could not write the runtime pointer: ${redactText(err.message)}`,
      details: { path },
      cause: err,
    });
  }
  return target.heldBy === null
    ? { path, pointer: JSON.parse(text) }
    : { path, pointer: JSON.parse(text), heldBy: target.heldBy };
}

/**
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string, path?: string}} [options]
 * @returns {object|null}
 */
export function readRuntimePointer(options = {}) {
  const path = options.path ?? resolveRuntimePointerPath(options);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Remove the pointer (used on shutdown, and by tests). Idempotent.
 *
 * With `pid` and/or `dataDir`, the file is removed **only while it still names
 * that owner** — a pointer that now belongs to a different instance, or to a
 * board with a different data directory, is left exactly as it is and the answer
 * is `false`. That is the R1 rule: an exiting process cleans up after itself and
 * never unplugs somebody else's board — not by another pid, and not by another
 * data directory wearing the same pid. Either check alone leaves a door open,
 * and each door is half of the incident the module header describes.
 *
 * Only the caller's *own* file is the caller's to name: pass the `path` the
 * write reported (`writeRuntimePointer(...).path`), which is the data dir's own
 * file when the machine-wide slot was somebody else's.
 *
 * A pointer that is missing, unreadable, or carries no `pid`/`dataDir` is
 * removed: there is nobody named to protect.
 *
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string, path?: string, pid?: number, dataDir?: string}} [options]
 * @returns {boolean} whether the pointer is gone afterwards
 */
export function removeRuntimePointer(options = {}) {
  const path = options.path ?? resolveRuntimePointerPath(options);
  const current = readRawPointer(path);
  if (current !== null) {
    if (options.pid !== undefined && current.pid !== undefined && current.pid !== options.pid) return false;
    if (hasText(options.dataDir) && hasText(current.dataDir) && !sameDataDir(current.dataDir, options.dataDir)) {
      return false;
    }
  }
  rmSync(path, { force: true });
  return true;
}

/** The file's contents as an object, or `null` when unreadable/not one. */
function readRawPointer(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
