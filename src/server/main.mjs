#!/usr/bin/env node
/**
 * The `taskd` executable — what the CLI spawns when no board is running.
 *
 * It is a thin wrapper over `createTaskd` that adds the four things only a real
 * daemon needs:
 *
 *   1. **the write lock** (R1), taken *before* the database is opened: one owner
 *      per data directory, so a second daemon is refused instead of becoming a
 *      second writer (`storage/writer-lock.mjs`);
 *   2. **the runtime pointer**, written *after* `listen` and with the port the
 *      OS actually assigned. Writing it at startup is the classic bug: with
 *      `TASKD_PORT=0` the pointer would say `:0` and nothing could ever find the
 *      board;
 *   3. **signal handling**, so `SIGTERM` closes the connection and removes the
 *      pointer rather than leaving a stale one behind for the next `taskctl` —
 *      and removes it *only while it still names this process **and this data
 *      directory*** (R1), so an exiting instance can never unplug a live one;
 *   4. **the address on stdout**, so a human who started it by hand can see
 *      where it went.
 *
 * Started like any other module: `node src/server/main.mjs`.
 */

import { acquireWriterLock, removeRuntimePointer, resolveDataDir, writeRuntimePointer } from "../core/index.mjs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HOST_ENV,
  LOG_KEEP_DEFAULT,
  LOG_KEEP_ENV,
  LOG_MAX_BYTES_DEFAULT,
  LOG_MAX_BYTES_ENV,
  PORT_ENV,
  VERSION,
} from "../foundation/constants.mjs";
import { loadEnvFile } from "../foundation/env-config.mjs";
import { createFileSink, createLogger, levelFromEnv, stderrSink } from "../foundation/log.mjs";
import { logFilePath, repoRoot } from "../foundation/runtime-locator.mjs";
import { createTaskd } from "./index.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";

/** A positive integer from the environment, else the default. `0` means "unset". */
function positiveInt(raw, fallback) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : fallback;
}

/**
 * The daemon's logger: stderr for the console, `<dataDir>/logs/taskd.log` for
 * the durable record, rotated by size.
 *
 * The application owns the file. The service manager and the CLI's lazy start
 * deliberately do not redirect into it any more — one writer, one history.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dataDir
 */
export function createDaemonLogger(env, dataDir) {
  const level = levelFromEnv(env);
  const logger = createLogger({
    level: level.level,
    sinks: [
      stderrSink,
      createFileSink({
        path: logFilePath(dataDir),
        maxBytes: positiveInt(env[LOG_MAX_BYTES_ENV], LOG_MAX_BYTES_DEFAULT),
        keep: positiveInt(env[LOG_KEEP_ENV], LOG_KEEP_DEFAULT),
      }),
    ],
    meta: { service: "taskd", version: VERSION, pid: process.pid, data_dir: dataDir },
  });
  if (!level.valid) {
    logger({ event: "log_level_invalid", value: level.raw, fallback: level.level });
  }
  return logger;
}

/**
 * `TASKD_PORT` may be 0 (ephemeral) — do not treat it as "unset".
 *
 * Digits only: `-1`, `abc` and `12.5` are typos, and `parseInt` would happily
 * turn the last one into `12` and bind a port nobody asked for. An unusable
 * value falls back to the default, which is a visible, explainable port.
 */
export function portFromEnv(env) {
  const raw = env[PORT_ENV];
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 0 && parsed <= 65535 ? parsed : undefined;
}

