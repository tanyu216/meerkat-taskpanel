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

import { allowedToolsFor, createClaudePool, sessionArgs } from "../../src/orchestrator/actor-kinds/claude.mjs";

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
    log: () => {},
  };
}

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
    assert.ok(args.includes("--allowedTools"));
    assert.match(args[args.indexOf("--allowedTools") + 1], /Edit/);
  });

  it("switches to bypassPermissions when all tools are authorized", () => {
    const args = sessionArgs({ opts: { allowAllTools: true }, role: "worker" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args.includes("--allowedTools"), false);
  });

  it("keeps the reviewer read-only and the control session to the passes", () => {
    assert.doesNotMatch(allowedToolsFor("reviewer"), /Edit|Write/);
    assert.doesNotMatch(allowedToolsFor("control"), /Edit|Write/);
    assert.match(allowedToolsFor("worker"), /Edit/);
  });

  it("permits the control lane the command its prompt actually names", () => {
    // The continue prompt names `node <cli> loop <pass>` and the same command
    // for its board reads. An allowlist entry that matches neither form leaves
    // the control turn unable to run a single pass (the 127/denied loop).
    assert.match(allowedToolsFor("control"), /Bash\(node \*\)/);
    assert.match(allowedToolsFor("control"), /Bash\(taskctl \*\)/);
  });

  it("lets the reviewer run the gate it is told to re-run", () => {
    // The reviewer role requires re-running the project's gate. A lane without
    // `npm`/`node` makes that rule unexecutable, which is how gate-checking
    // silently decayed into reading the delivery report.
    assert.match(allowedToolsFor("reviewer"), /Bash\(npm run \*\)/);
    assert.match(allowedToolsFor("reviewer"), /Bash\(node \*\)/);
    assert.match(allowedToolsFor("reviewer"), /Bash\(git \*\)/);
  });

  it("lets each lane spawn its subagent", () => {
    // A project/reviewer session that cannot spawn has no way to dispatch the
    // card it was handed. `Agent` is the current CLI's tool; `Task` is the alias
    // older builds use, and an unmatched allowlist entry is inert.
    assert.match(allowedToolsFor("reviewer"), /Agent/);
    assert.match(allowedToolsFor("worker"), /Agent/);
  });
});

describe("claude resident session", () => {
  it("keeps one process across two turns and reuses the session id", async (t) => {
    const f = fixture(t);
    const events = [];
    const pool = createClaudePool({
      opts: { allowAllTools: true },
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
    assert.ok(events.some((event) => event.type === "subagent" && event.subagentId === "a-fake-1"));
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
});
