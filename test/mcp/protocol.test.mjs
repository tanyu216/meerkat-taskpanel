/**
 * The MCP protocol contract (R1, R2, R7 — plan §5.1).
 *
 * M3 hand-writes the JSON-RPC surface instead of importing the SDK, so the
 * specification is not enforced by a dependency — it is enforced *here*. Every
 * assertion below is a clause of the protocol (or a deliberate local decision
 * documented in `src/mcp/README.md`), and none of them needs a board: the
 * handshake and the tool listing must work on a machine where `taskd` has never
 * run.
 *
 * The shape of this file is the point. It asserts *exact* documents — the
 * version negotiation, the capabilities actually declared, the JSON-RPC error
 * codes, the schema of all 18 tools — rather than "it answered something",
 * because "200 lines of hand-written protocol" is only safe while its contract
 * is pinned.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PACKAGE_NAME, VERSION } from "../../src/shared/constants.mjs";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createLineFramer,
  JSONRPC_ERROR,
} from "../../src/mcp/index.mjs";
import { parseArgv } from "../../src/mcp/main.mjs";
import { createMcpSession, readToolResult } from "./helpers/mcp-harness.mjs";

/** The frozen tool set (card Acceptance #2). Exactly these — no more, no fewer. */
const FROZEN_TOOLS = [
  "task_list",
  "task_get",
  "task_create",
  "task_update",
  "task_move",
  "task_deliver",
  "task_comment_list",
  "task_comment_add",
  "task_relation_list",
  "task_relation_add",
  "task_relation_remove",
  "session_list",
  "session_set",
  "session_close",
  "label_list",
  "assignee_list",
  "reporter_list",
  "project_list",
];

/** The seven canonical statuses (`src/core/domain/enums.mjs`). */
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];

/** A session that has already handshaken — `tools/list` does not need one, but
 *  the negotiation is cheap and matches what a real host does. */
async function handshaken(options = {}) {
  const session = createMcpSession(options);
  await session.initialize();
  return session;
}

describe("mcp/protocol — handshake", () => {
  it("answers `initialize` with exactly the three capabilities it has", async () => {
    const session = createMcpSession();
    const response = await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1.0.0" },
    });

    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);

    const result = response.result;
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.deepEqual(result.capabilities, { tools: {} }, "declare only what is implemented");
    assert.equal(result.serverInfo.name, PACKAGE_NAME);
    assert.equal(result.serverInfo.version, VERSION);
    // No `resources`, no `prompts`, no `logging`, no `completions`, no `tasks`.
    assert.deepEqual(Object.keys(result.capabilities), ["tools"]);
  });

  it("echoes a protocol version it knows and falls back to the newest it does not", async () => {
    assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2024-11-05", "2025-03-26", "2025-06-18"]);
    assert.equal(LATEST_PROTOCOL_VERSION, "2025-06-18");

    const session = createMcpSession();
    const old = await session.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(old.result.protocolVersion, "2024-11-05", "a version we know is echoed back");

    const future = await session.request("initialize", { protocolVersion: "2099-01-01" });
    assert.equal(future.result.protocolVersion, LATEST_PROTOCOL_VERSION, "an unknown version falls back");

    const absent = await session.request("initialize", {});
    assert.equal(absent.result.protocolVersion, LATEST_PROTOCOL_VERSION, "and so does a missing one");
  });

  it("stays silent for notifications, in every spelling", async () => {
    const session = createMcpSession();
    await session.initialize();

    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"]) {
      const raw = await session.notify(method);
      assert.equal(raw, null, `${method} must not be answered`);
    }
  });

  it("answers `ping` with an empty result", async () => {
    const session = createMcpSession();
    const response = await session.request("ping");
    assert.deepEqual(response.result, {});
  });
});