export async function main(env = process.env, options = {}) {
  const { register = true } = options;

  // `.env` is a *server* input too: host/port/data dir/allow-list/acceptance.
  // The process environment wins key by key, so an operator's override is
  // unchanged. The raw `env` is kept separately for the two readers whose
  // `source` the Access panel shows.
  const config = loadEnvFile({
    env,
    root: repoRoot(),
    ...(options.envFile === undefined ? {} : { flag: options.envFile }),
  });
  const effectiveEnv = config.env;

  // R1 — the write lock comes first: it must be held *before* a second
  // connection to the same board can be opened. A refusal here is a clean
  // `BOARD_ALREADY_RUNNING` (the caller prints it and exits non-zero), which is
  // what turns "two daemons fight over the pointer" into "the second one never
  // started".
  const dataDir = resolveDataDir({ dataDir: options.dataDir ?? null, env: effectiveEnv });
  // Before the lock: a stale-lock takeover is the first event worth recording,
  // and it is raised by the lock itself.
  const logger = createDaemonLogger(effectiveEnv, dataDir);
  const lock = acquireWriterLock(dataDir, { logger });

  let taskd;
  try {
    taskd = await createTaskd({
      host: effectiveEnv[HOST_ENV] ?? DEFAULT_HOST,
      port: portFromEnv(effectiveEnv) ?? DEFAULT_PORT,
      env: effectiveEnv,
      processEnv: env,
      // The resolved path even when the file does not exist yet: an Access-panel
      // save creates it (0600), which is how a board started before `install.sh`
      // seeded one still gets a writable policy file.
      envFile: config.file,
      envVars: config.vars,
      logger,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    });
  } catch (err) {
    // Nothing is listening, so nothing may keep the lock.
    lock.release();
    throw err;
  }

  // The lock lives exactly as long as the board does. Wrapping `close` (rather
  // than adding a step to `createShutdown`) keeps the two entry points — the
  // signal handler and a library caller that closes the board itself — on one
  // path, so there is no way to close a board and leave its lock behind.
  const boardClose = taskd.close.bind(taskd);
  taskd.close = async () => {
    try {
      await boardClose();
    } finally {
      lock.release();
    }
  };

  // The pointer records `pid`, and `pid` + `dataDir` together are what let the
  // daemon remove *its own* pointer on exit and nobody else's (R1). `written.path`
  // is the file it actually owns: the machine-wide one, or the data directory's
  // own when a live board with another data directory held that slot.
  const written = writeRuntimePointer(
    {
      url: taskd.url,
      host: taskd.host,
      port: taskd.port,
      dataDir: taskd.board.dataDir,
      tokenFile: taskd.board.token?.file ?? null,
      pid: process.pid,
    },
    { env: effectiveEnv, pid: process.pid },
  );
  const pointerOptions = { path: written.path, pid: process.pid, dataDir: taskd.board.dataDir };

  // One record per fact: the address a human needs, where the pointer went, and
  // which lock this process owns. `url` is a bare field so it stays parseable.
  logger({
    event: "startup",
    url: taskd.url,
    host: taskd.host,
    port: taskd.port,
    message: `listening on ${taskd.url}`,
  });
  logger({
    event: "runtime_pointer",
    path: written.path,
    ...(written.heldBy === undefined ? {} : { held_by: written.heldBy }),
  });
  logger({ event: "write_lock", path: lock.path });

  const shutdown = createShutdown({ taskd, pointerOptions, logger });
  if (register) {
    // One handler for both signals: the signal name is a label, not behaviour.
    const onSignal = (signal) => {
      void shutdown(signal);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  return taskd;
}

/**
 * The shutdown handler, as a value.
 *
 * Extracted from `main` for one reason: "SIGTERM closes the connection *and*
 * removes the pointer" is the promise the CLI's autostart depends on, and a
 * promise reachable only by signalling a live process is a promise nobody tests.
 * The injected `exit`/`write` make it a plain function.
 *
 * `pointerOptions` carries the daemon's `pid`, its `dataDir` and — via `path` —
 * the file it wrote (R1), so the removal is ownership-checked on all three: this
 * process removes the pointer while it still names this process *and this
 * board*, and leaves a stranger's pointer alone.
 *
 * @param {{taskd: {close: Function}, pointerOptions: object, exit?: Function, logger?: Function}} input
 * @returns {(signal: string) => Promise<void>}
 */
export function createShutdown(input) {
  const {
    taskd,
    pointerOptions,
    exit = (code) => process.exit(code),
    // A caller that supplied no logger (a library close) gets silence rather
    // than an unexpected stderr line.
    logger = () => {},
  } = input;
  let closing = false;
  return async function shutdown(signal) {
    // A second signal while the first is still closing must not close twice —
    // closed twice, the pointer would be removed after a fresh board had
    // rewritten it.
    if (closing) return;
    closing = true;
    const started = Date.now();
    logger({ event: "shutdown_signal", signal, message: `${signal} — closing` });
    try {
      await taskd.close();
    } catch (err) {
      logger({
        event: "shutdown_failed",
        level: "error",
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
      throw err;
    } finally {
      removeRuntimePointer(pointerOptions);
      logger({ event: "shutdown_complete", duration_ms: Date.now() - started });
      exit(0);
    }
  };
}

// Only run when executed directly — importing this module (tests, tooling) must
// not bind a port.
if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    // The daemon never came up, so this record is the only evidence. It gets the
    // same sinks as a running daemon when the data directory can be resolved;
    // otherwise stderr is still there. The stack is included here deliberately:
    // a startup crash is the one case where debug output is not optional.
    const failure = err instanceof Error
      ? {
          name: err.name,
          ...(typeof err.code === "string" ? { code: err.code } : {}),
          message: err.message,
          stack: err.stack,
        }
      : String(err);
    let logger;
    try {
      logger = createDaemonLogger(process.env, resolveDataDir({ env: process.env }));
    } catch {
      logger = createLogger({ level: levelFromEnv(process.env).level });
    }
    logger({ event: "startup_failed", level: "error", error: failure });
    process.exit(1);
  });
}
