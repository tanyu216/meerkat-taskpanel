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
 * CLI must not import storage (see `test/cli/imports.test.mjs`); it is three
 * lines built from the same two constants core uses.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { TOKEN_BYTES, TOKEN_ENV, TOKEN_PREFIX } from "../shared/constants.mjs";
import { DomainError } from "../shared/errors.mjs";

/** `td_` + 64 hex characters — the same shape `token-store.mjs` writes. */
export const TOKEN_FORMAT = new RegExp(`^${TOKEN_PREFIX}[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/** @param {unknown} value */
export function isTokenShape(value) {
  return typeof value === "string" && TOKEN_FORMAT.test(value);
}

const defaultReadFile = (file) => readFileSync(file, "utf8");

/**
 * @param {{flag?: string, env?: NodeJS.ProcessEnv, pointer?: object|null, readFile?: (file: string) => string}} [input]
 * @returns {{token: string|null, source: "flag"|"env"|"file"|"none"}}
 * @throws {DomainError} TOKEN_FILE_CORRUPT when the pointer names a file that is not a token
 */
export function resolveToken(input = {}) {
  const { flag, env = process.env, pointer = null, readFile = defaultReadFile } = input;

  if (typeof flag === "string" && flag.trim() !== "") {
    return { token: flag.trim(), source: "flag" };
  }

  const fromEnv = env[TOKEN_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { token: fromEnv.trim(), source: "env" };
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
      // Path-free by policy (M3fix D3): this error is echoed to MCP clients, and
      // a host absolute path is host-specific detail a caller cannot act on. The
      // file *name* is kept — it is what a human needs to fix it, and it names no
      // host.
      throw new DomainError("TOKEN_FILE_CORRUPT", {
        message: `the token file named by the runtime pointer does not contain a ${TOKEN_PREFIX}… token`,
        details: { file: basename(file) },
        hint: { fix: "delete the token file named by the runtime pointer and start the board again to generate a new token" },
      });
    }
    return { token, source: "file" };
  }

  return { token: null, source: "none" };
}
