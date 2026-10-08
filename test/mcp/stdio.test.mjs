/**
 * A real MCP session over real pipes (R1/R6, plan §5.5).
 *
 * Everything else in `test/mcp/**` calls `handleMessage` in-process, which is
 * the right way to test a tool and the wrong way to test a *transport*. This file
 * spawns `node src/mcp/main.mjs` as a child process and talks to it the only way
 * a host does: bytes on stdin, bytes on stdout.
 *
 * What is only provable here:
 *
 *   * **stdout purity.** Every line that came out of the process is parsed as
 *     JSON. A stray banner or a warning written to the wrong stream fails this
 *     immediately, and in production it would wedge the session on the first
 *     response. (The pleasant side effect of `client/autostart.mjs` redirecting
 *     the daemon's stdout to a log file is what makes that even possible.)
 *   * **framing under real chunking.** A message split across two `write()`s
 *     arrives as one request; a final message with no trailing newline survives
 *     EOF.
 *   * **silence.** `notifications/initialized` causes no output *within a
 *     window* — asserted by waiting, because a silence cannot be observed.
 *   * **exit codes.** EOF is 0; a bad argv is 2 with an empty stdout.
 *
 * ⚠️ This file must never use `spawnSync`. It blocks this process's event loop
 * for the whole conversation, and anything this process hosts — a board, a
 * socket, a timer — could not run, so the child would wait forever for an answer
 * that cannot be produced. `spawn` plus an asynchronous line reader is the only
 * shape that can work.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { LATEST_PROTOCOL_VERSION } from "../../src/mcp/index.mjs";
import {
  baseEnv,
  cleanupTempDirs,
  makeTempDir,
  readJsonFile,
  startMcp,
  withMcpStdio,
} from "./helpers/mcp-harness.mjs";

after(cleanupTempDirs);

/** The frozen tool set, again — over the wire this time. */
const FROZEN_TOOLS = [
  "task_list", "task_get", "task_create", "task_update", "task_move", "task_deliver",
  "task_comment_list", "task_comment_add",
  "task_relation_list", "task_relation_add", "task_relation_remove",
  "session_list", "session_set", "session_close",
  "label_list", "assignee_list", "reporter_list", "project_list",
];

/**
 * An environment with no board and no permission to start one, so the handshake
 * tests cannot accidentally reach the developer's own `taskd` (or leave one
 * behind).
 */
function boardlessEnv() {
  const dir = makeTempDir("taskpanel-mcp-stdio-");
  return {
    TASKD_DATA_DIR: dir,
    TASKD_RUNTIME_POINTER: join(dir, "runtime.json"),
    TASKD_PORT: "0",
    TASKD_NO_AUTOSTART: "1",
  };
}

/** Parse a stdout line, with the raw text in the failure message. */
function asJson(line) {
  try {
    return JSON.parse(line);
  } catch (err) {
    assert.fail(`stdout carried something that is not JSON (${err.message}): ${JSON.stringify(line)}`);
  }
}

