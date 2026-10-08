/**
 * Task Panel MCP server — the library entry (M3).
 *
 * A stdio MCP server that exposes the board's tool surface to an agent host.
 * It is a **thin proxy**: arguments are projected onto the taskd HTTP surface,
 * and the answer — including every refusal — is the service's own, serialised
 * into a tool result. There is no policy in this directory. In particular there
 * is no delivery-gate logic: moving a card to `in_review` without a current-round
 * report fails here for exactly the reason, with exactly the message and exactly
 * the repair hint, that `taskctl issue move` fails.
 *
 * The executable a host configures is `main.mjs` (`node src/mcp/main.mjs`); this
 * module is the importable surface, for tests and for anything that wants to
 * drive the server in-process.
 *
 * See `src/mcp/README.md` for what `src/mcp` owns and what it deliberately does
 * not.
 */

/** Which milestone this tree is at — mirrors `src/core`'s `STAGE`. */
export const STAGE = "mcp";

export { createMcpServer, handleMessage } from "./server.mjs";
export { TOOLS, TOOL_NAMES, findTool, publicTool, toolsList, validateInput } from "./registry.mjs";
export {
  BATCH_NOT_SUPPORTED,
  JSONRPC_ERROR,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  createLineFramer,
  negotiateProtocolVersion,
  parseLine,
} from "./protocol.mjs";
export { createBoardSession } from "./board.mjs";
export { MCP_ACTOR_KIND, MCP_DEFAULT_ACTOR_ID, mcpIdentity } from "./actor.mjs";
export { errorPayloadOf, failed, invalidParams, ok } from "./result.mjs";
