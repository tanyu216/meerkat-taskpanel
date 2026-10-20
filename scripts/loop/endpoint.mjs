/**
 * Where the loop's event subscriber connects.
 *
 * The board URL and token are the same two facts every other client resolves —
 * now from three layers, in order: an explicit `--url` / `--token`, the
 * process environment, the install-root `.env` (loaded with `root: opts.repo`),
 * and finally the runtime pointer.
 *
 * `opts.repo` is the *program* checkout, not this installed body: the body
 * lives at `<host>/meerkat-taskpanel/`, so its own `repoRoot()` would point at
 * the host directory. The installer records the checkout as
 * `MEERKAT_TASKPANEL_REPO`, and `options.mjs` resolves it into `opts.repo`.
 *
 * **It never calls `ensureBoard`.** The installed loop body has no
 * `src/server/main.mjs`; an autostart from there would point at a file that
 * does not exist. A missing board is a reconnect, not a spawn: the next
 * `taskctl` call (the continue turn) owns the one autostart path, and this
 * resolver simply re-reads the pointer afterwards.
 *
 * Node builtins only; no network, no dependencies.
 */

import { join } from "node:path";

import { URL_ENV } from "../../src/shared/constants.mjs";
import { loadEnvFile } from "../../src/shared/env-config.mjs";
import { normalizeBoardUrl } from "../../src/shared/transport/board-url.mjs";
import { readPointer } from "../../src/shared/transport/runtime.mjs";
import { resolveToken } from "../../src/shared/transport/token.mjs";

/** @param {unknown} value */
function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * @param {object} opts the loop options (`repo`, `url`, `token`, `envFile`)
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{readPointer?: Function, resolveToken?: Function, loadEnvFile?: Function}} [deps]
 * @returns {{url: string, token: string|null, pointer: object|null}|null}
 */
export function resolveEventEndpoint(opts, env = process.env, deps = {}) {
  const config = (deps.loadEnvFile ?? loadEnvFile)({
    flag: opts.envFile ?? null,
    env,
    root: opts.repo,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  const effectiveEnv = config.env;

  const dataDir =
    typeof effectiveEnv.TASKD_DATA_DIR === "string" && effectiveEnv.TASKD_DATA_DIR.trim() !== ""
      ? effectiveEnv.TASKD_DATA_DIR
      : join(opts.repo, ".data");

  const pointer = (deps.readPointer ?? readPointer)({ env: effectiveEnv, dataDir });

  let url = null;
  if (hasText(opts.url)) url = normalizeBoardUrl(opts.url);
  else if (hasText(effectiveEnv[URL_ENV])) url = normalizeBoardUrl(effectiveEnv[URL_ENV]);
  else if (pointer !== null && typeof pointer.url === "string" && pointer.url.trim() !== "") {
    url = pointer.url.replace(/\/+$/, "");
  }
  if (url === null) return null;

  let token = null;
  try {
    token = (deps.resolveToken ?? resolveToken)({
      env: effectiveEnv,
      pointer,
      flag: opts.token,
      tokenFile: config.tokenFile,
    }).token;
  } catch (err) {
    // A corrupt pointer token file is a reason to reconnect and re-resolve, not
    // to crash the subscriber. An explicitly configured token file is different:
    // it will stay broken until someone fixes it, so surface it.
    if (err?.details?.source === "config") throw err;
    token = null;
  }
  return { url, token, pointer };
}
