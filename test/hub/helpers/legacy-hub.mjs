/**
 * A stand-in for a live hub from another `HUB_PROTOCOL` generation.
 *
 * It owns the board's hub slot exactly like the real hub — the owner lock and a
 * pointer keyed by URL + token — but writes the *next* generation number and
 * refuses every hello, which is what an older hub does to a newer client. The
 * replacement tests use it to prove `ensureHub` evicts it instead of timing out.
 *
 * Usage: legacy-hub.mjs <board-url> <token>
 * Prints `{pid, port}` on stdout once the slot is held.
 */

import { createServer } from "node:net";

import {
  HUB_PROTOCOL,
  acquireLock,
  ensureHubDir,
  hubPaths,
  readJsonFile,
  removeFile,
  writeJsonFile,
} from "../../../src/cli/hub/runtime.mjs";

const [url, token = ""] = process.argv.slice(2);
if (url === undefined) {
  // `node --test` executes every `.mjs` under `test/`; a helper with no
  // arguments is not a test, so it exits clean instead of failing the suite.
  process.exit(0);
}

const paths = hubPaths(url, token, process.env);
ensureHubDir(paths.dir);

if (!acquireLock(paths.owner).ok) {
  process.stderr.write("legacy hub: the owner lock is already held\n");
  process.exit(3);
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", () => {
    // Another generation: refused, the way server.mjs refuses a mismatched hello.
    socket.write(`${JSON.stringify({ op: "hello", ok: false, error: "unauthorized" })}\n`);
    socket.end();
  });
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();

writeJsonFile(paths.pointer, {
  version: 1,
  protocol: HUB_PROTOCOL + 1,
  key: paths.key,
  pid: process.pid,
  port,
  token: "legacy-token",
  log: paths.log,
  startedAt: new Date().toISOString(),
});

process.stdout.write(`${JSON.stringify({ pid: process.pid, port })}\n`);

// Leave the slot the way the real stop() does: remove only the files that still
// name this process, then exit.
process.on("SIGTERM", () => {
  const pointer = readJsonFile(paths.pointer);
  if (pointer === null || pointer.pid === process.pid) removeFile(paths.pointer);
  const owner = readJsonFile(paths.owner);
  if (owner === null || owner.pid === process.pid) removeFile(paths.owner);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
});

setInterval(() => {}, 1_000);
