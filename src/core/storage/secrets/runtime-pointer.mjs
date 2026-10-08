/**
 * The per-user runtime pointer (ARCHITECTURE §7.1).
 *
 * An agent working in any directory needs to find the board: this file says
 * where it is. It contains **no token** — only a path to the file that has it —
 * and that promise is enforced, not documented: the serialised payload is
 * scanned for a token before it is written, and a match is a hard
 * `RUNTIME_POINTER_TOKEN_LEAK`.
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
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { SECRET_DIR_MODE, SECRET_FILE_MODE, VERSION } from "../../../shared/constants.mjs";
import { DomainError } from "../../../shared/errors.mjs";
import { redactText } from "../../../shared/redact.mjs";
import { resolveRuntimePointerPath } from "../paths.mjs";

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
 * @param {object} input
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, home?: string}} [options]
 * @returns {{path: string, pointer: object}}
 */
export function writeRuntimePointer(input, options = {}) {
  const path = options.path ?? resolveRuntimePointerPath(options);
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
  return { path, pointer: JSON.parse(text) };
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

/** Remove the pointer (used on shutdown, and by tests). Idempotent. */
export function removeRuntimePointer(options = {}) {
  const path = options.path ?? resolveRuntimePointerPath(options);
  rmSync(path, { force: true });
  return true;
}
