/**
 * Starting `taskd` when there is none (§F-A1) — the one place the client spawns a
 * process, and therefore the one place worth reading carefully.
 *
 * The sequence, and why each step is where it is:
 *
 *   1. **spawn `node src/server/main.mjs`, detached**, with stdout/stderr going
 *      to `<dataDir>/logs/taskd.log` (a daemon that inherits the terminal dies
 *      with it, and its output would corrupt `--json`);
 *   2. **wait for the runtime pointer**, not for a fixed sleep. The pointer is
 *      written *after* `listen` and therefore carries the port the OS actually
 *      assigned — which is the only way `TASKD_PORT=0` can work at all;
 *   3. **probe `/health`** on the address the pointer names, and only then hand
 *      the URL back.
 *
 * A stale pointer from a dead process is handled by comparing `pid`: if the file
 * still points at the pid we just started (or a live one), its URL is the right
 * one to try.
 *
 * **Which file the child writes is the child's decision, not this function's**
 * (T-20261014-044653). The write side refuses to displace a live *other* board —
 * it is addressed beside its own data directory instead — and that rule has a
 * hole exactly here: a `TASKD_RUNTIME_POINTER` handed to the child is *named*, and
 * a named pointer is obeyed verbatim, so a daemon started by this function would
 * overwrite whatever the machine-wide slot held. That is harmless while the
 * sitting board is healthy (`ensureBoard` believes it and never gets here), but a
 * board that is **reachable and unhealthy** — still holding its port, `/health`
 * not `ok` — is one autostart away from losing its address to a board that had no
 * business taking it. So: the path is named only when the *caller* named one, and
 * otherwise the parent waits at **both** places the child may have written
 * (`waitForPointer`), believing only a file that names the pid it just started.
 *
 * Shared (extracted from `src/cli/client/autostart.mjs`) so starting the daemon
 * lives below the CLI rather than inside it; the CLI's stdout-redirection
 * guarantee is what keeps a spawned daemon off the caller's stdout.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTOSTART_POLL_MS,
  AUTOSTART_TIMEOUT_MS,
  LOG_FILENAME,
  LOGS_DIRNAME,
  RUNTIME_POINTER_ENV,
  SPAWN_ENV_OMIT,
} from "../constants.mjs";
import { resolveDataDir, resolveRuntimePointerPath, runtimePointerPathForDataDir } from "../runtime-locator.mjs";
import { ioError } from "./errors.mjs";

/** Repository root, from `src/foundation/transport/`. */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** The executable `ensureBoard` spawns — `main.mjs`, not the library. */
export function serverEntry() {
  return join(repoRoot(), "src", "server", "main.mjs");
}

/**
 * Does something answer `/health` there? Never throws — a miss is a `false`.
 *
 * `/health` is the one route that may be read *before* trusting the service, so
 * it is checked structurally: any JSON body carrying `status: "ok"` is enough,
 * whether it arrives bare (the compose healthcheck curls it) or inside the usual
 * `{ok,data}` envelope (what this server actually sends).
 */
