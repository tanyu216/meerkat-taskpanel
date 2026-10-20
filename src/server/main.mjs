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
import { DEFAULT_HOST, DEFAULT_PORT, HOST_ENV, PORT_ENV, VERSION } from "../shared/constants.mjs";
import { loadEnvFile } from "../shared/env-config.mjs";
import { repoRoot } from "../shared/runtime-locator.mjs";
import { createTaskd } from "./index.mjs";
import { isEntryPoint } from "../shared/entry-guard.mjs";

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
  const lock = acquireWriterLock(dataDir);

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

  process.stdout.write(`taskd ${VERSION} listening on ${taskd.url}\n`);
  process.stdout.write(`runtime pointer: ${written.path}\n`);
  if (written.heldBy !== undefined) {
    process.stdout.write(
      `runtime pointer note: the machine-wide pointer names pid ${written.heldBy}, another board — ` +
        `this one is addressed beside its data directory, so that board is left alone\n`,
    );
  }
  process.stdout.write(`write lock: ${lock.path}\n`);

  const shutdown = createShutdown({ taskd, pointerOptions });
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
 * @param {{taskd: {close: Function}, pointerOptions: object, exit?: Function, write?: Function}} input
 * @returns {(signal: string) => Promise<void>}
 */
export function createShutdown(input) {
  const { taskd, pointerOptions, exit = (code) => process.exit(code), write = (text) => process.stdout.write(text) } = input;
  let closing = false;
  return async function shutdown(signal) {
    // A second signal while the first is still closing must not close twice —
    // closed twice, the pointer would be removed after a fresh board had
    // rewritten it.
    if (closing) return;
    closing = true;
    write(`\ntaskd: ${signal} — closing\n`);
    try {
      await taskd.close();
    } finally {
      removeRuntimePointer(pointerOptions);
      exit(0);
    }
  };
}

// Only run when executed directly — importing this module (tests, tooling) must
// not bind a port.
if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`taskd: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
