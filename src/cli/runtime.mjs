/**
 * Finding the board, and starting one if there is none (§F-A1).
 *
 * The client's whole job at startup is to answer one question: *where is the
 * board?* The order is deliberate:
 *
 *   1. `--url` — the caller said so; never second-guess it, and never autostart
 *      behind an explicit address;
 *   2. the runtime pointer — if it names a board that answers `/health`, use it;
 *   3. otherwise start one (`TASKD_NO_AUTOSTART=1` forbids this).
 *
 * A *stale* pointer is the interesting case: a pointer whose process died is
 * indistinguishable from a live one until you knock. So the pointer is only
 * believed after `/health` answers, and a dead address falls through to the
 * autostart path rather than producing a confusing connection error.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { AUTOSTART_TIMEOUT_MS, NO_AUTOSTART_ENV } from "../shared/constants.mjs";
import { resolveRuntimePointerPath } from "../shared/runtime-locator.mjs";
import { ioError } from "./errors.mjs";
import { probeHealth, spawnTaskd } from "./client/autostart.mjs";

export { probeHealth };

/** The pointer as written by `taskd`; `null` when there is none or it is junk. */
export function readPointer({ env = process.env, path } = {}) {
  const file = path ?? resolveRuntimePointerPath({ env });
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // An array is an object; it is also not a pointer.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed, path: file }
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the board to talk to, starting one if needed.
 *
 * @param {{url?: string|null, env?: NodeJS.ProcessEnv, pointerPath?: string, waitMs?: number}} [options]
 * @returns {Promise<{url: string, autostarted: boolean, pointer: object|null}>}
 * @throws {DomainError} CLI_IO when there is no board and none may be started
 */
export async function ensureBoard(options = {}) {
  const { url = null, env = process.env, pointerPath, waitMs = AUTOSTART_TIMEOUT_MS } = options;

  if (typeof url === "string" && url.trim() !== "") {
    return { url: url.replace(/\/+$/, ""), autostarted: false, pointer: null };
  }

  const pointer = readPointer(pointerPath === undefined ? { env } : { env, path: pointerPath });
  if (pointer !== null && typeof pointer.url === "string" && (await probeHealth(pointer.url))) {
    return { url: pointer.url.replace(/\/+$/, ""), autostarted: false, pointer };
  }

  if (env[NO_AUTOSTART_ENV] === "1" || env[NO_AUTOSTART_ENV] === "true") {
    // The pointer's *path* is deliberately not echoed (M3fix D3): it is a host
    // absolute path, and this refusal is echoed to MCP clients. The file name is
    // kept, because that is what a human needs to fix it and it names no host.
    throw ioError(
      pointer === null
        ? `no board is running and ${NO_AUTOSTART_ENV} is set, so none was started`
        : `the board named by the runtime pointer is not answering and ${NO_AUTOSTART_ENV} is set, so none was started`,
      {
        details: { noAutostart: true, pointer: pointer?.path === undefined ? null : basename(pointer.path) },
        hint: {
          fix: `start one with \`node src/server/main.mjs\`, or pass --url <url>, or unset ${NO_AUTOSTART_ENV}`,
        },
      },
    );
  }

  const started = await spawnTaskd({
    env,
    pointerPath: pointerPath ?? resolveRuntimePointerPath({ env }),
    waitMs,
  });
  return { url: started.url.replace(/\/+$/, ""), autostarted: true, pointer: started.pointer };
}
