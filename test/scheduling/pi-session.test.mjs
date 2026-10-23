/**
 * The Pi resident-session adapter, driven by a fake `pi --mode rpc`.
 *
 * The fake speaks JSONL: a `response` per command, `agent_start` /
 * `message_end` progress, and `agent_settled` as the turn-finished signal.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createPiPool,
  piSubagentsInstalled,
  sessionArgs,
} from "../../scripts/loop/actor-kinds/pi.mjs";

const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const base = dirname(process.argv[1]);
const args = process.argv.slice(2);
const at = args.indexOf("--session-id");
const sid = at === -1 ? "pi-sid-1" : args[at + 1];
appendFileSync(join(base, "pids"), process.pid + "\\n");
appendFileSync(join(base, "argv.jsonl"), JSON.stringify(args) + "\\n");
appendFileSync(join(base, "cwd"), process.cwd() + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "get_state") {
    send({ id: msg.id, type: "response", command: "get_state", success: true, data: { sessionId: sid } });
    return;
  }
  if (msg.type === "prompt") {
    const text = String(msg.message ?? "");
    send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    if (text.includes("SPAWN")) {
      send({ type: "tool_result", toolName: "subagent", result: { agentId: "pi-child-1" } });
    }
    if (text.includes("HANG")) return;
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    send({ type: "turn_end" });
    send({ type: "agent_end" });
    send({ type: "agent_settled" });
    return;
  }
  if (msg.type === "abort") {
    send({ id: msg.id, type: "response", command: "abort", success: true, data: {} });
    send({ type: "agent_settled" });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, type: "response", command: msg.type, success: true, data: {} });
});
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-pi-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const bin = join(dir, "fake-pi.mjs");
  writeFileSync(bin, FAKE, "utf8");
  chmodSync(bin, 0o755);
  return {
    dir,
    project,
    bin,
    pids: join(dir, "pids"),
    argv: join(dir, "argv.jsonl"),
    cwd: join(dir, "cwd"),
    log: () => {},
  };
}

describe("pi session args", () => {
  it("runs rpc mode, resumes by --session-id, and keeps a role allowlist", () => {
    const args = sessionArgs({ opts: {}, role: "worker", sessionId: "sid-1" });
    assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
    assert.equal(args[args.indexOf("--session-id") + 1], "sid-1");
    assert.equal(args[args.indexOf("--tools") + 1], "read,bash,edit,write");
  });

  it("trusts project files when all tools are authorized", () => {
    const args = sessionArgs({ opts: { allowAllTools: true }, role: "worker" });
    assert.ok(args.includes("--approve"));
    assert.equal(args.includes("--tools"), false);
  });
});

describe("pi subagent dependency", () => {
  it("warns when the extension is absent, and clears once it is installed", (t) => {
    const f = fixture(t);
    const home = join(f.dir, "home");
    mkdirSync(home, { recursive: true });
    const logs = [];
    const pool = createPiPool({ opts: {}, bin: f.bin, log: (line) => logs.push(line), home });
    t.after(() => pool.close());

    assert.equal(piSubagentsInstalled(home), false);
    assert.ok(
      logs.some((line) => line.includes("pi install npm:pi-subagents")),
      logs.join("\n"),
    );

    mkdirSync(join(home, ".pi", "agent", "extensions", "subagent"), { recursive: true });
    assert.equal(piSubagentsInstalled(home), true);
  });
});

describe("pi resident session", () => {
  it("keeps one process across two turns and captures a subagent id", async (t) => {
    const f = fixture(t);
    const events = [];
    const pool = createPiPool({ opts: {}, bin: f.bin, log: f.log, onEvent: (event) => events.push(event) });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "project" });
    const first = await session.send("one", { timeoutMs: 5000 });
    const second = await session.send("SPAWN two", { timeoutMs: 5000 });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.ids.includes("pi-child-1"), true, JSON.stringify(second.ids));
    assert.equal(new Set(readFileSync(f.pids, "utf8").trim().split("\n")).size, 1);
    assert.equal(realpathSync(readFileSync(f.cwd, "utf8").trim()), realpathSync(f.project));
    assert.ok(events.some((event) => event.type === "subagent" && event.subagentId === "pi-child-1"));
    await session.close();
  });

  it("resumes a stored session id", async (t) => {
    const f = fixture(t);
    const pool = createPiPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, sessionId: "sid-old", role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sessionId, "sid-old");
    const argv = JSON.parse(readFileSync(f.argv, "utf8").trim().split("\n")[0]);
    assert.equal(argv[argv.indexOf("--session-id") + 1], "sid-old");
    await session.close();
  });

  it("learns the id Pi created when none was stored", async (t) => {
    const f = fixture(t);
    const pool = createPiPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.sessionId, "pi-sid-1");
    await session.close();
  });

  it("times a hung turn out and aborts it", async (t) => {
    const f = fixture(t);
    const pool = createPiPool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "project" });
    const outcome = await session.send("HANG", { timeoutMs: 150 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
    await session.close();
  });
});