export async function probeHealth(url, { timeoutMs = 1_000 } = {}) {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok" || body?.data?.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Spawn `taskd` and wait until it answers.
 *
 * `pointerPath` is the file the caller named, and a name is either this option or
 * `TASKD_RUNTIME_POINTER` in `env` — the same two the reader accepts. When there
 * is no name at all the daemon picks its own file by the write side's rule, and
 * this function waits at both places it may have written (see the module header).
 *
 * `platform`/`home` mean what they do to `resolveRuntimePointerPath`, and they
 * must agree with `env`: the child sees `env` only. Production never passes them
 * (both default to the running process); a test pins the machine-wide slot with
 * them *and* `home` in `env`.
 *
 * @param {{env?: NodeJS.ProcessEnv, pointerPath?: string, waitMs?: number, platform?: string, home?: string, spawnFn?: Function}} options
 * @returns {Promise<{url: string, pointer: object|null, pid: number|null, logFile: string}>}
 */
export async function spawnTaskd(options) {
  const {
    env = process.env,
    pointerPath,
    waitMs = AUTOSTART_TIMEOUT_MS,
    platform,
    home,
    spawnFn = spawn,
  } = options;

  const dataDir = resolveDataDir({ env });
  const logDir = join(dataDir, LOGS_DIRNAME);
  const logFile = join(logDir, LOG_FILENAME);
  mkdirSync(logDir, { recursive: true });

  // A *named* pointer — the option, or `TASKD_RUNTIME_POINTER` — is the caller's
  // namespace: the child is told about it (it is obeyed verbatim by the write
  // side), and this function waits there. With no name the child decides, so
  // nothing is handed over and *both* files it could choose are watched; a
  // leftover pointer in either is only believed when it names the pid we just
  // started (`waitForPointer`'s `requireOwnPid`), because that is the only proof a
  // file is this child's own address.
  //
  // "Named" has to mean here exactly what it means to the reader
  // (`runtime.mjs#namedPointerPath`), or the parent would wait somewhere the child
  // never writes: the CLI calls this seam with the *option* unset and the variable
  // in `env` (the harness and the scheduling guard both run that way).
  const namedByEnv =
    typeof env[RUNTIME_POINTER_ENV] === "string" && env[RUNTIME_POINTER_ENV].trim() !== "";
  const named =
    typeof pointerPath === "string"
      ? pointerPath
      : namedByEnv
        ? resolveRuntimePointerPath({ env, platform, home })
        : null;
  const candidates =
    named !== null
      ? [named]
      : [resolveRuntimePointerPath({ env, platform, home }), runtimePointerPathForDataDir(dataDir)];
  const childEnv = { ...env };
  // The daemon needs the data directory, host/port and server policy; it does
  // not need a client credential or an agent identity. `MEERKAT_TASKPANEL_ENV_FILE`
  // is deliberately retained so the child reads the same config file.
  for (const key of SPAWN_ENV_OMIT) delete childEnv[key];
  if (typeof pointerPath === "string") childEnv[RUNTIME_POINTER_ENV] = pointerPath;
  else if (named === null) delete childEnv[RUNTIME_POINTER_ENV];
  // Named through the environment only: the variable is inherited exactly as the
  // caller set it, and the child resolves it to the same file this parent waits on.

  // Append, so a second start does not erase the evidence of the first one's
  // failure. The fd is closed in the parent immediately: the child holds it.
  const fd = openSync(logFile, "a");
  let child;
  try {
    child = spawnFn(process.execPath, [serverEntry()], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: childEnv,
    });
  } catch (err) {
    closeSync(fd);
    throw ioError(`could not start taskd: ${err.message}`, {
      details: { logFile },
      hint: { fix: "start it by hand (`node src/server/main.mjs`) to see the error" },
    });
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  child.unref?.();

  const started = await waitForPointer({
    pointerPaths: candidates,
    timeoutMs: waitMs,
    pid: child.pid ?? null,
    requireOwnPid: named === null,
  });
  if (started === null || !(await probeHealth(started.url, { timeoutMs: 2_000 }))) {
    throw ioError("taskd was started but never answered /health", {
      details: { logFile, pointer: pointerPath, pid: child.pid ?? null },
      hint: { fix: `read ${logFile}` },
    });
  }
  return { url: started.url, pointer: started, pid: child.pid ?? null, logFile };
}

/**
 * Poll for a *fresh* runtime pointer.
 *
 * "Fresh" means: the file exists, holds a `url`, and carries the pid we started
 * (or, when the pointer already existed, one that is not the dead one we read
 * before). Comparing pids is what keeps a stale file from being mistaken for the
 * new daemon's.
 *
 * `pointerPaths` names every file the child could have written, and the first
 * match wins. `requireOwnPid` tightens the pid test to an *exact* match: it is
 * for the files we did **not** name to the child, where a pointer without a pid
 * is some other board's leftover rather than the file we asked for.
 *
 * @param {{pointerPath?: string, pointerPaths?: string[], timeoutMs?: number, pollMs?: number, pid?: number|null, requireOwnPid?: boolean, readFile?: Function, sleep?: Function, now?: Function}} options
 */
export async function waitForPointer(options) {
  const {
    pointerPath,
    pointerPaths = [pointerPath],
    timeoutMs = AUTOSTART_TIMEOUT_MS,
    pollMs = AUTOSTART_POLL_MS,
    pid = null,
    requireOwnPid = false,
    readFile = (file) => readFileSync(file, "utf8"),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const deadline = now() + timeoutMs;
  // The deadline check happens *after* the first read, so a board that was
  // already up costs one stat rather than one poll interval.
  for (;;) {
    for (const path of pointerPaths) {
      const pointer = readPointerFile(path, readFile);
      if (pointer !== null && typeof pointer.url === "string" && isOurs(pointer, { pid, requireOwnPid })) {
        return pointer;
      }
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * Does this pointer name the process we started?
 *
 * The loose rule (any pointer, or one whose pid is unstated) is the historical
 * one, kept for a file the caller *named*; `requireOwnPid` narrows it to the pid
 * itself — nothing else identifies a file as the child's own write.
 *
 * @param {object} pointer
 * @param {{pid: number|null, requireOwnPid: boolean}} input
 */
function isOurs(pointer, { pid, requireOwnPid }) {
  if (pid === null) return !requireOwnPid;
  if (pointer.pid === pid) return true;
  return !requireOwnPid && pointer.pid === undefined;
}

/** @param {string} file @param {(file: string) => string} readFile */
function readPointerFile(file, readFile) {
  try {
    const parsed = JSON.parse(readFile(file));
    return parsed !== null && typeof parsed === "object" ? { ...parsed, path: file } : null;
  } catch {
    return null;
  }
}
