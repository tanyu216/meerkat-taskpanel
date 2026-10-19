/**
 * Where the loop's event subscriber connects.
 *
 * The board URL and token are the same two facts every other client resolves:
 * the runtime pointer (`readPointer`, with its data-directory fallback) and the
 * token precedence in `resolveToken`. Reusing them means the subscriber cannot
 * drift from `taskctl` about which board it is watching.
 *
 * **It never calls `ensureBoard`.** The installed loop body lives at
 * `<host>/meerkat-taskpanel/`, which has no `src/server/main.mjs`; an autostart
 * from there would point at a file that does not exist. A missing board is a
 * reconnect, not a spawn: the next `taskctl` call (the continue turn) owns the
 * one autostart path, and this resolver simply re-reads the pointer afterwards.
 *
 * Node builtins only; no network, no dependencies.
 */

import { join } from "node:path";

import { readPointer } from "../../src/shared/transport/runtime.mjs";
import { resolveToken } from "../../src/shared/transport/token.mjs";

/**
 * @param {object} opts the loop options (`repo`, `token`)
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{readPointer?: Function, resolveToken?: Function}} [deps]
 * @returns {{url: string, token: string|null, pointer: object}|null}
 */
export function resolveEventEndpoint(opts, env = process.env, deps = {}) {
  const dataDir =
    typeof env.TASKD_DATA_DIR === "string" && env.TASKD_DATA_DIR.trim() !== ""
      ? env.TASKD_DATA_DIR
      : join(opts.repo, ".data");

  const pointer = (deps.readPointer ?? readPointer)({ env, dataDir });
  if (pointer === null || typeof pointer.url !== "string" || pointer.url.trim() === "") return null;

  let token = null;
  try {
    token = (deps.resolveToken ?? resolveToken)({ env, pointer, flag: opts.token }).token;
  } catch {
    // A corrupt token file is a reason to reconnect and re-resolve, not to
    // crash the subscriber. The next pointer write may heal it.
    token = null;
  }
  return { url: pointer.url.replace(/\/+$/, ""), token, pointer };
}
