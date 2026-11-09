/**
 * The Claude resident-session adapter, driven by a fake CLI.
 *
 * The fake speaks the same stream-json shape: an init event, one `result` per
 * user message, and a tool result carrying `agentId:` for the ledger.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createClaudePool, sessionArgs } from "../../src/orchestrator/actor-kinds/claude.mjs";

const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const base = dirname(process.argv[1]);
const args = process.argv.slice(2);
const resume = args.indexOf("--resume");
let sid = resume === -1 ? "sid-fake-1" : args[resume + 1];
appendFileSync(join(base, "pids"), process.pid + "\\n");
appendFileSync(join(base, "argv.jsonl"), JSON.stringify(args) + "\\n");
appendFileSync(join(base, "cwd"), process.cwd() + "\\n");
appendFileSync(join(base, "env.jsonl"), JSON.stringify({ kind: process.env.TASKCTL_ACTOR_KIND, path: process.env.PATH }) + "\\n");

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sid }) + "\\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  const text = String(message.message?.content ?? "");
  process.stdout.write(JSON.stringify({
    type: "assistant",
    session_id: sid,
    message: { content: [{ type: "text", text: "working" }] },
  }) + "\\n");
  if (text.includes("SPAWN")) {
    process.stdout.write(JSON.stringify({
      type: "user",
      session_id: sid,
      message: { content: [{ type: "tool_result", content: "agentId: a-fake-1" }] },
    }) + "\\n");
  }
  if (text.includes("HANG")) return;
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, session_id: sid, result: "done",
  }) + "\\n");
});
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-claude-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const bin = join(dir, "fake-claude.mjs");
  writeFileSync(bin, FAKE, "utf8");
  chmodSync(bin, 0o755);
  return {
    dir,
    project,
    bin,
    record: join(dir, "pids"),
    argvFile: join(dir, "argv.jsonl"),
    cwdFile: join(dir, "cwd"),
    envFile: join(dir, "env.jsonl"),
    log: () => {},
  };
}

describe("claude session environment", () => {
  it("spawns with the session's own kind environment, not the supervisor's", async (t) => {
    const f = fixture(t);
    const pool = createClaudePool({
      opts: {},
      log: f.log,
      bin: f.bin,
      env: { ...process.env, TASKCTL_ACTOR_KIND: "codex", PATH: `/role/bin:${process.env.PATH ?? ""}` },
    });
    const handle = pool.openSession({ cwd: f.project, role: "worker" });
    await handle.send("hello");
    await handle.close();
    const env = JSON.parse(readFileSync(f.envFile, "utf8").trim());
    assert.equal(env.kind, "codex", "the session writes as its own kind");
    assert.match(env.path, /^\/role\/bin:/, "the kind's shim directory leads PATH");
  });
});

describe("claude session args", () => {
  it("uses stream-json, never --bare, and resumes by id", () => {
    const args = sessionArgs({ opts: {}, role: "worker", sessionId: "sid-1" });
    assert.ok(args.includes("--input-format"));
    assert.ok(args.includes("stream-json"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("--verbose"));
    assert.ok(args.includes("--resume"));
    assert.equal(args[args.indexOf("--resume") + 1], "sid-1");
    assert.equal(args.includes("--bare"), false);
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args.includes("--allowedTools"), false);
    assert.equal(args.includes("--disallowedTools"), false, "a full lane passes no deny list");
  });

  it("appends the card system prompt when one is given, and leaves the argv alone otherwise", () => {
    const args = sessionArgs({ opts: {}, role: "worker", systemPrompt: "CARD CONTEXT" });
    const at = args.indexOf("--append-system-prompt");
    assert.ok(at !== -1, "the system prompt reaches the CLI");
    assert.equal(args[at + 1], "CARD CONTEXT");
    assert.equal(
      sessionArgs({ opts: {}, role: "worker" }).includes("--append-system-prompt"),
      false,
    );
  });

  it("runs every lane with permissions bypassed by default", () => {
    for (const role of ["director", "worker", "reviewer"]) {
      const args = sessionArgs({ opts: {}, role });
      assert.equal(
        args[args.indexOf("--permission-mode") + 1],
        "bypassPermissions",
        `${role} runs unattended with the full tool set`,
      );
      assert.equal(args.includes("--allowedTools"), false, "no lane carries an allow list");
    }
  });

  it("denies the read-only lanes' write tools", () => {
    for (const role of ["director", "reviewer"]) {
      const args = sessionArgs({ opts: {}, role });
      assert.equal(
        args[args.indexOf("--disallowedTools") + 1],
        "Edit,Write,NotebookEdit",
        `${role} may not write`,
      );
    }
    assert.equal(
      sessionArgs({ opts: {}, role: "worker" }).includes("--disallowedTools"),
      false,
      "the worker keeps every tool",
    );
  });

  it("leaves the subagent tool available to every lane", () => {
    // ADR 0020: a card session may spawn subagents. A read-only lane's deny
    // list removes only the write tools, so `Agent` survives there too.
    for (const role of ["director", "reviewer"]) {
      const args = sessionArgs({ opts: {}, role });
      assert.doesNotMatch(args[args.indexOf("--disallowedTools") + 1], /\bAgent\b/);
    }
    for (const role of ["director", "worker", "reviewer"]) {
      assert.equal(
        sessionArgs({ opts: {}, role }).includes("--allowedTools"),
        false,
        "no lane enumerates tools, so nothing can omit Agent",
      );
    }
  });
});

describe("claude resident session", () => {
  it("keeps one process across two turns and reuses the session id", async (t) => {
    const f = fixture(t);
    const events = [];
    const pool = createClaudePool({
      opts: {},
      bin: f.bin,
      log: f.log,
      onEvent: (event) => events.push(event),
    });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "worker" });
    const first = await session.send("first", { timeoutMs: 5000 });
    const second = await session.send("SPAWN second", { timeoutMs: 5000 });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(first.sessionId, "sid-fake-1");
    assert.equal(second.sessionId, first.sessionId);

    const pids = readFileSync(f.record, "utf8").trim().split("\n");
    assert.equal(new Set(pids).size, 1, "two turns must share one process");
    const argv = JSON.parse(readFileSync(f.argvFile, "utf8").trim().split("\n")[0]);
    assert.ok(argv.includes("--input-format"));
    assert.ok(argv.includes("stream-json"));
    assert.equal(argv.includes("--bare"), false);
    assert.equal(realpathSync(readFileSync(f.cwdFile, "utf8").trim()), realpathSync(f.project));
    await session.close();
  });

  it("passes the formatted card system prompt to the spawn at open time", async (t) => {
    const f = fixture(t);
    const pool = createClaudePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "worker", systemPrompt: "CARD CONTEXT" });
    const outcome = await session.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true, outcome.error);
    const argv = JSON.parse(readFileSync(f.argvFile, "utf8").trim().split("\n")[0]);
    assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "CARD CONTEXT");
    await session.close();
  });

  it("passes the stored session id back as --resume", async (t) => {
    const f = fixture(t);
    const pool = createClaudePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, sessionId: "sid-old", role: "worker" });
    const outcome = await session.send("hello", { timeoutMs: 5000 });
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.sessionId, "sid-old");
    const argv = JSON.parse(readFileSync(f.argvFile, "utf8").trim().split("\n")[0]);
    assert.equal(argv[argv.indexOf("--resume") + 1], "sid-old");
    await session.close();
  });

  it("times a hung turn out and interrupts it", async (t) => {
    const f = fixture(t);
    const pool = createClaudePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "worker" });
    const outcome = await session.send("HANG", { timeoutMs: 150 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
    await session.close();
  });

  it("reports a missing agent binary instead of hanging", async (t) => {
    const f = fixture(t);
    const pool = createClaudePool({ opts: {}, bin: join(f.dir, "missing"), log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.project, role: "worker" });
    const outcome = await session.send("hello", { timeoutMs: 500 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /spawn error|closed/);
    await session.close();
  });

  it("marks a resume that exits before its result, and not a fresh spawn", async (t) => {
    const f = fixture(t);
    const bin = join(f.dir, "fail-claude.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", () => process.exit(1));
`,
      "utf8",
    );
    chmodSync(bin, 0o755);
    const pool = createClaudePool({ opts: {}, bin, log: () => {} });
    t.after(() => pool.close());
    const resumed = pool.openSession({ cwd: f.project, sessionId: "sid-old", role: "worker" });
    const failed = await resumed.send("resume", { timeoutMs: 5000 });
    assert.equal(failed.ok, false);
    assert.equal(failed.resumeFailed, true, "a resume id that exits before a result is a resume failure");
    await resumed.close();

    const freshPool = createClaudePool({ opts: {}, bin, log: () => {} });
    t.after(() => freshPool.close());
    const fresh = freshPool.openSession({ cwd: f.project, role: "worker" });
    const freshOutcome = await fresh.send("start", { timeoutMs: 5000 });
    assert.equal(freshOutcome.ok, false);
    assert.equal(freshOutcome.resumeFailed, false, "a fresh spawn failure is not a resume failure");
    await fresh.close();
  });
});
