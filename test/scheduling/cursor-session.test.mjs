/**
 * The Cursor resident-session adapter (ACP), driven by a fake `cursor-agent acp`.
 *
 * The fake speaks JSON-RPC: initialize/authenticate, session/new and
 * session/load, session/prompt → stopReason, and a session/request_permission
 * request the adapter must answer.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { allowOption, createCursorPool } from "../../scripts/loop/actor-kinds/cursor.mjs";

const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const base = dirname(process.argv[1]);
appendFileSync(join(base, "pids"), process.pid + "\\n");
appendFileSync(join(base, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let nextSession = 1;
let permissionId = 100;
const waits = new Map();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "cursor_login" }] } });
    return;
  }
  if (msg.method === "authenticate") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "session/new") {
    appendFileSync(join(base, "sessions.jsonl"), JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses-" + nextSession++ } });
    return;
  }
  if (msg.method === "session/load") {
    appendFileSync(join(base, "sessions.jsonl"), JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
    const ok = String(msg.params?.sessionId ?? "").startsWith("ses-old");
    if (ok) send({ jsonrpc: "2.0", id: msg.id, result: {} });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "unknown session" } });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = String(msg.params?.prompt?.[0]?.text ?? "");
    const sessionId = msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    if (text.includes("SPAWN")) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", agentId: "cur-child-1" } } });
    }
    if (text.includes("HANG")) { waits.set(msg.id, sessionId); return; }
    if (text.includes("PERM")) {
      const id = permissionId++;
      waits.set("perm:" + id, { promptId: msg.id, sessionId });
      send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
        sessionId,
        options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }, { optionId: "ok", kind: "allow_once", name: "Allow" }],
      } });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.method === "session/cancel") {
    for (const [id, sessionId] of waits) {
      if (typeof id !== "string" && sessionId === msg.params.sessionId) {
        send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
        waits.delete(id);
      }
    }
    return;
  }
  // A response to the permission request.
  if (msg.id !== undefined && msg.result !== undefined) {
    const held = waits.get("perm:" + msg.id);
    appendFileSync(join(base, "permissions.jsonl"), JSON.stringify(msg.result) + "\\n");
    if (held !== undefined) {
      waits.delete("perm:" + msg.id);
      send({ jsonrpc: "2.0", id: held.promptId, result: { stopReason: "end_turn" } });
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-cursor-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "app");
  const api = join(dir, "api");
  mkdirSync(app, { recursive: true });
  mkdirSync(api, { recursive: true });
  const bin = join(dir, "fake-cursor.mjs");
  writeFileSync(bin, FAKE, "utf8");
  chmodSync(bin, 0o755);
  return {
    dir,
    app,
    api,
    bin,
    pids: join(dir, "pids"),
    argv: join(dir, "argv.jsonl"),
    sessions: join(dir, "sessions.jsonl"),
    permissions: join(dir, "permissions.jsonl"),
    log: () => {},
  };
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("cursor adapter helpers", () => {
  it("prefers an allow option and falls back to the first", () => {
    assert.equal(allowOption([{ optionId: "no", kind: "reject_once" }, { optionId: "yes", kind: "allow_always" }]), "yes");
    assert.equal(allowOption([{ optionId: "only", kind: "reject_once" }]), "only");
    assert.equal(allowOption([]), null);
  });
});

describe("cursor resident session", () => {
  it("serves two project cwds from one ACP process", async (t) => {
    const f = fixture(t);
    const pool = createCursorPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const app = pool.openSession({ cwd: f.app, role: "project" });
    const api = pool.openSession({ cwd: f.api, role: "project" });
    assert.equal((await app.send("one", { timeoutMs: 5000 })).ok, true);
    assert.equal((await api.send("two", { timeoutMs: 5000 })).ok, true);
    assert.equal(new Set(readFileSync(f.pids, "utf8").trim().split("\n")).size, 1);
    const sessions = readLines(f.sessions);
    assert.deepEqual(sessions.map((row) => row.params.cwd).sort(), [f.app, f.api].sort());
    assert.ok(sessions.every((row) => row.method === "session/new"));
  });

  it("keeps one session across turns and records a subagent id", async (t) => {
    const f = fixture(t);
    const pool = createCursorPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const first = await session.send("one", { timeoutMs: 5000 });
    const second = await session.send("SPAWN two", { timeoutMs: 5000 });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.sessionId, first.sessionId);
    assert.ok(second.ids.includes("cur-child-1"), JSON.stringify(second.ids));
    assert.equal(readLines(f.sessions).length, 1);
  });

  it("loads a stored session id, and starts fresh when it is unknown", async (t) => {
    const f = fixture(t);
    const pool = createCursorPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const resumed = pool.openSession({ cwd: f.app, sessionId: "ses-old-1", role: "project" });
    assert.equal((await resumed.send("hello", { timeoutMs: 5000 })).sessionId, "ses-old-1");
    const fresh = pool.openSession({ cwd: f.api, sessionId: "ses-gone", role: "project" });
    const outcome = await fresh.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true, outcome.error);
    assert.notEqual(outcome.sessionId, "ses-gone");
    assert.equal(readLines(f.sessions).filter((row) => row.method === "session/new").length, 1);
  });

  it("answers a permission request with an allow option", async (t) => {
    const f = fixture(t);
    const pool = createCursorPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "worker" });
    const outcome = await session.send("PERM please", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true, outcome.error);
    const [answer] = readLines(f.permissions);
    assert.deepEqual(answer, { outcome: { outcome: "selected", optionId: "ok" } });
  });

  it("times a hung turn out and cancels it", async (t) => {
    const f = fixture(t);
    const pool = createCursorPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const outcome = await session.send("HANG", { timeoutMs: 200 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
  });
});
