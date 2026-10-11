#!/usr/bin/env node
/**
 * The implementation leg of the `ui-align` machine check.
 *
 * `~/.openclaw/team/tools/ui-align/check.mjs` compares the prototype against a
 * running implementation. It bootstraps that implementation itself from
 * `devServer.cmd` in `web/.ui-align.json`, handing the command a free port via
 * the `{port}` placeholder — so the command has to be a process that serves the
 * board on a port it is told, and prints nothing that matters.
 *
 * That process is **the fixture harness, not a dev server**, on purpose:
 *
 *   * the tool wants the *offline* state — structurally complete, zero network
 *     (`tools/ui-align/README.md` §3, last note). Vite's dev server would proxy
 *     `/api` at the real `taskd` on :9527, so the check would depend on a second
 *     process and on whatever is in that board's database;
 *   * this serves exactly what `dom-smoke.mjs` serves to the DOM contract test —
 *     the same fixture API, the same `web/dist` — so the two harnesses cannot
 *     disagree about what the app renders;
 *   * it needs no build step and no database, so the check is reproducible.
 *
 * Under `web/scripts/`, not `test/`, so `node --test` never collects it.
 *
 * Usage: node web/scripts/ui-align-serve.mjs [--port <n>]
 *   (0 or omitted = an ephemeral port; the engine always passes one.)
 */

import { startServer } from "./dom-smoke.mjs";

const argv = process.argv.slice(2);
let port = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
  else if (a === "--port") port = Number(argv[++i]);
  else {
    process.stderr.write(`unknown argument: ${a}\n`);
    process.exit(2);
  }
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`--port must be 0-65535, got ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const { server, port: bound } = await startServer({ port });
process.stdout.write(`ui-align impl (fixture) listening on http://127.0.0.1:${bound}\n`);

/* The engine kills the whole process group, so these are for a human who ran it
 * by hand; `unref` is deliberately not used — the server must hold the loop. */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
