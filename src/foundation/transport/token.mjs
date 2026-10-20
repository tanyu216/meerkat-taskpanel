/**
 * Which token to present, and where it came from (§7.1, §F-F).
 *
 *   --token  >  $TASKD_TOKEN  >  the runtime pointer's tokenFile  >  none
 *
 * "none" is not an error: a loopback connection needs no token at all, and that
 * is the common case for a local board. The *source* is reported (`token_source`
 * in `--json`) so a confused user can see which of the four won — the value
 * never is.
 *
 * The token shape check lives here rather than in `src/core/storage` because the
 * client must not import storage (see `test/cli/imports.test.mjs`); it is three
 * lines built from the same two constants core uses.
 *
 * Shared (extracted from `src/cli`) so the token resolves the same way from every
 * entry point that uses the seam, with the same priority and the same corruption
 * error.
 *
 * The `pointer` this reads is the one board resolution produced
 * (`runtime.mjs#readPointer`, data-directory fallback included, R1) — a data
 * directory's own board is reached with *its* token, never with the machine-wide
 * slot's. Resolution happens before the board is known (the CLI resolves the
 * token first so that a failure can still report `token_source`), so a board
 * this process starts for itself is covered by the loopback exemption rather
 * than by this file.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { TOKEN_BYTES, TOKEN_ENV, TOKEN_FILE_ENV, TOKEN_PREFIX } from "../constants.mjs";
import { DomainError } from "../errors.mjs";

/** `td_` + 64 hex characters — the same shape `token-store.mjs` writes. */
export const TOKEN_FORMAT = new RegExp(`^${TOKEN_PREFIX}[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/** @param {unknown} value */
export function isTokenShape(value) {
  return typeof value === "string" && TOKEN_FORMAT.test(value);
}

const defaultReadFile = (file) => readFileSync(file, "utf8");
const defaultStatFile = (file) => statSync(file);

/** @param {number} mode */
function octal(mode) {
  return mode.toString(8).padStart(4, "0");
}

/**
 * @param {{
 *   flag?: string, env?: NodeJS.ProcessEnv, pointer?: object|null,
 *   tokenFile?: string|null, readFile?: (file: string) => string,
 *   statFile?: (file: string) => {mode: number}, platform?: string,
 * }} [input]
 * @returns {{token: string|null, source: "flag"|"env"|"file"|"none"}}
 * @throws {DomainError} TOKEN_FILE_CORRUPT when a token file is not a token;
 *   CONFIG_FILE_INVALID / CONFIG_FILE_INSECURE for an explicitly configured one
 */
export function resolveToken(input = {}) {
  const {
    flag,
    env = process.env,
    pointer = null,
    tokenFile = null,
    readFile = defaultReadFile,
    statFile = defaultStatFile,
    platform = process.platform,
  } = input;

  if (typeof flag === "string" && flag.trim() !== "") {
    return { token: flag.trim(), source: "flag" };
  }

  const fromEnv = env[TOKEN_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { token: fromEnv.trim(), source: "env" };
  }

  // An explicitly configured token file (TASKD_TOKEN_FILE, from `.env` or the
  // process environment). It is strict: a named file that cannot be read or is
  // not a token is a configuration error, not "no token". It is checked only
  // when it wins, so an unused broken file does not block a command that has a
  // higher-precedence token.
  if (typeof tokenFile === "string" && tokenFile !== "") {
    let raw;
    try {
      raw = readFile(tokenFile);
    } catch (err) {
      throw new DomainError("CONFIG_FILE_INVALID", {
        message: `cannot read the token file named by ${TOKEN_FILE_ENV}: ${err?.code ?? err?.message ?? String(err)}`,
        details: { file: basename(tokenFile), source: "config" },
        hint: { fix: `create ${basename(tokenFile)} with a ${TOKEN_PREFIX}… token, or remove ${TOKEN_FILE_ENV}` },
      });
    }
    if (platform !== "win32") {
      try {
        const mode = statFile(tokenFile).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new DomainError("CONFIG_FILE_INSECURE", {
            message: `the token file named by ${TOKEN_FILE_ENV} is accessible by other users (mode ${octal(mode)})`,
            details: { file: basename(tokenFile), mode: octal(mode), required: "0600" },
            hint: { fix: `chmod 600 ${tokenFile}` },
          });
        }
      } catch (err) {
        if (err instanceof DomainError) throw err;
        // A stat failure after a successful read is not worth failing over.
      }
    }
    const token = String(raw).trim();
    if (!isTokenShape(token)) {
      throw new DomainError("TOKEN_FILE_CORRUPT", {
        message: `the token file named by ${TOKEN_FILE_ENV} does not contain a ${TOKEN_PREFIX}… token`,
        details: { file: basename(tokenFile), source: "config" },
        hint: { fix: `replace it with a ${TOKEN_PREFIX}… token, or remove ${TOKEN_FILE_ENV}` },
      });
    }
    return { token, source: "file" };
  }

  const file = pointer?.tokenFile;
  if (typeof file === "string" && file !== "") {
    let raw = null;
    try {
      raw = readFile(file);
    } catch {
      // The pointer outlived its token file: not a failure, just no token.
      return { token: null, source: "none" };
    }
    const token = String(raw).trim();
    if (!isTokenShape(token)) {
      // Path-free by policy (M3fix D3): this error is surfaced to callers, and
      // a host absolute path is host-specific detail a caller cannot act on. The
      // file *name* is kept — it is what a human needs to fix it, and it names no
      // host.
      throw new DomainError("TOKEN_FILE_CORRUPT", {
        message: `the token file named by the runtime pointer does not contain a ${TOKEN_PREFIX}… token`,
        details: { file: basename(file), source: "pointer" },
        hint: { fix: "delete the token file named by the runtime pointer and start the board again to generate a new token" },
      });
    }
    return { token, source: "file" };
  }

  return { token: null, source: "none" };
}
