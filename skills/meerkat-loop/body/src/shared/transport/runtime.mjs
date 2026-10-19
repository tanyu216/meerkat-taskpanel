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
 * Step 2 has two halves, because a board is not always the one holding the
 * machine-wide slot (R1, `core/storage/secrets/runtime-pointer.mjs`): a board
 * whose data directory is *not* the sitting board's is addressed beside its own
 * data directory, at `<dataDir>/runtime.json`. Writing that file is only half of
 * the rule — until the reader below consulted it, the board that had just been
 * pushed off the slot was unreachable while it ran, and `taskctl` in *its* data
 * directory answered from (or failed on) the other board's address.
 *
 * A *stale* pointer is the interesting case: a pointer whose process died is
 * indistinguishable from a live one until you knock. So the pointer is only
 * believed after `/health` answers, and a dead address falls through to the
 * autostart path rather than producing a confusing connection error.
 *
 * Shared (extracted from `src/cli/runtime.mjs`) so the board resolves identically
 * from every entry point that uses the seam.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  AUTOSTART_TIMEOUT_MS,
  NO_AUTOSTART_ENV,
  RUNTIME_POINTER_ENV,
} from "../constants.mjs";
import {
  resolveDataDir,
  resolveRuntimePointerPath,
  runtimePointerPathForDataDir,
} from "../runtime-locator.mjs";
import { ioError } from "./errors.mjs";
import { probeHealth, spawnTaskd } from "./autostart.mjs";

export { probeHealth };

/** A non-empty string, with the whitespace-only case treated as absent. */
function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** The pointer file at exactly this path; `null` when it is missing or junk. */
function readPointerFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    // An array is an object; it is also not a pointer.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed, path }
      : null;
  } catch {
    return null;
  }
}

/** The path the caller *named*, or `null` when the machine-wide slot is in play. */
function namedPointerPath({ env, path, platform, home }) {
  // An explicit `path` is obeyed as given — including a relative one, which is
  // how the callers (and the tests) have always handed it over.
  if (typeof path === "string") return path;
  return hasText(env[RUNTIME_POINTER_ENV]) ? resolveRuntimePointerPath({ env, platform, home }) : null;
}

/** Does this pointer name a board whose data directory is not `dataDir`? */
function namesAnotherBoard(pointer, dataDir) {
  const named = pointer.dataDir;
  return hasText(named) && resolve(named) !== resolve(dataDir);
}

/**
 * The pointer this client's *own* board wrote beside its data directory, or
 * `null` when the fallback does not apply.
 *
 * It applies when the machine-wide slot does **not** name this board: either the
 * slot is absent or unreadable, or it names another board (a different data
 * directory).
 *
 * A pointer that parses but carries no usable `dataDir` — absent, empty or blank
 * — is **not** one of those cases: it is unowned, yet the slot's address still
 * stands and nothing falls back to the local file. The write side answers the
 * same unowned pointer the other way round — `liveForeignHolder` sees nobody to
 * protect and takes the slot, `removeRuntimePointer` removes it — so "a pointer
 * with no owner protects nobody" is a rule about *overwriting*, not about which
 * address a reader believes. The read and write sides are not symmetric here, and
 * the rule must not be carried across.
 *
 * @param {{env: NodeJS.ProcessEnv, dataDir: string|null, incumbent: object|null}} input
 * @returns {object|null}
 */
function ownBoardPointer({ env, dataDir, incumbent }) {
  // `dataDir` is the caller's own board; with none named, this is exactly the
  // directory `ensureBoard` would start a board for (`spawnTaskd` resolves it
  // the same way), so the reader and the writer of this path agree.
  const own = resolveDataDir({ dataDir, env });
  if (incumbent !== null && !namesAnotherBoard(incumbent, own)) return null;

  // One implementation of "beside its data directory", shared with the parent
  // that waits for the daemon it spawns (`autostart.mjs`).
  const local = readPointerFile(runtimePointerPathForDataDir(own));
  return hasText(local?.url) ? local : null;
}

/**
 * The pointer to believe (R1, read side).
 *
 * A *named* path — an explicit `path`, or `TASKD_RUNTIME_POINTER` — is obeyed
 * verbatim, exactly as the write side obeys it: the caller has already chosen
 * the board's namespace.
 *
 * Otherwise the machine-wide slot is read, and when it does not name this
 * caller's board, the data directory's own `runtime.json` is preferred over it
 * (`ownBoardPointer` above). `dataDir` defaults to the caller's resolved data
 * directory — `$TASKD_DATA_DIR` or `<repo>/.data`.
 *
 * @param {{env?: NodeJS.ProcessEnv, path?: string, dataDir?: string|null, platform?: string, home?: string}} [options]
 * @returns {object|null} the pointer, with the file it came from under `path`
 */
