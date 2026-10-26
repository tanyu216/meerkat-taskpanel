/**
 * T-20261014-213238 — a signal must never be answered with a hang.
 *
 * The reported defect: `server.close()` waits for every open socket, an SSE
 * stream is an *active* request with no reason to ever end, and nothing ended it
 * — so `SIGTERM` hung past 30 s and every redeploy ended in `SIGKILL` (which
 * costs the graceful checkpoint, leaves the `-wal` behind and leaves a fossil
 * runtime pointer).
 *
 * Four things are asserted, cheapest first:
 *
 *   1. the frame the server sends when it stops is a *named*, id-less one, so it
 *      cannot be mistaken for an activity and cannot move a client's cursor;
 *   2. `closeServer` is bounded even when a connection refuses to go — the unit
 *      rule, with a server that never finishes closing;
 *   3. `createTaskd().close()` settles immediately with a client subscribed, and
 *      that client is *told* rather than merely cut off;
 *   4. the real daemon, signalled for real: `node src/server/main.mjs` +
 *      `SIGTERM` exits 0 inside the 5 s budget and leaves no `-wal`.
 *
 * The last one is the shape the defect was found in, which is why it is here and
 * not only in the report.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { SSE_SHUTDOWN_EVENT } from "../../src/foundation/constants.mjs";
import { SHUTDOWN_GRACE_MS, closeServer, createTaskd } from "../../src/server/index.mjs";
import { formatShutdown } from "../../src/server/sse.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-stop-"));
  tempDirs.push(dir);
  return dir;
};

/**
 * Let a subscribed client go.
 *
 * Tolerating a throw is deliberate: `AbortController.abort()` on a stream that
 * has already ended can surface undici's teardown as a synchronous `AbortError`,
 * and a test's cleanup must never be the thing that fails.
 */
function release(controller) {
  try {
    controller.abort();
  } catch {
    /* the stream had already ended */
  }
}

/** Resolve with `"timeout"` rather than hanging, and leave no timer behind. */
async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Read an SSE body until `predicate` holds, the stream ends, or the clock runs out. */
async function readUntil(reader, decoder, predicate, timeoutMs) {
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 25)),
    ]);
    if (done) return { text: buffer, ended: true };
    if (value !== undefined) buffer += decoder.decode(value, { stream: true });
    if (predicate(buffer)) return { text: buffer, ended: false };
  }
  return { text: buffer, ended: false };
}

