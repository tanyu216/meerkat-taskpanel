/**
 * The boot ledger and its restart ladder for the loop's long-lived entries.
 *
 * A service manager restarts a dead process immediately. That is the right
 * answer for a crash after a working start, and the wrong answer for a boot that
 * never worked: a deterministic fault becomes a hot loop, and the log fills
 * faster than a human can read it. This module keeps one record —
 * `supervisor.health.json` beside the loop's other state — and delays only the
 * second case.
 *
 * The record the contract fixes:
 *
 * ```json
 * {
 *   "startedAt": "2026-01-02T03:04:05.678Z",
 *   "pid": 4242,
 *   "version": "0.2.0",
 *   "lastCrash": null,
 *   "starts": ["2026-01-02T03:04:05.678Z"],
 *   "bootFailures": 0
 * }
 * ```
 *
 * `starts` is a bounded history (the most recent {@link START_HISTORY_LIMIT}
 * starts), so the file cannot grow without end. `bootFailures` counts
 * **consecutive** starts that never completed a first tick; a completed first
 * tick resets it, and a crash after that is recorded but never delayed. Exit 78
 * (`EX_CONFIG` — a permanent fault) is not counted: systemd stops restarting it,
 * so counting would only poison the next deliberate start.
 *
 * The ladder, once the streak passes {@link BOOT_FAILURE_THRESHOLD}:
 * `5 s → 15 s → 60 s → 300 s` (cap). The delay happens **before the process
 * exits**, so the service manager's restart is what is delayed. The ordinary
 * exit path awaits a timer in the caller; the crash boundary calls
 * {@link blockingSleep} because it runs inside a dying process whose own timebox
 * must still cover the delay.
 *
 * The record is shared by the loop's long-lived entries (`taskctl pool`,
 * `taskctl subscribe`, the daemon clocks): there is one supervisor per machine, and
 * the record describes the most recent long-lived start. The one-shot
 * ping/continue entries exit on every tick and do not arm it.
 *
 * Observability is never allowed to break the entry: a state directory that
 * cannot be written is logged once and the process carries on.
 *
 * Node builtins only.
 */

import { registerFatalHook } from "../foundation/crash-guard.mjs";
import { readJsonFile, writeJsonFile } from "../foundation/daemon-state.mjs";

/** Consecutive failed boots tolerated before the ladder starts. */
export const BOOT_FAILURE_THRESHOLD = 3;

/** The ladder. The last value is the cap; a longer streak does not grow it. */
export const BOOT_BACKOFF_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);

/** How many start timestamps the record keeps. */
export const START_HISTORY_LIMIT = 20;

/**
 * How long to delay a failing boot, in milliseconds.
 *
 * @param {unknown} bootFailures consecutive failed boots
 * @returns {number}
 */
export function bootDelayMs(bootFailures) {
  const count = Number(bootFailures);
  if (!Number.isInteger(count) || count <= BOOT_FAILURE_THRESHOLD) return 0;
  const index = Math.min(count - BOOT_FAILURE_THRESHOLD - 1, BOOT_BACKOFF_MS.length - 1);
  return BOOT_BACKOFF_MS[index];
}

/**
 * The record for a process that just started.
 *
 * @param {object|null} previous the record on disk
 * @param {{startedAt: string, pid: number, version: string}} start
 * @returns {{startedAt: string, pid: number, version: string, lastCrash: string|null, starts: string[], bootFailures: number}}
 */
export function startRecord(previous, { startedAt, pid, version }) {
  const previousStarts = Array.isArray(previous?.starts)
    ? previous.starts.filter((entry) => typeof entry === "string")
    : [];
  return {
    startedAt,
    pid,
    version,
    lastCrash: typeof previous?.lastCrash === "string" ? previous.lastCrash : null,
    starts: [...previousStarts, startedAt].slice(-START_HISTORY_LIMIT),
    bootFailures: positiveInteger(previous?.bootFailures),
  };
}

/**
 * The record after a first tick completed: the boot worked, so the streak ends.
 *
 * @param {object} record
 * @returns {object}
 */
export function firstTickRecord(record) {
  return { ...record, bootFailures: 0 };
}