export function readPointer({ env = process.env, path, dataDir = null, platform, home } = {}) {
  const named = namedPointerPath({ env, path, platform, home });
  const file = named ?? resolveRuntimePointerPath({ env, platform, home });
  const pointer = readPointerFile(file);
  if (named !== null) return pointer;
  return ownBoardPointer({ env, dataDir, incumbent: pointer }) ?? pointer;
}

/**
 * Does this pointer name an address that answers `/health`?
 * @param {object|null} pointer
 * @returns {Promise<boolean>}
 */
async function answers(pointer) {
  return pointer !== null && typeof pointer.url === "string" && (await probeHealth(pointer.url));
}

/**
 * The machine-wide slot, when it answers and this invocation may still consult
 * it: it did not *name* a path, and the preferred pointer did not come from the
 * slot itself.
 *
 * It is a candidate because the data-directory fallback can be a fossil — a
 * board killed before it could remove the file beside its own data directory —
 * while the board in the slot is up and answering. That board is the one to
 * answer from, and it is cheap to ask: one `/health` against an address we are
 * already looking at, rather than a daemon spawned for a board that was running
 * the whole time.
 *
 * It is *only* a candidate: an address that does not answer `/health` is not
 * believed here, and until T-20261014-044653 the autostart that followed could
 * take that board's address from it (the spawned daemon was *named* the
 * machine-wide path, so the write side's "never displace a live board" rule did
 * not apply to it). That door is shut in `spawnTaskd`; this candidate remains
 * what it always was — the ordinary "which board is up" answer.
 *
 * @param {{env: NodeJS.ProcessEnv, pointerPath: string|undefined, preferred: object|null, platform?: string, home?: string}} input
 * @returns {Promise<object|null>}
 */
async function answeredSlotPointer({ env, pointerPath, preferred, platform, home }) {
  // A *named* path (the option, or `TASKD_RUNTIME_POINTER`) means the namespace
  // is the caller's and the machine-wide slot is not this invocation's to reach
  // into; and when `preferred` *is* the slot's own pointer, it has already
  // answered no. Either way there is nothing to add.
  if (pointerPath !== undefined) return null;
  const slotPath = resolveRuntimePointerPath({ env, platform, home });
  if (preferred !== null && preferred.path === slotPath) return null;

  const slot = readPointer({ env, path: slotPath });
  return slot !== null && (await answers(slot)) ? slot : null;
}

/**
 * Resolve the board to talk to, starting one if needed.
 *
 * The pointer step is `readPointer`'s — data-directory fallback included — with
 * the machine-wide slot as a second candidate before anything is spawned (see
 * `answeredSlotPointer`). The token the CLI resolved from the same call belongs
 * to this invocation's board rather than to the slot's; a board this process
 * starts itself is on loopback, where no token is required at all
 * (`server/auth.mjs`).
 *
 * @param {{url?: string|null, env?: NodeJS.ProcessEnv, pointerPath?: string, waitMs?: number, platform?: string, home?: string}} [options]
 *   `platform`/`home` mean the same thing they do to `resolveRuntimePointerPath`
 *   — they are how a test pins the machine-wide slot somewhere harmless.
 * @returns {Promise<{url: string, autostarted: boolean, pointer: object|null}>}
 * @throws {DomainError} CLI_IO when there is no board and none may be started
 */
export async function ensureBoard(options = {}) {
  const {
    url = null,
    env = process.env,
    pointerPath,
    waitMs = AUTOSTART_TIMEOUT_MS,
    platform,
    home,
  } = options;

  if (typeof url === "string" && url.trim() !== "") {
    return { url: url.replace(/\/+$/, ""), autostarted: false, pointer: null };
  }

  const pointer = readPointer(pointerPath === undefined ? { env, platform, home } : { env, path: pointerPath });
  if (await answers(pointer)) {
    return { url: pointer.url.replace(/\/+$/, ""), autostarted: false, pointer };
  }

  const slot = await answeredSlotPointer({ env, pointerPath, preferred: pointer, platform, home });
  if (slot !== null) {
    return { url: slot.url.replace(/\/+$/, ""), autostarted: false, pointer: slot };
  }

  if (env[NO_AUTOSTART_ENV] === "1" || env[NO_AUTOSTART_ENV] === "true") {
    // The pointer's *path* is deliberately not echoed (M3fix D3): it is a host
    // absolute path, and this refusal is surfaced to callers. The file name is
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
    // Handed over only when the caller named it. Without a name the daemon picks
    // its own file — the write side's rule, which the *parent* must not override:
    // naming the machine-wide path here is what let a spawned daemon take the
    // address of a live board that was merely unhealthy (T-20261014-044653, see
    // `spawnTaskd`'s header).
    pointerPath,
    platform,
    home,
    waitMs,
  });
  return { url: started.url.replace(/\/+$/, ""), autostarted: true, pointer: started.pointer };
}