describe("mcp/protocol — JSON-RPC errors", () => {
  it("refuses an unknown method with -32601", async () => {
    const session = createMcpSession();
    const response = await session.request("resources/list");
    assert.equal(response.error.code, JSONRPC_ERROR.METHOD_NOT_FOUND);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /resources\/list/);
  });

  it("refuses a line that is not JSON with -32700 and a null id", async () => {
    const session = createMcpSession();
    const raw = await session.server.handleLine('{"jsonrpc": "2.0", "id": 1,');
    const response = JSON.parse(raw);
    assert.equal(response.error.code, -32700);
    assert.equal(response.id, null);
    assert.equal(response.jsonrpc, "2.0");
  });

  it("refuses a non-object message and a message without a method with -32600", async () => {
    const session = createMcpSession();
    for (const line of ["42", '"hello"', "null", "{}", '{"jsonrpc":"2.0","id":7}']) {
      const response = JSON.parse(await session.server.handleLine(line));
      assert.equal(response.error.code, -32600, `${line} must be an invalid request`);
    }
    // An identifiable request keeps its id; an unidentifiable one gets `null`.
    const withId = JSON.parse(await session.server.handleLine('{"jsonrpc":"2.0","id":7}'));
    assert.equal(withId.id, 7);
  });

  it("refuses a batch with -32600 and says why (this implementation has no batch support)", async () => {
    const session = createMcpSession();
    const raw = await session.server.handleLine(
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    );
    const response = JSON.parse(raw);
    assert.equal(Array.isArray(response), false, "a batch gets one error object, not an array");
    assert.equal(response.error.code, -32600);
    assert.equal(response.error.data.reason, "batch_not_supported");
  });

  it("refuses an unknown tool with -32602, not a tool-level error", async () => {
    const session = await handshaken();
    const result = await session.call("task_assign", { ref: "DEMO-0001" });
    assert.equal(result.kind, "rpc", "the tool never ran, so this is not `isError`");
    assert.equal(result.rpc.code, -32602);
    assert.match(result.rpc.message, /Unknown tool: task_assign/);
  });
});

describe("mcp/protocol — tools/list", () => {
  it("advertises exactly the frozen tool set, and nothing else", async () => {
    const session = await handshaken();
    const response = await session.toolsList();
    const names = response.result.tools.map((tool) => tool.name);
    assert.deepEqual([...names].sort(), [...FROZEN_TOOLS].sort(), "the set must be equal, not merely similar");
    assert.equal(names.length, 18);
    assert.equal(response.result.nextCursor, undefined, "no pagination");
  });

  it("offers no dictionary-management tool, however it might be spelled", async () => {
    const session = await handshaken();
    const names = (await session.toolsList()).result.tools.map((tool) => tool.name);
    const forbidden = /^(assignee|reporter|label)_(create|update|rename|delete|archive|merge|remove|add)$/;
    assert.deepEqual(names.filter((name) => forbidden.test(name)), []);
    for (const name of ["task_assign", "task_archive", "project_create", "project_update", "token_rotate", "export"]) {
      assert.equal(names.includes(name), false, `${name} must not be advertised`);
    }
  });

  it("marks every read-only tool as such", async () => {
    const session = await handshaken();
    const tools = (await session.toolsList()).result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["task_list", "task_get", "label_list", "assignee_list", "reporter_list", "project_list", "task_comment_list", "task_relation_list", "session_list"]) {
      assert.equal(byName.get(name).annotations.readOnlyHint, true, `${name} is a read`);
    }
    for (const name of ["task_create", "task_update", "task_move", "task_deliver", "task_comment_add", "session_set"]) {
      assert.equal(byName.get(name).annotations?.readOnlyHint === true, false, `${name} writes`);
    }
  });

  it("gives every tool a description and an object schema that closes itself", async () => {
    const session = await handshaken();
    const tools = (await session.toolsList()).result.tools;
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
      assert.ok(tool.description.length > 20, `${tool.name}'s description must actually say something`);

      const schema = tool.inputSchema;
      assert.equal(schema.type, "object", `${tool.name}.inputSchema.type`);
      assert.equal(schema.additionalProperties, false, `${tool.name} must refuse undeclared arguments`);
      assert.ok(Array.isArray(schema.required), `${tool.name}.required`);
      for (const key of schema.required) {
        assert.ok(Object.hasOwn(schema.properties, key), `${tool.name}: required ${key} is not a property`);
      }
      for (const [key, property] of Object.entries(schema.properties)) {
        assert.equal(typeof property.description, "string", `${tool.name}.${key} needs a description`);
        // Either a single type, or a union of typed branches (`task_list.status`
        // is "one status or several"). An untyped fragment would be unenforceable.
        const branches = Array.isArray(property.anyOf) ? property.anyOf : [property];
        for (const branch of branches) {
          assert.equal(typeof branch.type, "string", `${tool.name}.${key} needs a type on every branch`);
        }
      }
    }
  });

  it("pins the two schemas the acceptance criteria are about", async () => {
    const session = await handshaken();
    const tools = (await session.toolsList()).result.tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // `to` is the seven statuses, no more.
    assert.deepEqual([...byName.get("task_move").inputSchema.properties.to.enum].sort(), [...STATUSES].sort());

    // The waiver is not expressible through `move`: `task_deliver` is the only
    // tool that may reach `in_review` (card Acceptance #2).
    assert.equal(Object.hasOwn(byName.get("task_move").inputSchema.properties, "no_report"), false);
    assert.equal(Object.hasOwn(byName.get("task_move").inputSchema.properties, "reason"), false);
    assert.equal(byName.get("task_move").inputSchema.additionalProperties, false);

    // `status` is not a patchable field — the service refuses it, so the tool
    // must not be able to say it.
    assert.equal(Object.hasOwn(byName.get("task_update").inputSchema.properties, "status"), false);
    assert.deepEqual(byName.get("task_update").inputSchema.required, ["ref"]);
  });
});

