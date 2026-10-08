/**
 * `src/mcp` at the unit level.
 *
 * The other four suites in this directory are deliberately end-to-end: they
 * spawn a real `taskd`, or a real MCP child process, or both. That is what makes
 * them worth having, and it is also what leaves a specific set of code cold —
 * the guard clauses for shapes no well-behaved host ever sends, the actor
 * fallbacks for environments a test never happens to set, the exported
 * conveniences nobody's happy path calls.
 *
 * M3's tree is now inside the coverage gate (§`test/core/coverage-gate.test.mjs`,
 * `src/mcp` gate), and the honest way to bring those branches in is to exercise
 * them, not to exclude the files. So this file calls them directly, in-process,
 * with no board: it is the unit layer under the integration layer.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DomainError } from "../../src/shared/errors.mjs";
import {
  JSONRPC_ERROR,
  LATEST_PROTOCOL_VERSION,
  MCP_ACTOR_KIND,
  MCP_DEFAULT_ACTOR_ID,
  TOOLS,
  createBoardSession,
  createMcpServer,
  errorPayloadOf,
  findTool,
  handleMessage,
  invalidParams,
  mcpIdentity,
  ok,
  publicTool,
  validateInput,
} from "../../src/mcp/index.mjs";
import { writeLine } from "../../src/mcp/main.mjs";
import { input as inputSchema, objectArray } from "../../src/mcp/tools/schema.mjs";
import { cleanupTempDirs, createMcpSession, makeTempDir } from "./helpers/mcp-harness.mjs";

after(cleanupTempDirs);

describe("mcp/units — the actor MCP presents (G3)", () => {
  it("is an agent whatever the environment claims, and takes the widest name first", () => {
    const identity = mcpIdentity({
      env: { TASKCTL_AGENT: "linus", TASKCTL_SESSION_ID: "sid", TASKCTL_AGENT_PLATFORM: "claude" },
      clientInfo: { name: "claude-code" },
    });
    assert.equal(identity.actor.kind, MCP_ACTOR_KIND);
    assert.equal(identity.actor.kind, "agent", "a host over stdio is never a human at a terminal");
    assert.equal(identity.actor.id, "linus");

    // Each fallback in turn: agent → session id → clientInfo.name → "mcp".
    assert.equal(mcpIdentity({ env: { TASKCTL_SESSION_ID: "sid" }, clientInfo: { name: "claude-code" } }).actor.id, "sid");
    assert.equal(mcpIdentity({ env: {}, clientInfo: { name: "claude-code" } }).actor.id, "claude-code");
    assert.equal(mcpIdentity({ env: {} }).actor.id, MCP_DEFAULT_ACTOR_ID);
    assert.equal(mcpIdentity({ env: {}, clientInfo: {} }).actor.id, MCP_DEFAULT_ACTOR_ID, "an unnamed client is still no name");
    assert.equal(mcpIdentity({ env: {}, clientInfo: null }).actor.id, MCP_DEFAULT_ACTOR_ID);
  });

  it("carries the session and the segment, or nulls", () => {
    const both = mcpIdentity({ env: { TASKCTL_SESSION_ID: "sid", TASKCTL_SEG: "seg2-impl" } });
    assert.equal(both.session, "sid");
    assert.equal(both.seg, "seg2-impl");

    const bare = mcpIdentity({ env: {} });
    assert.equal(bare.session, null);
    assert.equal(bare.seg, null);
  });

  it("falls back to the real process env when nothing is injected", () => {
    // Covers the `input.env ?? process.env` arm. The value is the caller's
    // environment, so only the shape is asserted — this must not depend on who
    // happens to be running the suite.
    const identity = mcpIdentity();
    assert.equal(identity.actor.kind, "agent");
    assert.equal(typeof identity.actor.id, "string");
    assert.ok(identity.actor.id.length > 0);
  });
});

describe("mcp/units — the exported entry points", () => {
  it("answers one line through the one-shot `handleMessage`", async () => {
    const raw = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    assert.deepEqual(JSON.parse(raw), { jsonrpc: "2.0", id: 1, result: {} });
  });

  it("reuses a caller-supplied server, so a handshake is not thrown away", async () => {
    const server = createMcpServer();
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));

    const raw = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }), { server });
    assert.equal(JSON.parse(raw).id, 7);
    assert.equal(server.protocolVersion, "2024-11-05", "the same server answered both");

    // A notification is still answered with silence, whichever entry is used.
    assert.equal(
      await handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { server }),
      null,
    );
  });

  it("reports the protocol version it settled on", async () => {
    const server = createMcpServer();
    assert.equal(server.protocolVersion, LATEST_PROTOCOL_VERSION, "before a handshake");

    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    );
    assert.equal(server.protocolVersion, "2025-03-26", "a version we know is echoed");

    await server.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }),
    );
    assert.equal(server.protocolVersion, LATEST_PROTOCOL_VERSION, "an unknown one falls back");
  });
});

describe("mcp/units — the shape guards around tools/call", () => {
  it("refuses a params value that is not an object", async () => {
    const session = createMcpSession();
    for (const params of [null, [], "task_list", 7, true]) {
      const response = await session.request("tools/call", params);
      assert.equal(response.error.code, JSONRPC_ERROR.INVALID_PARAMS, `params=${JSON.stringify(params)}`);
      assert.equal(response.error.code, -32602);
      assert.match(response.error.message, /requires an object/);
    }
  });

  it("refuses a missing tool name", async () => {
    const session = createMcpSession();
    const response = await session.request("tools/call", { arguments: {} });
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /requires a tool `name`/);
  });

  it("refuses arguments that are not an object", async () => {
    const session = createMcpSession();
    for (const args of [42, "x", [], true]) {
      const response = await session.request("tools/call", { name: "task_list", arguments: args });
      assert.equal(response.error.code, -32602, `arguments=${JSON.stringify(args)}`);
      assert.match(response.error.message, /arguments must be an object/);
    }
    // `null` reads as "no arguments given" rather than as a malformed call.
    const absent = await session.request("tools/call", { name: "definitely_not_a_tool", arguments: null });
    assert.match(absent.error.message, /Unknown tool/);
  });
});

describe("mcp/units — schema enforcement", () => {
  it("rejects a value of the wrong type, and says which", () => {
    assert.throws(
      () => validateInput(findTool("task_list"), { limit: "5" }),
      (err) => {
        assert.equal(err.code, "CLI_USAGE");
        assert.match(err.message, /task_list/);
        assert.match(err.message, /limit/);
        assert.match(err.message, /must be of type integer/);
        return true;
      },
    );
  });

  it("holds a union to its matching branch, enum included", () => {
    // `task_list.status` is "one status, or several". The array branch declares
    // no `enum`, and an unchecked fragment must not be read as "anything goes".
    const list = findTool("task_list");
    assert.throws(() => validateInput(list, { status: "shipped" }), (err) => err.code === "CLI_USAGE");
    assert.throws(() => validateInput(list, { status: ["shipped"] }), (err) => err.code === "CLI_USAGE");
    assert.throws(() => validateInput(list, { status: ["todo", "shipped"] }), (err) => err.code === "CLI_USAGE");
    assert.throws(() => validateInput(list, { status: 42 }), (err) => err.code === "CLI_USAGE");

    // …and the shapes it does accept still pass.
    validateInput(list, {});
    validateInput(list, { status: "todo" });
    validateInput(list, { status: ["todo", "in_review"] });
  });

  it("names the allowed values when an enum is what failed", () => {
    assert.throws(
      () => validateInput(findTool("task_move"), { ref: "DEMO-0001", to: "shipped" }),
      (err) => {
        assert.equal(err.code, "CLI_USAGE");
        assert.match(err.message, /must be one of/);
        assert.ok(err.details.expected.includes("in_review"));
        return true;
      },
    );
  });

  it("rejects an undeclared argument and a missing required one", () => {
    assert.throws(
      () => validateInput(findTool("task_get"), { ref: "DEMO-0001", nope: 1 }),
      (err) => err.code === "CLI_USAGE" && /nope/.test(err.message),
    );
    assert.throws(
      () => validateInput(findTool("task_get"), {}),
      (err) => err.code === "CLI_USAGE" && /Missing required argument "ref"/.test(err.message),
    );
    assert.throws(
      () => validateInput(findTool("task_get"), { ref: null }),
      (err) => err.code === "CLI_USAGE",
      "null means 'I have no ref', not 'the ref is null'",
    );
    // An explicit `undefined` is "not mentioned" and must not trip the type check.
    validateInput(findTool("task_get"), { ref: "DEMO-0001" });
  });

  it("runs a tool's own cross-field rule last", () => {
    assert.throws(
      () => validateInput(findTool("task_deliver"), { ref: "DEMO-0001" }),
      (err) => err.code === "CLI_USAGE" && /report is required/.test(err.message),
    );
  });
});

describe("mcp/units — the tool table", () => {
  it("projects a tool for tools/list without leaking its handler", () => {
    assert.equal(TOOLS.length, 18);

    const read = publicTool(findTool("task_list"));
    assert.deepEqual(Object.keys(read).sort(), ["annotations", "description", "inputSchema", "name"]);
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(Object.hasOwn(read, "handler"), false, "the handler is not part of the advertisement");

    assert.equal(publicTool(findTool("task_create")).annotations.readOnlyHint, false);
    assert.equal(findTool("no_such_tool"), undefined);
  });
});

describe("mcp/units — result projection", () => {
  it("keeps a success to one block when there is nothing to warn about", () => {
    const result = ok({ payload: { id: "DEMO-0001" } });
    assert.equal(result.isError, false);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), { id: "DEMO-0001" });
  });

  it("merges warnings into the payload and repeats them as prose", () => {
    const result = ok({ payload: { id: "DEMO-0001" }, warnings: ["mind the TODOs", ""] });
    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[0].text), { id: "DEMO-0001", warnings: ["mind the TODOs"] });
    assert.equal(result.content[1].text, "mind the TODOs");
  });

  it("accepts a bare payload, and tolerates nothing at all", () => {
    assert.deepEqual(JSON.parse(ok({ id: "DEMO-0001" }).content[0].text), { id: "DEMO-0001" });
    assert.deepEqual(JSON.parse(ok(null).content[0].text), {});
    assert.deepEqual(JSON.parse(ok(undefined).content[0].text), {});
    assert.deepEqual(JSON.parse(ok({ payload: { a: 1 }, warnings: "not an array" }).content[0].text), { a: 1 });
  });

  it("rebuilds a domain error through the shared mapper, field for field", () => {
    const payload = errorPayloadOf(
      new DomainError("NOT_FOUND", { message: "no task X", details: { taskRef: "X" } }),
    );
    assert.equal(payload.code, "NOT_FOUND");
    assert.equal(payload.http, 404);
    assert.equal(payload.message, "no task X");
    assert.deepEqual(payload.details, { taskRef: "X" });
    assert.equal(payload.hint, null);
  });

  it("normalises something that was never a domain error", () => {
    const payload = errorPayloadOf(new TypeError("boom"));
    assert.equal(payload.code, "VALIDATION_FAILED");
    assert.equal(payload.http, 500);
    assert.equal(payload.message, "boom");
  });

  it("builds a usage refusal that carries a code", () => {
    const err = invalidParams("bad input");
    assert.equal(err.code, "CLI_USAGE");
    assert.equal(err.message, "bad input");
  });
});

describe("mcp/units — the lazy board session", () => {
  it("records a clientInfo without connecting, and exposes no eager board view", () => {
    const board = createBoardSession({ url: "http://127.0.0.1:1", env: {} });

    // Junk in every shape must be tolerated, not thrown: `initialize` calls this
    // before any tool call, and a host's `clientInfo` is not ours to trust.
    board.identify({ name: "claude-code" });
    board.identify(null);
    board.identify("not an object at all");
    board.identify({ name: 42 });

    // The only read surface is `context()`; an eager `peek()` was removed as
    // dead code in M3fix D3.
    assert.equal(typeof board.context, "function");
    assert.equal(Object.hasOwn(board, "peek"), false, "the dead accessor stays gone");
  });
});

describe("mcp/units — the stdout write pump", () => {
  it("resolves immediately when the stream accepts the line", async () => {
    const stream = {
      write: () => true,
      once: () => {
        throw new Error("must not wait for a drain it does not need");
      },
    };
    await writeLine(stream, "line\n");
  });

  it("waits for `drain` when the pipe applies back-pressure", async () => {
    let waited = false;
    const stream = {
      write: () => false,
      once(event, fn) {
        assert.equal(event, "drain");
        waited = true;
        queueMicrotask(fn); // the stream drains a moment later
      },
    };
    await writeLine(stream, "line\n");
    assert.equal(waited, true, "a `false` write must be awaited, not dropped");
  });
});

describe("mcp/units — a refusal never echoes a host path (M3fix D3)", () => {
  /** The whole payload as text, which is what a caller would actually read. */
  const asText = (payload) => JSON.stringify(payload);

  it("keeps TOKEN_FILE_CORRUPT free of the token file's absolute path", async () => {
    const dir = makeTempDir("taskpanel-mcp-leak-");
    writeFileSync(
      join(dir, "runtime.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", tokenFile: join(dir, "corrupt.token") }),
    );
    writeFileSync(join(dir, "corrupt.token"), "not-a-token\n");

    const session = createMcpSession({
      url: null,
      token: null,
      env: { TASKD_RUNTIME_POINTER: join(dir, "runtime.json"), TASKD_NO_AUTOSTART: "1", TASKD_DATA_DIR: dir },
    });

    const result = await session.call("task_list", {});
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "TOKEN_FILE_CORRUPT");
    const text = asText(result.payload);
    assert.equal(text.includes(dir), false, `the payload must not name ${dir}:\n${text}`);
    assert.equal(/"\/(?:Users|home|app|private|var|tmp)\//.test(text), false, text);
  });

  it("keeps the stale-pointer CLI_IO free of the pointer's absolute path", async () => {
    const dir = makeTempDir("taskpanel-mcp-leak-");
    const pointer = join(dir, "runtime.json");
    writeFileSync(pointer, JSON.stringify({ url: "http://127.0.0.1:1", port: 1, pid: 999999 }));

    const session = createMcpSession({
      url: null,
      token: null,
      env: { TASKD_RUNTIME_POINTER: pointer, TASKD_NO_AUTOSTART: "1", TASKD_DATA_DIR: dir },
    });

    const result = await session.call("task_list", {});
    assert.equal(result.isError, true);
    assert.equal(result.payload.code, "CLI_IO");
    const text = asText(result.payload);
    assert.equal(text.includes(dir), false, `the payload must not name ${dir}:\n${text}`);
    assert.equal(/"\/(?:Users|home|app|private|var|tmp)\//.test(text), false, text);
  });
});

describe("mcp/units — schema fragments", () => {
  it("closes every object it builds", () => {
    const schema = inputSchema({ a: { type: "string", description: "x" } }, ["a"]);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["a"]);
    assert.deepEqual(inputSchema({}).required, []);
  });

  it("builds an array of free-form objects", () => {
    assert.deepEqual(objectArray("the evidence anchors"), {
      type: "array",
      description: "the evidence anchors",
      items: { type: "object" },
    });
  });
});
