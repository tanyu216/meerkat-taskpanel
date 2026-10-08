/**
 * The one module in `src/mcp` that knows `src/cli` exists (plan §3.5, F-E1).
 *
 * MCP reaches the board exactly the way `taskctl` does — `ensureBoard()` to find
 * or start it, `resolveToken()` to decide what to present, `createBoardClient()`
 * to carry the envelope and rebuild `DomainError`s. Reusing those three is not a
 * convenience; it is the mechanism behind acceptance criterion #3. Calling
 * `domainErrorFromPayload` is what makes the gate refusal a caller sees through
 * MCP *the same object* as the one a caller sees through the CLI. A second,
 * copied client would be a second error mapping, and that is precisely how
 * `REPORT_REQUIRED` and its repair hint would drift apart.
 *
 * The import list is a **whitelist** (`client/index.mjs`, `runtime.mjs`,
 * `token.mjs`), fixed by `test/mcp/imports.test.mjs`. Nothing may be added here
 * without widening that test, which is the point: the edge stays narrow enough
 * to read.
 *
 * Starting `taskd` is safe for a stdio server, and for one non-obvious reason:
 * `client/autostart.mjs` redirects the daemon's stdout to `<dataDir>/logs/taskd.log`.
 * A child that inherited our stdout would corrupt the JSON-RPC stream on the
 * first line it printed.
 *
 * Lazy by design (plan G2): `initialize` and `tools/list` must work on a machine
 * where no board has ever run, because a host resolving its tool list should not
 * be able to fail on a service that is not up yet. The first `tools/call` is
 * where the board is resolved, and the result is memoised — a failure is *not*,
 * so a board started a moment later can still be reached.
 */

import { createBoardClient } from "../cli/client/index.mjs";
import { ensureBoard, readPointer } from "../cli/runtime.mjs";
import { resolveToken } from "../cli/token.mjs";
import { mcpIdentity } from "./actor.mjs";

/**
 * @param {{url?: string|null, token?: string|null, env?: NodeJS.ProcessEnv}} [options]
 */
export function createBoardSession(options = {}) {
  const { url = null, token = null, env = process.env } = options;

  /** @type {Promise<object>|null} */
  let resolved = null;
  /** The name the client sent during `initialize`, if it got that far. */
  let clientInfo = null;

  /** Remember `clientInfo` for the actor fallback (`actor.mjs`). */
  function identify(client) {
    if (client !== null && typeof client === "object" && typeof client.name === "string") {
      clientInfo = client;
    }
  }

  async function connect() {
    const pointer = readPointer({ env });
    const { token: presented } = resolveToken({ flag: token ?? undefined, env, pointer });
    const board = await ensureBoard({ url, env });
    const identity = mcpIdentity({ env, clientInfo });
    const client = createBoardClient({
      url: board.url,
      token: presented,
      actor: identity.actor,
      session: identity.session,
      seg: identity.seg,
    });
    return { ...identity, client, url: board.url, autostarted: board.autostarted };
  }

  return {
    /** Record the handshake's `clientInfo` before the first tool call. */
    identify,

    /**
     * Everything a tool handler is given: the client plus the identity headers.
     * @returns {Promise<{client: object, actor: object, session: string|null, seg: string|null, url: string}>}
     */
    async context() {
      if (resolved === null) {
        const pending = connect();
        // Publish the promise *before* awaiting it, so two concurrent tool calls
        // share one connection attempt rather than racing to start two daemons.
        resolved = pending;
        try {
          await pending;
        } catch (err) {
          resolved = null; // a board may come up later; do not cache the failure
          throw err;
        }
      }
      return resolved;
    },
  };
}
