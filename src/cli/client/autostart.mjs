/**
 * Starting `taskd` when there is none (§F-A1) — the one place the CLI spawns a
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
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTOSTART_POLL_MS, AUTOSTART_TIMEOUT_MS, LOGS_DIRNAME } from "../../shared/constants.mjs";
import { resolveDataDir } from "../../shared/runtime-locator.mjs";
import { ioError } from "../errors.mjs";

/** Repository root, from `src/cli/client/`. */
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
 * @param {{env?: NodeJS.ProcessEnv, pointerPath: string, waitMs?: number, spawnFn?: Function}} options
 * @returns {Promise<{url: string, pointer: object|null, pid: number|null, logFile: string}>}
 */
export async function spawnTaskd(options) {
  const {
    env = process.env,
    pointerPath,
    waitMs = AUTOSTART_TIMEOUT_MS,
    spawnFn = spawn,
  } = options;

  const dataDir = resolveDataDir({ env });
  const logDir = join(dataDir, LOGS_DIRNAME);
  const logFile = join(logDir, "taskd.log");
  mkdirSync(logDir, { recursive: true });

  // Append, so a second start does not erase the evidence of the first one's
  // failure. The fd is closed in the parent immediately: the child holds it.
  const fd = openSync(logFile, "a");
  let child;
  try {
    child = spawnFn(process.execPath, [serverEntry()], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
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

  const started = await waitForPointer({ pointerPath, timeoutMs: waitMs, pid: child.pid ?? null });
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
 * @param {{pointerPath: string, timeoutMs?: number, pollMs?: number, pid?: number|null, readFile?: Function, sleep?: Function, now?: Function}} options
 */
export async function waitForPointer(options) {
  const {
    pointerPath,
    timeoutMs = AUTOSTART_TIMEOUT_MS,
    pollMs = AUTOSTART_POLL_MS,
    pid = null,
    readFile = (file) => readFileSync(file, "utf8"),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const deadline = now() + timeoutMs;
  // The deadline check happens *after* the first read, so a board that was
  // already up costs one stat rather than one poll interval.
  for (;;) {
    const pointer = readPointerFile(pointerPath, readFile);
    if (pointer !== null && typeof pointer.url === "string" && (pid === null || pointer.pid === undefined || pointer.pid === pid)) {
      return pointer;
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
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
