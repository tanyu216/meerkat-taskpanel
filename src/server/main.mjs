#!/usr/bin/env node
/**
 * The `taskd` executable — what the CLI spawns when no board is running.
 *
 * It is a thin wrapper over `createTaskd` that adds the three things only a real
 * daemon needs:
 *
 *   1. **the runtime pointer**, written *after* `listen` and with the port the
 *      OS actually assigned. Writing it at startup is the classic bug: with
 *      `TASKD_PORT=0` the pointer would say `:0` and nothing could ever find the
 *      board;
 *   2. **signal handling**, so `SIGTERM` closes the connection and removes the
 *      pointer rather than leaving a stale one behind for the next `taskctl`;
 *   3. **the address on stdout**, so a human who started it by hand can see
 *      where it went.
 *
 * Started like any other module: `node src/server/main.mjs`.
 */

import { pathToFileURL } from "node:url";

import { removeRuntimePointer, writeRuntimePointer } from "../core/index.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, HOST_ENV, PORT_ENV, VERSION } from "../shared/constants.mjs";
import { createTaskd } from "./index.mjs";

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
  const taskd = await createTaskd({
    host: env[HOST_ENV] ?? DEFAULT_HOST,
    port: portFromEnv(env) ?? DEFAULT_PORT,
    env,
  });

  const pointerOptions = { env };
  const written = writeRuntimePointer(
    {
      url: taskd.url,
      host: taskd.host,
      port: taskd.port,
      dataDir: taskd.board.dataDir,
      tokenFile: taskd.board.token?.file ?? null,
      pid: process.pid,
    },
    pointerOptions,
  );

  process.stdout.write(`taskd ${VERSION} listening on ${taskd.url}\n`);
  process.stdout.write(`runtime pointer: ${written.path}\n`);

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
const invoked = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (invoked !== null && invoked === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`taskd: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