describe("mcp/stdio — a real session over pipes", () => {
  it("handshakes, lists tools, and exits 0 on EOF", async () => {
    const mcp = await startMcp({ env: boardlessEnv() });
    try {
      mcp.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } },
      });
      const init = asJson(await mcp.nextLine());
      assert.equal(init.jsonrpc, "2.0");
      assert.equal(init.id, 1);
      assert.equal(init.result.protocolVersion, LATEST_PROTOCOL_VERSION);
      assert.deepEqual(Object.keys(init.result.capabilities), ["tools"]);
      assert.equal(init.result.serverInfo.name, "task-panel");

      mcp.notify("notifications/initialized");
      assert.equal(await mcp.silentFor(500), true, "a notification must produce no output at all");

      mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = asJson(await mcp.nextLine());
      assert.deepEqual(
        listed.result.tools.map((tool) => tool.name),
        FROZEN_TOOLS,
        "the tool list, in order, over the wire",
      );

      const exit = await mcp.close();
      assert.equal(exit.code, 0);
      assert.equal(mcp.dangling(), "", "a clean EOF leaves no half-line behind");
    } finally {
      await mcp.close().catch(() => {});
    }
  });

  it("writes JSON-RPC to stdout and nothing else, ever", async () => {
    const mcp = await startMcp({ env: boardlessEnv() });
    try {
      mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      mcp.send({ jsonrpc: "2.0", id: 2, method: "ping" });
      mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      mcp.send({ jsonrpc: "2.0", id: 4, method: "nope/nothing" });
      mcp.send("{ this is not json");

      await mcp.nextLine();
      await mcp.nextLine();
      await mcp.nextLine();
      await mcp.nextLine();
      await mcp.nextLine();
      await mcp.close();

      assert.equal(mcp.lines.length, 5, "one reply per request, and none for the notification");
      for (const line of mcp.lines) asJson(line);
    } finally {
      await mcp.close().catch(() => {});
    }
  });

  it("frames a message split across writes, and flushes a last line with no newline", async () => {
    const mcp = await startMcp({ env: boardlessEnv() });
    try {
      // Two chunks, one message: the framer must not answer until it is whole.
      mcp.write('{"jsonrpc":"2.0","id":9,"method":"pi');
      mcp.write('ng"}\n');
      const pong = asJson(await mcp.nextLine());
      assert.equal(pong.id, 9);
      assert.deepEqual(pong.result, {});

      // A complete message with no trailing newline: EOF has to flush it, or
      // `printf '%s' '{…}' | node src/mcp/main.mjs` would silently do nothing.
      mcp.write('{"jsonrpc":"2.0","id":10,"method":"ping"}');
      const exit = await mcp.close();
      assert.equal(exit.code, 0);
      assert.equal(mcp.lines.length, 2, "the unterminated last line was still answered");
      assert.equal(asJson(mcp.lines[1]).id, 10);
    } finally {
      await mcp.close().catch(() => {});
    }
  });

  it("refuses an unknown argv with exit 2 and an empty stdout", async () => {
    const mcp = await startMcp({ env: boardlessEnv(), args: ["--verbose"] });
    const exit = await mcp.close();
    assert.equal(exit.code, 2);
    assert.deepEqual(mcp.lines, [], "usage never goes to stdout");
    assert.match(mcp.stderr(), /unknown argument: --verbose/);
  });

  it("answers --help on stderr and exits 0", async () => {
    const mcp = await startMcp({ env: boardlessEnv(), args: ["--help"] });
    const exit = await mcp.close();
    assert.equal(exit.code, 0);
    assert.deepEqual(mcp.lines, []);
    assert.match(mcp.stderr(), /usage: node src\/mcp\/main\.mjs/);
  });

  it("treats SIGTERM and SIGINT as a clean shutdown (exit 0), not a crash", async () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const mcp = await startMcp({ env: boardlessEnv() });
      try {
        // A pong proves the process is past installing the handlers, so the
        // signal below reaches `shutdown` rather than the OS default action.
        mcp.send({ jsonrpc: "2.0", id: 1, method: "ping" });
        assert.deepEqual(asJson(await mcp.nextLine()).result, {});
        assert.equal(mcp.dangling(), "", "the reply was a whole line before the signal");

        mcp.child.kill(signal);
        const [code, term] = await once(mcp.child, "exit");
        assert.equal(term, null, `${signal} must be handled, not fatal by default`);
        assert.equal(code, 0, `${signal} is a clean shutdown`);
      } finally {
        await mcp.close().catch(() => {});
      }
    }
  });
});

describe("mcp/stdio — tools/call against a real board", () => {
  it("serves a tool from a real taskd over the same pipe", async () => {
    await withMcpStdio(async (ctx) => {
      ctx.mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
      asJson(await ctx.mcp.nextLine());
      ctx.mcp.notify("notifications/initialized");

      // The board the child is wired to is the one this test seeded.
      ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);

      ctx.mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project_list", arguments: {} } });
      const answer = asJson(await ctx.mcp.nextLine());
      assert.equal(answer.id, 2);
      assert.equal(answer.result.isError, false);
      const payload = JSON.parse(answer.result.content[0].text);
      assert.deepEqual(payload.projects.map((project) => project.id), ["demo"]);

      const exit = await ctx.mcp.close();
      assert.equal(exit.code, 0);
    });
  });

  it("reports a missing board as a tool failure, without breaking the session", async () => {
    const dir = makeTempDir("taskpanel-mcp-dead-");
    const mcp = await startMcp({
      env: {
        ...baseEnv(),
        TASKD_DATA_DIR: dir,
        TASKD_RUNTIME_POINTER: join(dir, "runtime.json"),
        TASKD_PORT: "0",
        TASKD_NO_AUTOSTART: "1",
      },
    });
    try {
      assert.equal(readJsonFile(join(dir, "runtime.json")), null, "no board was ever started");

      mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      asJson(await mcp.nextLine());

      mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "task_list", arguments: {} } });
      const answer = asJson(await mcp.nextLine());
      assert.equal(answer.result.isError, true);
      assert.equal(JSON.parse(answer.result.content[0].text).code, "CLI_IO");

      // The transport is still perfectly healthy.
      mcp.send({ jsonrpc: "2.0", id: 3, method: "ping" });
      assert.deepEqual(asJson(await mcp.nextLine()).result, {});
    } finally {
      await mcp.close().catch(() => {});
    }
  });
});
