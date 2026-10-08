/**
 * Method dispatch — the four methods and one notification this server has.
 *
 * `handleLine(raw) → raw | null` is the whole interface, and returning `null`
 * means *say nothing*, which is how a notification is answered. Keeping the
 * dispatcher that small is what makes the protocol testable without a process:
 * a line goes in, a line (or a silence) comes out, and everything in between is
 * a pure function of the registry plus one lazily-resolved board.
 *
 * The one distinction worth stating plainly, because it is the axis the whole
 * acceptance criterion sits on:
 *
 *   **protocol failure** → `{error: {code: -3260x}}`. The tool never ran: the
 *   method does not exist, the tool does not exist, or the arguments do not match
 *   the schema. Answered by `registry.validateInput` and this file.
 *
 *   **tool failure** → `{result: {content, isError: true}}`. The tool ran and the
 *   board refused — the delivery gate, a version conflict, a missing task.
 *   Answered by `result.mjs`, and *never* by a check in this file, because a
 *   check here is a check that can disagree with the service.
 *
 * `initialize` and `tools/list` deliberately do not touch the board (plan G2): a
 * host that is registering this server must not have to start `taskd` first.
 */

import { PACKAGE_NAME, VERSION } from "../shared/constants.mjs";
import { toErrorPayload } from "../shared/errors.mjs";
import { createBoardSession } from "./board.mjs";
import {
  JSONRPC_ERROR,
  LATEST_PROTOCOL_VERSION,
  errorResponse,
  isNotification,
  negotiateProtocolVersion,
  parseLine,
  response,
  serialize,
} from "./protocol.mjs";
import { TOOL_NAMES, findTool, toolsList, validateInput } from "./registry.mjs";
import { failed, ok } from "./result.mjs";

/**
 * @param {{url?: string|null, token?: string|null, env?: NodeJS.ProcessEnv}} [options]
 */
export function createMcpServer(options = {}) {
  const board = createBoardSession(options);

  /** The protocol version this session settled on. */
  let protocolVersion = LATEST_PROTOCOL_VERSION;

  /** @returns {object} the `initialize` result */
  function initialize(params) {
    protocolVersion = negotiateProtocolVersion(params?.protocolVersion);
    // `clientInfo.name` is the last-resort actor id (G3), so it has to be
    // captured before the first tool call constructs the identity.
    board.identify(params?.clientInfo ?? null);
    return {
      protocolVersion,
      // Only `tools`. Declaring `resources`, `prompts`, `logging` or
      // `completions` would promise a method this server answers `-32601` to.
      capabilities: { tools: {} },
      serverInfo: { name: PACKAGE_NAME, version: VERSION },
    };
  }

  /** @returns {Promise<object>} a JSON-RPC response for `tools/call` */
  async function callTool(id, params) {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return errorResponse(id, JSONRPC_ERROR.INVALID_PARAMS, "tools/call requires an object with `name` and `arguments`");
    }
    if (typeof params.name !== "string") {
      return errorResponse(id, JSONRPC_ERROR.INVALID_PARAMS, "tools/call requires a tool `name`");
    }

    const tool = findTool(params.name);
    if (tool === undefined) {
      // The official SDK's message, verbatim — a client does not have to learn
      // a second vocabulary to understand which end refused.
      return errorResponse(id, JSONRPC_ERROR.INVALID_PARAMS, `Unknown tool: ${params.name}`);
    }

    const args = params.arguments ?? {};
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return errorResponse(id, JSONRPC_ERROR.INVALID_PARAMS, `Invalid arguments for tool "${params.name}": arguments must be an object`);
    }

    try {
      validateInput(tool, args);
    } catch (err) {
      const payload = toErrorPayload(err);
      return errorResponse(id, JSONRPC_ERROR.INVALID_PARAMS, payload.message, {
        code: payload.code,
        details: payload.details,
        hint: payload.hint,
      });
    }

    // Past this line the tool *runs*. From here on, every failure is a tool
    // result with `isError: true` — including "there is no board", which is a
    // fact about the world, not about the request.
    let context;
    try {
      context = await board.context();
    } catch (err) {
      return response(id, failed(err));
    }

    try {
      return response(id, ok(await tool.handler(args, context)));
    } catch (err) {
      return response(id, failed(err));
    }
  }

  /** @returns {Promise<object|null>} `null` when the message must not be answered */
  async function handle(message) {
    const hasId = Object.hasOwn(message, "id");

    if (typeof message.method !== "string" || message.method === "") {
      return errorResponse(hasId ? message.id : null, JSONRPC_ERROR.INVALID_REQUEST, "a JSON-RPC request needs a `method` string");
    }

    // A notification is never answered — including one we do not recognise.
    if (isNotification(message)) return null;

    const id = message.id;
    switch (message.method) {
      case "initialize":
        return response(id, initialize(message.params));
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: toolsList() });
      case "tools/call":
        return callTool(id, message.params);
      default:
        return errorResponse(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `unknown method: ${message.method}`);
    }
  }

  return {
    handle,
    /** One line in, one line out (or `null` for a notification). */
    async handleLine(raw) {
      const parsed = parseLine(raw);
      if (parsed.ok === false) return serialize(parsed.response);
      const answer = await handle(parsed.message);
      return answer === null ? null : serialize(answer);
    },
    board,
    toolNames: TOOL_NAMES,
    get protocolVersion() {
      return protocolVersion;
    },
  };
}

/**
 * One-shot convenience: a fresh server, one line, one answer.
 *
 * Callers that need a *conversation* (an `initialize` remembered, a board
 * memoised) should hold the server from `createMcpServer` instead — this
 * constructs a new one per call.
 *
 * @param {string} raw
 * @param {{url?: string|null, token?: string|null, env?: NodeJS.ProcessEnv, server?: object}} [options]
 */
export async function handleMessage(raw, options = {}) {
  const server = options.server ?? createMcpServer(options);
  return server.handleLine(raw);
}