/** A `createTaskd` board with a client genuinely subscribed to `/api/v1/events`. */
async function subscribed() {
  const taskd = await createTaskd({
    dataDir: tempDir(),
    host: "127.0.0.1",
    port: 0,
    env: {},
    eventsPollMs: 10,
    eventsHeartbeatMs: 50,
  });
  const controller = new AbortController();
  const response = await fetch(`${taskd.url}/api/v1/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const opened = await readUntil(reader, decoder, (text) => text.includes(": connected"), 3_000);
  assert.match(opened.text, /: connected revision=/, "the stream is live before the board is closed");
  return { taskd, reader, decoder, controller };
}

describe("server/shutdown — the frame that says why", () => {
  it("is named, carries a reason, and has no id to advance a cursor with", () => {
    const frame = formatShutdown("server_shutdown");
    assert.equal(frame, `event: ${SSE_SHUTDOWN_EVENT}\ndata: {"reason":"server_shutdown"}\n\n`);
    assert.equal(frame.includes("id:"), false, "a client must not be able to skip past unseen events");
    assert.equal(SSE_SHUTDOWN_EVENT, "shutdown", "the name the web client listens for");
  });
});

describe("server/shutdown — closeServer is bounded", () => {
  it("retires idle connections, then destroys whatever is left", async () => {
    const calls = [];
    const fake = {
      close(callback) {
        calls.push("close");
        this.callback = callback; // never called: a connection nobody hangs up
      },
      closeIdleConnections() {
        calls.push("idle");
      },
      closeAllConnections() {
        calls.push("all");
        this.callback?.();
      },
    };
    const started = Date.now();
    assert.equal(await withTimeout(closeServer(fake, 40), 2_000), undefined, "it settled rather than hanging");
    assert.ok(Date.now() - started < 1_000, "the bound is the grace, not the default second");
    assert.deepEqual(calls, ["close", "idle", "all"]);
  });

  it("resolves as soon as the server closes on its own — the grace is not on the fast path", async () => {
    const calls = [];
    const fake = {
      close(callback) {
        calls.push("close");
        callback();
      },
      closeIdleConnections() {
        calls.push("idle");
      },
      closeAllConnections() {
        calls.push("all");
      },
    };
    const started = Date.now();
    await closeServer(fake, 5_000);
    assert.ok(Date.now() - started < 100, "a clean close is not delayed by the grace");
    // No sweep and nothing destroyed: `close` already reported every socket
    // gone, which is the only condition under which it resolves at all.
    assert.deepEqual(calls, ["close"]);
  });
});

describe("server/shutdown — a subscribed client does not hold the board open", () => {
  it("ends the stream deliberately and settles at once", async () => {
    const { taskd, reader, decoder, controller } = await subscribed();
    const started = Date.now();
    const outcome = await withTimeout(taskd.close(), 5_000);
    const elapsedMs = Date.now() - started;

    // Read the goodbye *before* releasing the client — aborting first would
    // discard the very bytes this test is about.
    const tail = await readUntil(reader, decoder, (text) => text.includes(`event: ${SSE_SHUTDOWN_EVENT}`), 1_000);
    release(controller);

    assert.notEqual(outcome, "timeout", "close() waited for the SSE stream — the defect");
    assert.ok(elapsedMs < SHUTDOWN_GRACE_MS, `close() took ${elapsedMs}ms; the graceful path needs no grace`);
    // The stream is not merely cut: it says why, which is what lets a client
    // tell a restart from a broken network.
    assert.match(tail.text, /event: shutdown\ndata: \{"reason":"server_shutdown"\}/);
  });

  it("closes cleanly with no client at all", async () => {
    const taskd = await createTaskd({ dataDir: tempDir(), host: "127.0.0.1", port: 0, env: {} });
    assert.notEqual(await withTimeout(taskd.close(), 5_000), "timeout");
  });
});

describe("server/shutdown — the real daemon, signalled for real", () => {
  it("exits 0 on SIGTERM inside the 5 s budget and leaves no -wal behind", async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [join(REPO_ROOT, "src", "server", "main.mjs")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TASKD_DATA_DIR: dir,
        TASKD_RUNTIME_POINTER: join(dir, "runtime.json"),
        TASKD_HOST: "127.0.0.1",
        TASKD_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

    try {
      // The address is a structured field on stderr now (`event=startup url=…`);
      // stdout carries no daemon output.
      const deadline = Date.now() + 10_000;
      while (!/event=startup/.test(stderr) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const url = stderr.match(/url=(http:\/\/\S+)/)?.[1];
      assert.ok(url, `the daemon never reported a URL\n${stdout}\n${stderr}`);
      assert.equal(stdout, "", "the daemon writes nothing to stdout");

      // The connection the defect hangs on: held open, deliberately.
      const controller = new AbortController();
      const response = await fetch(`${url}/api/v1/events`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await new Promise((resolve) => setTimeout(resolve, 50)); // let it attach

      const started = Date.now();
      child.kill("SIGTERM");
      const outcome = await withTimeout(exited, 5_000);
      const elapsedMs = Date.now() - started;
      controller.abort();

      assert.notEqual(outcome, "timeout", `SIGTERM did not stop the daemon within 5 s (${elapsedMs}ms)`);
      assert.equal(outcome.code, 0, `exit code ${outcome.code}, signal ${outcome.signal}`);
      assert.match(stderr, /event=shutdown_signal .*SIGTERM — closing/, "the graceful path ran, rather than a kill");
      assert.equal(
        readdirSync(dir).some((name) => name.endsWith("-wal")),
        false,
        "a clean close checkpoints; a SIGKILL is what leaves the -wal behind",
      );
      assert.equal(existsSync(join(dir, "runtime.json")), false, "the pointer was removed on the way out");
      void reader;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
