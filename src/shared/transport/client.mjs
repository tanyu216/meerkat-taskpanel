/**
 * The board client — the transport seam.
 *
 * Commands are written against *this* interface and never against `fetch`, which
 * is what makes the choice of transport a one-file decision. M2 ships the HTTP
 * adapter (`http.mjs`); a future in-process adapter would slot in here without
 * touching a single command.
 *
 * Every call carries the same three pieces of context, so no command has to
 * remember them: the token (if any), the actor, and the agent session/segment.
 *
 * Shared (extracted from `src/cli/client/index.mjs`) so the CLI and the MCP
 * surface build the same client over the same seam.
 */

import { requestJson, withQuery } from "./http.mjs";

/**
 * @param {{
 *   url: string,
 *   token?: string|null,
 *   actor?: {kind: string, id: string}|null,
 *   session?: string|null,
 *   seg?: string|null,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 * }} options
 */
export function createBoardClient(options) {
  const {
    url,
    token = null,
    actor = null,
    session = null,
    seg = null,
    fetchFn,
    timeoutMs,
  } = options;

  /**
   * @param {string} method
   * @param {string} path
   * @param {{body?: unknown, query?: object}} [extra]
   */
  async function call(method, path, extra = {}) {
    const { body, query } = extra;
    return requestJson({
      url,
      method,
      path: withQuery(path, query),
      ...(body === undefined ? {} : { body }),
      token,
      actor,
      session,
      seg,
      ...(fetchFn === undefined ? {} : { fetchFn }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  return {
    url,
    token,
    actor,
    get: (path, extra) => call("GET", path, extra),
    post: (path, body, extra = {}) => call("POST", path, { ...extra, body }),
    patch: (path, body, extra = {}) => call("PATCH", path, { ...extra, body }),
    put: (path, body, extra = {}) => call("PUT", path, { ...extra, body }),
    delete: (path, extra) => call("DELETE", path, extra),
    /** Escape hatch for the rare call that is not CRUD-shaped. */
    call,
  };
}
