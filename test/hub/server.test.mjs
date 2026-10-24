/**
 * The hub server driven **in-process**.
 *
 * The detached-child legs in `hub.test.mjs` prove the deployment shape (one
 * board connection, process-group survival). These legs run the same server in
 * the test process, so its protocol, registration engine, persistence and
 * shutdown are measured by the coverage gate. The CLI still talks to it over a
 * real loopback socket.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runHub } from "../../src/cli/commands/events.mjs";
import { run } from "../../src/cli/index.mjs";
import { hubRecords } from "../../src/cli/hub/client.mjs";
import { hubCall, hubPaths, newHubToken, readJsonFile, writeJsonFile } from "../../src/cli/hub/runtime.mjs";
import { createHubServer } from "../../src/cli/hub/server.mjs";
import { createBoardClient } from "../../src/foundation/transport/client.mjs";
import { fakeBoard } from "./helpers/fake-board.mjs";

const TOKEN = "td_hubserver";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(fn, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(30);
  }
}

describe("hub server (in process)", () => {
  let board;
  let hubDir;
  let projectDir;
  let env;
  let client;
  let server;

  beforeEach(async () => {
    hubDir = mkdtempSync(join(tmpdir(), "meerkat-hub-server-"));
    projectDir = mkdtempSync(join(tmpdir(), "meerkat-hub-project-"));
    board = await fakeBoard();
    env = { ...process.env, MEERKAT_HUB_DIR: hubDir, TASKD_NO_AUTOSTART: "1" };
    delete env.TASKD_TOKEN;
    delete env.MEERKAT_TASKPANEL_ENV_FILE;
    client = createBoardClient({
      url: board.url,
      token: TOKEN,
      actor: { kind: "claude", id: "tester" },
    });
    server = await runHub({ client, board: { url: board.url, token: TOKEN }, env }, { log: () => {} });
  });

  afterEach(async () => {
    await server?.stop();
    await board?.close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const cli = async (args) => {
    let stdout = "";
    let stderr = "";
    const exit = await run(
      ["--url", board.url, "--token", TOKEN, ...args, "--actor-kind", "claude", "--agent", "tester"],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        env,
        cwd: projectDir,
      },
    );
    return { exit, stdout, stderr };
  };

  const cardPath = (identifier) => join(projectDir, ".meerkat", identifier, "card.md");
  const pointer = () => readJsonFile(hubPaths(board.url, TOKEN, env).pointer);

  it("serves a detached registration, a status query and a stop over the socket", async () => {
    board.add("DEMO-0001", "uuid-1", "# v1\n");
    const detach = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--detach", "--json"]);
    assert.equal(detach.exit, 0, detach.stderr);
    assert.equal(JSON.parse(detach.stdout).data.running, true);
    assert.equal(readFileSync(cardPath("DEMO-0001"), "utf8"), "# v1\n");

    board.update("DEMO-0001", { markdown: "# v2\n" });
    board.emit("uuid-1");
    await waitFor(() => readFileSync(cardPath("DEMO-0001"), "utf8").includes("v2"));

    const status = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(JSON.parse(status.stdout).data.running, true);

    const stop = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--stop", "--json"]);
    assert.equal(JSON.parse(stop.stdout).data.stopped, true);
    const after = await cli(["export", "watch", "DEMO-0001", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(JSON.parse(after.stdout).data.running, false);
    assert.equal(board.connections(), 1);
  });

  it("streams follow records and honours an idle bound", async () => {
    const result = await cli(["events", "follow", "--idle", "60"]);
    assert.equal(result.exit, 0, result.stderr);
    const types = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type);
    assert.equal(types[0], "open");
    assert.ok(types.includes("idle"));
  });

  it("serves a foreground watch and ends it at the TTL", async () => {
    board.add("DEMO-0002", "uuid-2", "# foreground\n");
    const result = await cli(["export", "watch", "DEMO-0002", "--dir", projectDir, "--ttl", "300"]);
    assert.equal(result.exit, 0, result.stderr);
    const types = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type);
    assert.equal(types[0], "open");
    assert.ok(types.includes("refresh"));
    assert.equal(types.at(-1), "ttl");
    assert.equal(readFileSync(cardPath("DEMO-0002"), "utf8"), "# foreground\n");
  });

  it("stops a registration when the card reaches done", async () => {
    board.add("DEMO-0003", "uuid-3", "# open\n");
    await cli(["export", "watch", "DEMO-0003", "--dir", projectDir, "--detach", "--json"]);
    board.update("DEMO-0003", { markdown: "# final\n", status: "done" });
    board.emit("uuid-3");
    await waitFor(() => readFileSync(cardPath("DEMO-0003"), "utf8").includes("final"));
    await waitFor(async () => {
      const status = await cli(["export", "watch", "DEMO-0003", "--dir", projectDir, "--watch-status", "--json"]);
      return JSON.parse(status.stdout).data.running === false;
    });
  });

  it("resumes a persisted registration in a new server instance", async () => {
    board.add("DEMO-0004", "uuid-4", "# persisted\n");
    await cli(["export", "watch", "DEMO-0004", "--dir", projectDir, "--detach", "--json"]);
    await server.stop();
    server = await runHub({ client, board: { url: board.url, token: TOKEN }, env }, { log: () => {} });

    await waitFor(async () => {
      const status = await cli(["export", "watch", "DEMO-0004", "--dir", projectDir, "--watch-status", "--json"]);
      return JSON.parse(status.stdout).data.running === true;
    });
    board.update("DEMO-0004", { markdown: "# resumed\n" });
    board.emit("uuid-4");
    await waitFor(() => readFileSync(cardPath("DEMO-0004"), "utf8").includes("resumed"));
  });

  it("closes a session that never authenticates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-hub-auth-"));
    try {
      const paths = hubPaths(board.url, `${TOKEN}-auth`, { MEERKAT_HUB_DIR: dir });
      const authServer = createHubServer({
        client,
        paths,
        token: newHubToken(),
        authTimeoutMs: 50,
        log: () => {},
      });
      await authServer.start();
      const live = readJsonFile(paths.pointer);
      const socket = connect(live.port, "127.0.0.1");
      const closed = await new Promise((done) => {
        const timer = setTimeout(() => done(false), 1_000);
        if (typeof timer.unref === "function") timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          done(true);
        });
      });
      assert.equal(closed, true);
      await authServer.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no-hub when the status query finds no live pointer", async () => {
    board.add("DEMO-0020", "uuid-20", "# x\n");
    await cli(["export", "watch", "DEMO-0020", "--dir", projectDir, "--detach", "--json"]);
    await server.stop();
    const status = await cli(["export", "watch", "DEMO-0020", "--dir", projectDir, "--watch-status", "--json"]);
    assert.equal(status.exit, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.reason, "no-hub");
  });

  it("reports an unknown registration as not stopped", async () => {
    const stop = await cli(["export", "watch", "DEMO-9999", "--dir", projectDir, "--stop", "--json"]);
    assert.equal(stop.exit, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).data.stopped, false);
  });

  it("is idempotent for a repeated detach", async () => {
    board.add("DEMO-0021", "uuid-21", "# dup\n");
    const first = await cli(["export", "watch", "DEMO-0021", "--dir", projectDir, "--detach", "--json"]);
    const second = await cli(["export", "watch", "DEMO-0021", "--dir", projectDir, "--detach", "--json"]);
    const one = JSON.parse(first.stdout).data;
    const two = JSON.parse(second.stdout).data;
    assert.equal(two.reused, true);
    assert.equal(two.registration_id, one.registration_id);
    assert.equal(board.connections(), 1);
  });

  it("refuses a registration whose directory is not absolute", async () => {
    const live = pointer();
    for await (const record of hubRecords(live, {
      op: "watch",
      refs: ["DEMO-0001"],
      dir: "relative",
      ttl_ms: 0,
      detach: true,
    })) {
      assert.equal(record.type, "error");
      assert.equal(record.data.code, "CLI_USAGE");
      break;
    }
  });

  it("exits after the idle window with nothing to serve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-hub-idle-"));
    try {
      const paths = hubPaths(board.url, `${TOKEN}-idle`, { MEERKAT_HUB_DIR: dir });
      const idleServer = createHubServer({
        client,
        paths,
        token: newHubToken(),
        hubIdleMs: 30,
        log: () => {},
      });
      await idleServer.start();
      await idleServer.wait();
      assert.equal(readJsonFile(paths.pointer), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends shutdown to a follower when the hub stops", async () => {
    const live = pointer();
    const seen = [];
    const consume = (async () => {
      for await (const record of hubRecords(live, { op: "follow", after: null, idle_ms: 0 })) {
        seen.push(record.type);
      }
    })();
    await waitFor(() => seen.includes("open"));
    await server.stop();
    await waitFor(() => seen.includes("shutdown"));
    await consume;
  });

  it("answers status and stop by registration id", async () => {
    board.add("DEMO-0030", "uuid-30", "# id\n");
    const detach = await cli(["export", "watch", "DEMO-0030", "--dir", projectDir, "--detach", "--json"]);
    const { registration_id: registrationId } = JSON.parse(detach.stdout).data;
    const live = pointer();
    const status = await hubCall(
      live,
      live.token,
      { op: "watch-status", registration_id: registrationId },
      (record) => record.op === "watch-status",
    );
    assert.equal(status.running, true);
    const stop = await hubCall(
      live,
      live.token,
      { op: "watch-stop", registration_id: registrationId },
      (record) => record.op === "watch-stop",
    );
    assert.equal(stop.stopped, true);
  });

  it("replays retained events to a follower with a cursor", async () => {
    board.add("DEMO-0031", "uuid-31", "# replay\n");
    await cli(["export", "watch", "DEMO-0031", "--dir", projectDir, "--detach", "--json"]);
    board.update("DEMO-0031", { markdown: "# replay v2\n" });
    board.emit("uuid-31");
    await waitFor(() => readFileSync(cardPath("DEMO-0031"), "utf8").includes("replay v2"));

    const live = pointer();
    const seen = [];
    for await (const record of hubRecords(live, { op: "follow", after: 0, idle_ms: 0 })) {
      if (record.type === "event") seen.push(record.id);
      if (seen.length > 0) break;
    }
    assert.ok(seen.length >= 1);
  });

  it("refreshes every registration on an event without a task_id", async () => {
    board.add("DEMO-0032", "uuid-32", "# one\n");
    board.add("DEMO-0033", "uuid-33", "# two\n");
    await cli(["export", "watch", "DEMO-0032", "--dir", projectDir, "--detach", "--json"]);
    await cli(["export", "watch", "DEMO-0033", "--dir", projectDir, "--detach", "--json"]);
    board.update("DEMO-0032", { markdown: "# one v2\n" });
    board.update("DEMO-0033", { markdown: "# two v2\n" });
    board.emit(null);
    await waitFor(() => readFileSync(cardPath("DEMO-0032"), "utf8").includes("one v2"));
    await waitFor(() => readFileSync(cardPath("DEMO-0033"), "utf8").includes("two v2"));
  });

  it("drops invalid, expired and unresolvable persisted registrations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meerkat-hub-rehydrate-"));
    try {
      const token = `${TOKEN}-rehydrate`;
      const rehydrateEnv = { ...env, MEERKAT_HUB_DIR: dir };
      const paths = hubPaths(board.url, token, rehydrateEnv);
      writeJsonFile(paths.state, {
        version: 1,
        registrations: [
          { id: "invalid", refs: ["DEMO-0001"], dir: projectDir, ttl_ms: "nope", created_at: 0, expires_at: null },
          { id: "expired", refs: ["DEMO-0002"], dir: projectDir, ttl_ms: 100, created_at: 0, expires_at: 1 },
          { id: "unresolvable", refs: ["MISSING"], dir: projectDir, ttl_ms: 1_000, created_at: 0, expires_at: null },
        ],
      });
      const rehydrated = await runHub(
        { client, board: { url: board.url, token }, env: rehydrateEnv },
        { log: () => {} },
      );
      const live = readJsonFile(paths.pointer);
      for (const id of ["invalid", "expired", "unresolvable"]) {
        const status = await hubCall(
          live,
          live.token,
          { op: "watch-status", registration_id: id },
          (record) => record.op === "watch-status",
        );
        assert.equal(status.running, false);
      }
      await rehydrated.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers ping, refuses a wrong token and reports an unknown operation", async () => {
    const live = pointer();
    assert.ok(live !== null);
    const pong = await hubCall(live, live.token, { op: "ping" }, { match: (record) => record.op === "ping" });
    assert.equal(pong.ok, true);

    await assert.rejects(
      () => hubCall(live, "not-the-hub-token", { op: "ping" }, { match: (record) => record.op === "ping" }),
      (err) => err.code === "CLI_IO",
    );

    for await (const record of hubRecords(live, { op: "nope" })) {
      assert.equal(record.op, "error");
      assert.equal(record.ok, false);
      break;
    }
  });
});
