/**
 * The OpenCode resident-session adapter, driven by a fake `opencode serve`.
 *
 * The fake implements the published server API: create a session, send a
 * synchronous message, abort, and list children. One server per directory is the
 * adapter's design (OpenCode has no per-session cwd), so the fake records the
 * process cwd of every server it starts.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createOpenCodePool, messageText } from "../../scripts/loop/actor-kinds/opencode.mjs";

const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const base = dirname(process.argv[1]);
const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const port = Number(argv[at + 1]);
appendFileSync(join(base, "servers.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), port }) + "\\n");

let sessions = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    appendFileSync(join(base, "requests.jsonl"), JSON.stringify({ method: req.method, url, body }) + "\\n");
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && url === "/session") return json(200, []);
    if (req.method === "POST" && url === "/session") {
      sessions += 1;
      return json(200, { id: "ses-" + sessions });
    }
    if (req.method === "GET" && url.startsWith("/session/") && !url.includes("/children")) {
      const id = decodeURIComponent(url.slice("/session/".length));
      return id.startsWith("ses-old") ? json(200, { id }) : json(404, { error: "not found" });
    }
    if (req.method === "GET" && url.endsWith("/children")) {
      return json(200, [{ id: "child-1" }]);
    }
    if (req.method === "POST" && url.endsWith("/abort")) return json(200, true);
    if (req.method === "POST" && url.endsWith("/message")) {
      let text = "";
      try { text = JSON.parse(body).parts?.[0]?.text ?? ""; } catch {}
      if (text.includes("HANG")) {
        const timer = setInterval(() => {}, 1000);
        res.on("close", () => clearInterval(timer));
        return;
      }
      return json(200, { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] });
    }
    return json(404, { error: "unknown" });
  });
});
server.listen(port, "127.0.0.1");
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tp-opencode-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "app");
  const api = join(dir, "api");
  mkdirSync(app, { recursive: true });
  mkdirSync(api, { recursive: true });
  const bin = join(dir, "fake-opencode.mjs");
  writeFileSync(bin, FAKE, "utf8");
  chmodSync(bin, 0o755);
  return {
    dir,
    app,
    api,
    bin,
    servers: join(dir, "servers.jsonl"),
    requests: join(dir, "requests.jsonl"),
    log: () => {},
  };
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("opencode adapter helpers", () => {
  it("joins the assistant text parts", () => {
    assert.equal(
      messageText({ parts: [{ type: "text", text: "a" }, { type: "tool", text: "x" }, { type: "text", text: "b" }] }),
      "ab",
    );
    assert.equal(messageText({}), "");
  });
});

describe("opencode resident session", () => {
  it("starts one server per directory and creates one session per cwd", async (t) => {
    const f = fixture(t);
    const pool = createOpenCodePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const app = pool.openSession({ cwd: f.app, role: "project" });
    const api = pool.openSession({ cwd: f.api, role: "project" });
    assert.equal((await app.send("one", { timeoutMs: 8000 })).ok, true);
    assert.equal((await api.send("two", { timeoutMs: 8000 })).ok, true);
    const servers = readLines(f.servers);
    assert.equal(servers.length, 2, "one server per directory");
    assert.deepEqual(servers.map((row) => realpathSync(row.cwd)).sort(), [realpathSync(f.app), realpathSync(f.api)].sort());
    const created = readLines(f.requests).filter((row) => row.method === "POST" && row.url === "/session");
    assert.equal(created.length, 2);
  });

  it("keeps one session across turns and records child sessions", async (t) => {
    const f = fixture(t);
    const pool = createOpenCodePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const first = await session.send("one", { timeoutMs: 8000 });
    const second = await session.send("SPAWN two", { timeoutMs: 8000 });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.sessionId, first.sessionId);
    assert.ok(second.ids.includes("child-1"), JSON.stringify(second.ids));
    const created = readLines(f.requests).filter((row) => row.method === "POST" && row.url === "/session");
    assert.equal(created.length, 1, "one session for two turns");
  });

  it("resumes an existing server-side session instead of creating one", async (t) => {
    const f = fixture(t);
    const pool = createOpenCodePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, sessionId: "ses-old-1", role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 8000 });
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.sessionId, "ses-old-1");
    const created = readLines(f.requests).filter((row) => row.method === "POST" && row.url === "/session");
    assert.equal(created.length, 0);
  });

  it("times a hung turn out and aborts the server-side turn", async (t) => {
    const f = fixture(t);
    const pool = createOpenCodePool({ opts: {}, bin: f.bin, log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const outcome = await session.send("HANG", { timeoutMs: 300 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /timed out/);
    const aborted = readLines(f.requests).some((row) => row.method === "POST" && row.url.endsWith("/abort"));
    assert.equal(aborted, true, "the turn is aborted, not merely abandoned");
  });

  it("reports a missing agent binary instead of hanging", async (t) => {
    const f = fixture(t);
    const pool = createOpenCodePool({ opts: {}, bin: join(f.dir, "missing"), log: f.log });
    t.after(() => pool.close());
    const session = pool.openSession({ cwd: f.app, role: "project" });
    const outcome = await session.send("hello", { timeoutMs: 3000 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /not ready|exited|spawn/i);
  });
});