/**
 * The record after a start that never completed a first tick.
 *
 * @param {object} record
 * @param {{lastCrash: string}} crash
 * @returns {object}
 */
export function failureRecord(record, { lastCrash }) {
  return { ...record, lastCrash, bootFailures: positiveInteger(record?.bootFailures) + 1 };
}

/** A non-negative integer from an untrusted value. */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/**
 * A deliberate synchronous sleep for the crash boundary.
 *
 * `Atomics.wait` blocks this thread without a busy loop. The process is already
 * dying, so blocking it is the point: the exit (and therefore the restart) is
 * what the ladder delays.
 *
 * @param {number} ms
 */
export function blockingSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Arm the boot ledger for one long-lived entry.
 *
 * @param {{
 *   path: string,
 *   log?: (line: string, fields?: object) => void,
 *   now?: () => number,
 *   pid?: number,
 *   version?: string,
 *   read?: (path: string) => unknown,
 *   write?: (path: string, value: unknown) => void,
 *   sleepSync?: (ms: number) => void,
 * }} options
 * @returns {{
 *   noteFirstTick: () => void,
 *   settle: (code: number) => {delayMs: number},
 *   crashSync: () => void,
 * }}
 */
export function beginBootHealth(options) {
  const {
    path,
    log = () => {},
    now = Date.now,
    pid = process.pid,
    version = "unknown",
    read = readJsonFile,
    write = writeJsonFile,
    sleepSync = blockingSleep,
  } = options;

  let warned = false;
  const safeRead = (file) => {
    try {
      return typeof read === "function" ? read(file) : null;
    } catch {
      return null;
    }
  };
  const safeWrite = (file, value) => {
    try {
      write(file, value);
    } catch (err) {
      if (!warned) {
        warned = true;
        log(`health: could not write ${file}: ${err?.message ?? String(err)}`, { level: "warn" });
      }
    }
  };
  const stamp = () => new Date(now()).toISOString();

  let record = startRecord(safeRead(path), {
    startedAt: stamp(),
    pid,
    version,
  });
  let firstTick = false;
  let finished = false;
  let unregister = () => {};
  safeWrite(path, record);

  const noteFirstTick = () => {
    if (firstTick) return;
    firstTick = true;
    record = firstTickRecord(record);
    safeWrite(path, record);
  };

  const settle = (code) => {
    if (finished) return { delayMs: 0 };
    finished = true;
    unregister();
    // A clean stop is not a failure; 78 is a permanent fault the manager is told
    // not to restart, so neither may grow the streak.
    if (code === 0) return { delayMs: 0 };
    if (code === 78) return { delayMs: 0 };
    if (firstTick) {
      record = { ...record, lastCrash: stamp() };
      safeWrite(path, record);
      return { delayMs: 0 };
    }
    record = failureRecord(record, { lastCrash: stamp() });
    const delayMs = bootDelayMs(record.bootFailures);
    if (delayMs > 0) reportCrashLoop(log, record, delayMs, path);
    safeWrite(path, record);
    return { delayMs };
  };

  const crashSync = () => {
    if (finished) return;
    finished = true;
    unregister();
    if (firstTick) {
      // A crash after a successful run: record it, restart immediately.
      record = { ...record, lastCrash: stamp() };
      safeWrite(path, record);
      return;
    }
    record = failureRecord(record, { lastCrash: stamp() });
    const delayMs = bootDelayMs(record.bootFailures);
    if (delayMs > 0) reportCrashLoop(log, record, delayMs, path);
    safeWrite(path, record);
    if (delayMs > 0) sleepSync(delayMs);
  };

  // The entry may be running inside another entry's process (the CLI dispatcher),
  // so its last words ride the one installed crash boundary.
  unregister = registerFatalHook(crashSync);

  return { noteFirstTick, settle, crashSync };
}

/**
 * The one `crash_loop` record, emitted before the delay so the reason is
 * readable while the process is still sleeping.
 */
function reportCrashLoop(log, record, delayMs, path) {
  log(`health: ${record.bootFailures} consecutive failed boots — delaying the restart by ${delayMs}ms`, {
    event: "crash_loop",
    level: "error",
    boot_failures: record.bootFailures,
    delay_ms: delayMs,
    started_at: record.startedAt,
    health_path: path,
  });
}
