/**
 * The Codex resident-session adapter, driven by a fake `codex app-server`.
 *
 * The fake speaks JSON-RPC over stdio: initialize/initialized, thread/start and
 * thread/resume, turn/start → turn/completed, and a child thread id in a
 * `collabAgentToolCall` item.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createCodexPool,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
} from "../../scripts/loop/actor-kinds/codex.mjs";

const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const base = dirname(process.argv[1]);
appendFileSync(join(base, "pids"), process.pid + "\\n");
appendFileSync(join(base, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");

let nextThread = 1;
const turns = new Map();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake", codexHome: base, platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start" || msg.method === "thread/resume") {
    appendFileSync(join(base, "threads.jsonl"), JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
    const id = msg.params?.threadId ?? "th-" + nextThread++;
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id, sessionId: id, cwd: msg.params?.cwd ?? null } } });
    return;
  }
  if (msg.method === "turn/start") {
    const turnId = "turn-" + (turns.size + 1);
    turns.set(turnId, msg.params);
    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: msg.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: {
      threadId: msg.params.threadId,
      item: { type: "userMessage", id: "u-1", content: [] },
    } });
    const text = String(msg.params?.input?.[0]?.text ?? "");
    if (text.includes("SPAWN")) {
      send({ jsonrpc: "2.0", method: "item/started", params: {
        threadId: msg.params.threadId,
        item: { type: "collabAgentToolCall", id: "c-1", receiverThreadIds: ["child-1", "child-2"] },
      } });
    }
    if (text.includes("HANG")) return;
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: {
      threadId: msg.params.threadId, turnId, itemId: "a-1", delta: "done",
    } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: {
      threadId: msg.params.threadId,
      turn: { id: turnId, status: "completed", items: [], error: null },
    } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    for (const [turnId, params] of turns) {
      send({ jsonrpc: "2.0", method: "turn/completed", params: {
        threadId: params.threadId,
        turn: { id: turnId, status: "failed", items: [], error: { message: "interrupted" } },
      } });
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-codex-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "app");
  const api = join(dir, "api");
  mkdirSync(app, { recursive: true });
  mkdirSync(api, { recursive: true });
  const bin = join(dir, "fake-codex.mjs");
  writeFileSync(bin, FAKE, "utf8");
  chmodSync(bin, 0o755);
  return {
    dir,
    app,
    api,
    bin,
    pids: join(dir, "pids"),
    threads: join(dir, "threads.jsonl"),
    log: () => {},
  };
}

function readLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("codex session params", () => {
  it("keeps approvals on by default and opens the sandbox with an authorization", () => {
    assert.deepEqual(threadStartParams({ opts: {}, cwd: "/work/app" }), {
      cwd: "/work/app",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    assert.deepEqual(threadStartParams({ opts: { allowAllTools: true }, cwd: "/work/app" }), {
      cwd: "/work/app",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("resumes by thread id", () => {
    assert.deepEqual(threadResumeParams({ opts: {}, threadId: "th-9" }), {
      threadId: "th-9",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("sends the prompt as one text input", () => {
    assert.deepEqual(turnStartParams({ threadId: "th-1", prompt: "hello" }), {
      threadId: "th-1",
      input: [{ type: "text", text: "hello" }],
    });
  });
});

describe("codex resident session", () => {
  it("serves two project cwds from one app-server process", async (t) => {
    const f = fixture(t);
    const pool = createCodexPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const app = pool.openSession({ cwd: f.app, role: "project" });
    const api = pool.openSession({ cwd: f.api, role: "project" });
    assert.equal((await app.send("one", { timeoutMs: 5000 })).ok, true);
    assert.equal((await api.send("two", { timeoutMs: 5000 })).ok, true);
    assert.equal(new Set(readFileSync(f.pids, "utf8").trim().split("\n")).size, 1, "one app-server process");
    const threads = readLines(f.threads);
    assert.deepEqual(threads.map((row) => row.params.cwd).sort(), [f.app, f.api].sort());
    assert.ok(threads.every((row) => row.method === "thread/start"));
  });

  it("keeps one thread across turns and records child threads", async (t) => {
    const f = fixture(t);
    const events = [];
    const pool = createCodexPool({ opts: {}, bin: f.bin, log: f.log, onEvent: (event) => events.push(event) });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    assert.equal((await session.send("first", { timeoutMs: 5000 })).ok, true);
    const second = await session.send("SPAWN second", { timeoutMs: 5000 });
    assert.equal(second.ok, true);
    assert.equal(second.sessionId, "th-1");
    assert.equal(readLines(f.threads).length, 1, "one thread for two turns");
    assert.deepEqual(second.ids.sort(), ["child-1", "child-2"]);
    assert.ok(events.some((event) => event.type === "subagent" && event.subagentId === "child-1"));
  });

  it("resumes a stored thread id", async (t) => {
    const f = fixture(t);
    const pool = createCodexPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, sessionId: "th-old", role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, "th-old");
    const [row] = readLines(f.threads);
    assert.equal(row.method, "thread/resume");
    assert.equal(row.params.threadId, "th-old");
  });

  it("times a hung turn out and interrupts it", async (t) => {
    const f = fixture(t);
    const pool = createCodexPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const outcome = await session.send("HANG", { timeoutMs: 150 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
  });

  it("reports a missing agent binary instead of hanging", async (t) => {
    const f = fixture(t);
    const pool = createCodexPool({ opts: {}, bin: join(f.dir, "missing"), log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 500 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /spawn error|exited|initialize failed|closed/i);
  });
});