describe("mcp/protocol — line framing", () => {
  it("assembles a message from chunked writes and flushes a last line with no newline", () => {
    const framer = createLineFramer();
    assert.deepEqual(framer.push('{"jsonrpc":"2.0",'), [], "half a message is not a message");
    assert.deepEqual(framer.push('"id":1,"method":"ping"}\n'), ['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    assert.deepEqual(framer.push('{"jsonrpc":"2.0","id":2,"method":"ping"}'), [], "no newline yet");

    // EOF: the trailing line is a complete message and must not be dropped.
    assert.equal(framer.flush(), '{"jsonrpc":"2.0","id":2,"method":"ping"}');
    assert.equal(framer.flush(), null, "nothing left to flush");
  });

  it("keeps blank lines out of the stream instead of framing them as requests", () => {
    const framer = createLineFramer();
    assert.deepEqual(framer.push("\n\n"), []);
    assert.equal(framer.flush(), null);
  });
});

describe("mcp/protocol — argv", () => {
  it("accepts the two documented flags, in both spellings", () => {
    assert.deepEqual(parseArgv(["--url", "http://127.0.0.1:1234", "--token", "td_abc"]), {
      url: "http://127.0.0.1:1234",
      token: "td_abc",
      help: false,
    });
    assert.deepEqual(parseArgv(["--url=http://x:1"]), { url: "http://x:1", token: null, help: false });
    assert.deepEqual(parseArgv([]), { url: null, token: null, help: false });
    assert.equal(parseArgv(["--help"]).help, true);
  });

  it("refuses anything else with a usage error, not a crash", () => {
    assert.throws(() => parseArgv(["--verbose"]), (err) => err.code === "CLI_USAGE");
    assert.throws(() => parseArgv(["serve"]), (err) => err.code === "CLI_USAGE");
    assert.throws(() => parseArgv(["--url"]), (err) => err.code === "CLI_USAGE");
  });
});

describe("mcp/protocol — result normalisation", () => {
  it("separates a tool-level failure from a protocol-level one", () => {
    const tool = readToolResult({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: '{"code":"NOT_FOUND"}' }], isError: true },
    });
    assert.equal(tool.kind, "tool");
    assert.equal(tool.isError, true);
    assert.equal(tool.payload.code, "NOT_FOUND");

    const rpc = readToolResult({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "no" } });
    assert.equal(rpc.kind, "rpc");
    assert.equal(rpc.isError, null);
  });
});
