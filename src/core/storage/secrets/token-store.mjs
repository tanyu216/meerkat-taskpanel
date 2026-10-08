/**
 * The access token on disk (ARCHITECTURE §7.1).
 *
 *   * data dir 0700, token file 0600 — always, whatever the umask says
 *   * written atomically: temp file → fsync → rename → chmod, so a reader never
 *     sees a half-written token and a crash never leaves a truncated one
 *   * an existing file is *never* silently overwritten: if it does not look like
 *     a token, that is `TOKEN_FILE_CORRUPT` and a human decides
 *   * no temporary file is left behind on any path
 *
 * The token is a bearer credential for non-localhost access, not an identity.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, chmodSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { SECRET_DIR_MODE, SECRET_FILE_MODE, TOKEN_BYTES, TOKEN_PREFIX } from "../../../shared/constants.mjs";
import { DomainError } from "../../../shared/errors.mjs";
import { redactText } from "../../../shared/redact.mjs";
import { ensureDir, tokenPath } from "../paths.mjs";

/** `td_` + 64 hex characters. */
export const TOKEN_FORMAT = new RegExp(`^${TOKEN_PREFIX}[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/** @param {unknown} value */
export function isToken(value) {
  return typeof value === "string" && TOKEN_FORMAT.test(value);
}

/** A fresh token. @param {() => Buffer} [random] injectable for tests */
export function generateToken(random = () => randomBytes(TOKEN_BYTES)) {
  return `${TOKEN_PREFIX}${random().toString("hex")}`;
}

/** @param {string} dataDir */
export function tokenFilePath(dataDir) {
  return tokenPath(dataDir);
}

/**
 * Read the token if it is there and well-formed.
 *
 * @param {string} dataDir
 * @returns {string|null} `null` when there is no file yet
 * @throws {DomainError} TOKEN_FILE_CORRUPT when the file exists but is not a token
 */
export function readToken(dataDir) {
  const file = tokenFilePath(dataDir);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new DomainError("TOKEN_FILE_CORRUPT", {
      message: `cannot read the token file: ${redactText(err.message)}`,
      details: { file },
      cause: err,
    });
  }
  const token = raw.trim();
  if (!isToken(token)) {
    throw new DomainError("TOKEN_FILE_CORRUPT", {
      message: `the token file does not contain a ${TOKEN_PREFIX}… token`,
      details: { file, bytes: raw.length },
      hint: { fix: `delete ${file} and start the board again to generate a new token` },
    });
  }
  return token;
}

/**
 * Create the token if it does not exist yet, and make sure the permissions are
 * right even if it does.
 *
 * @param {string} dataDir
 * @param {{random?: () => Buffer}} [options]
 * @returns {{token: string, file: string, created: boolean}}
 */
export function ensureToken(dataDir, options = {}) {
  ensureDir(dataDir, { mode: SECRET_DIR_MODE });
  const file = tokenFilePath(dataDir);
  const existing = readToken(dataDir);

  if (existing !== null) {
    hardenPermissions(file);
    return { token: existing, file, created: false };
  }

  const token = generateToken(options.random);
  writeAtomic(file, token);
  return { token, file, created: true };
}

/**
 * Replace the token with a fresh one, atomically: a reader either sees the old
 * token or the new one.
 *
 * @param {string} dataDir
 * @param {{random?: () => Buffer}} [options]
 * @returns {{token: string, file: string, rotated: true}}
 */
export function rotateToken(dataDir, options = {}) {
  ensureDir(dataDir, { mode: SECRET_DIR_MODE });
  const file = tokenFilePath(dataDir);
  const token = generateToken(options.random);
  writeAtomic(file, token);
  return { token, file, rotated: true };
}

/** @param {string} dataDir */
export function hasToken(dataDir) {
  try {
    return statSync(tokenFilePath(dataDir)).isFile();
  } catch {
    return false;
  }
}

/**
 * Write `text` to `file` in a way that cannot be observed half-done.
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w", SECRET_FILE_MODE);
    try {
      writeSync(fd, `${text}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, SECRET_FILE_MODE);
    renameSync(tmp, file);
    hardenPermissions(file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw new DomainError("TOKEN_FILE_CORRUPT", {
      message: `could not write the token file: ${redactText(err.message)}`,
      details: { file },
      cause: err,
    });
  }
}

/** chmod is what actually enforces the mode — the umask already had its say. */
function hardenPermissions(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode !== SECRET_FILE_MODE) chmodSync(file, SECRET_FILE_MODE);
}
