/**
 * The hub's runtime seam: directory/key derivation, the start lock, the pointer
 * file's permissions, and the authenticated one-answer socket call.
 *
 * These are the pieces a hub client trusts before any board work happens; a
 * bug here shows up as "the hub is not running" on every command.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import {
  acquireLock,
  hubCall,
  hubDir,
  hubHealthy,
  hubKey,
  hubPaths,
  lockIsStale,
  pidAlive,
  readJsonFile,
  releaseLock,
  writeJsonFile,
} from "../../src/cli/hub/runtime.mjs";

const dirs = [];
const servers = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-hub-runtime-"));
  dirs.push(dir);
  return dir;
}

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: server.address().port };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("hub runtime", () => {
  it("derives the per-user directory from the environment", () => {
    const explicit = tempDir();
    assert.equal(hubDir({ MEERKAT_HUB_DIR: explicit }), resolve(explicit));
    assert.equal(hubDir({ XDG_RUNTIME_DIR: explicit }), join(resolve(explicit), "meerkat-taskpanel"));
    if (process.platform !== "win32") {
      assert.match(hubDir({}), /\.meerkat-taskpanel[/\\]run$/);
    }
  });

  it("keys a hub by URL and token fingerprint", () => {
    assert.equal(hubKey("http://127.0.0.1:1", "td_a"), hubKey("http://127.0.0.1:1", "td_a"));
    assert.notEqual(hubKey("http://127.0.0.1:1", "td_a"), hubKey("http://127.0.0.1:2", "td_a"));
    assert.notEqual(hubKey("http://127.0.0.1:1", "td_a"), hubKey("http://127.0.0.1:1", "td_b"));
    const paths = hubPaths("http://127.0.0.1:1", "td_a", { MEERKAT_HUB_DIR: tempDir() });
    assert.match(paths.pointer, /hub-[0-9a-f]{16}\.json$/);
    assert.match(paths.state, /\.state\.json$/);
  });

  it("claims the start lock once and reclaims a dead owner", () => {
    const dir = tempDir();
    const lock = join(dir, "start.lock");
    assert.deepEqual(acquireLock(lock), { ok: true });
    assert.deepEqual(acquireLock(lock), { ok: false });
    assert.equal(lockIsStale(lock), false); // its owner is this live process
    releaseLock(lock);

    writeFileSync(lock, JSON.stringify({ pid: 999_999, startedAt: Date.now() }));
    assert.equal(lockIsStale(lock), true);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 0 }));
    assert.equal(lockIsStale(lock), true); // held far too long
    releaseLock(lock);
  });

  it("writes an owner-only JSON file and treats corruption as absence", () => {
    const file = join(tempDir(), "pointer.json");
    writeJsonFile(file, { pid: 1, port: 2 });
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readJsonFile(file), { pid: 1, port: 2 });

    writeFileSync(file, "{not json");
    assert.equal(readJsonFile(file), null);
  });

  it("recognises only real pids", () => {
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(1), false);
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(999_999), false);
  });

  it("authenticates one-answer calls with the pointer's token", async () => {
    const { port } = await listen((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const record = JSON.parse(line);
          if (record.op === "hello") socket.write('{"op":"hello","ok":true}\n');
          else if (record.op === "ping") socket.write('{"op":"ping","ok":true}\n');
        }
      });
    });

    const pointer = { port, token: "hub-token" };
    assert.deepEqual(
      await hubCall(pointer, "hub-token", { op: "ping" }, { match: (record) => record.op === "ping" }),
      { op: "ping", ok: true },
    );
    assert.equal(await hubHealthy(pointer), true);
  });

  it("refuses a session the hub does not authenticate", async () => {
    const { port } = await listen((socket) => {
      socket.on("data", () => socket.write('{"op":"hello","ok":false,"error":"unauthorized"}\n'));
    });
    const pointer = { port, token: "right" };
    await assert.rejects(
      () => hubCall(pointer, "wrong", { op: "ping" }, { match: (record) => record.op === "ping" }),
      (err) => err.code === "CLI_IO",
    );
    assert.equal(await hubHealthy(pointer), false);
  });

  it("times out a hub that never answers", async () => {
    const { port } = await listen(() => {
      /* accept and stay silent */
    });
    await assert.rejects(
      () => hubCall({ port, token: "t" }, "t", { op: "ping" }, { timeoutMs: 50, match: (record) => record.op === "ping" }),
      (err) => err.code === "CLI_IO",
    );
  });

  it("treats a malformed answer as a failure", async () => {
    const { port } = await listen((socket) => {
      socket.on("data", () => socket.write("not-json\n"));
    });
    await assert.rejects(
      () => hubCall({ port, token: "t" }, "t", { op: "ping" }, { timeoutMs: 200, match: (record) => record.op === "ping" }),
      (err) => err.code === "CLI_IO",
    );
  });
});
