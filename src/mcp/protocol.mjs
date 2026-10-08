/**
 * The JSON-RPC 2.0 vocabulary, and the newline framing stdio needs.
 *
 * M3 hand-writes the MCP surface rather than importing `@modelcontextprotocol/sdk`
 * (plan F-A1): the project has zero runtime dependencies, no lockfile, and an
 * image that builds offline, and the SDK's value — prompts, resources, sampling,
 * roots, progress, subscriptions, cursor pagination, a transport matrix — is
 * value this milestone does not use.
 *
 * What replaces the SDK's guarantees is this file plus `test/mcp/protocol.test.mjs`:
 * the version set, the error codes and the framing are constants and pure
 * functions, and the test asserts their *exact* documents rather than "it
 * answered something". ~200 lines of protocol is safe while its contract is
 * pinned; it is not safe while it is only documented.
 *
 * Pure: no `node:` specifiers, no I/O, no clock.
 */

/** The only JSON-RPC version this server speaks. */
export const JSONRPC_VERSION = "2.0";

/**
 * The standard error codes (JSON-RPC 2.0 §5.1/§5.2).
 *
 * The split matters for this milestone and is the reason they are named rather
 * than inlined: `-32601`/`-32602` mean *the tool never ran*, while a tool that
 * ran and was refused comes back as a normal result with `isError: true`. Every
 * test that asserts one of these is asserting which of those two happened.
 */
export const JSONRPC_ERROR = Object.freeze({
  /** The line was not JSON. */
  PARSE: -32700,
  /** It was JSON, but not a JSON-RPC request. */
  INVALID_REQUEST: -32600,
  /** No such method (`resources/list`, a typo). */
  METHOD_NOT_FOUND: -32601,
  /** No such tool, or arguments that do not match its schema. */
  INVALID_PARAMS: -32602,
  /** A bug on this side. */
  INTERNAL: -32603,
});

/**
 * Protocol versions this server will echo back.
 *
 * The spec's rule is that a server answers with a version it can use: echoing the
 * client's is the strongest possible "yes, we can talk", and for anything else
 * the newest we know is the honest answer (a client that cannot use it is
 * entitled to disconnect).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["2024-11-05", "2025-03-26", "2025-06-18"]);

/** What we answer when the client's version is unknown or missing. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** `data.reason` on the batch refusal — this implementation has no batch support. */
export const BATCH_NOT_SUPPORTED = "batch_not_supported";

/**
 * A success envelope.
 * @param {string|number|null} id
 * @param {object} result
 */
export function response(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/**
 * A failure envelope. `data` is omitted rather than sent as `undefined`, so the
 * document a caller sees does not depend on how it was constructed.
 *
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {object} [data]
 */
export function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/** @param {object} message */
export function serialize(message) {
  return JSON.stringify(message);
}

/**
 * Which protocol version to answer with (echo if we know it, else the newest).
 * @param {unknown} requested
 */
export function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/**
 * Is this a notification? Per the spec, a request *without an `id` member* —
 * `"id" in message` is the test, not `message.id != null`, because `{id: null}`
 * is a (discouraged) request that still gets a reply.
 *
 * @param {object} message
 */
export function isNotification(message) {
  return !Object.hasOwn(message, "id");
}

/**
 * Parse one line into either a message or a ready-made error response.
 *
 * The three "not a request at all" cases are separated here, before any method
 * is looked at, because they are the only ones where the server has no id to
 * answer with and must invent `null`:
 *
 *   - unparseable → `-32700`
 *   - an array (JSON-RPC batch) → `-32600` + `batch_not_supported`; the 2025
 *     specs do not require servers to implement batching, and this one does not
 *   - any non-object (`42`, `"x"`, `null`) → `-32600`
 *
 * A *missing method* is deliberately **not** here: that shape may still carry an
 * id, and answering `null` to an identifiable request throws away the one piece
 * of information the client needs.
 *
 * @param {string} raw
 * @returns {{ok: true, message: object}|{ok: false, response: object}}
 */
export function parseLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      response: errorResponse(null, JSONRPC_ERROR.PARSE, `the line is not JSON: ${err.message}`),
    };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      response: errorResponse(null, JSONRPC_ERROR.INVALID_REQUEST, "batch requests are not supported", {
        reason: BATCH_NOT_SUPPORTED,
      }),
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      ok: false,
      response: errorResponse(null, JSONRPC_ERROR.INVALID_REQUEST, "a JSON-RPC message must be a JSON object"),
    };
  }

  return { ok: true, message: parsed };
}

/**
 * The stdio frame decoder: bytes in, complete lines out.
 *
 * stdio carries **newline-delimited JSON** — one message per line — which is
 * only workable if two things are handled, and they are handled here rather than
 * in `main.mjs` so they can be unit-tested without a process:
 *
 *   - **chunked arrival**: a line may be split across any number of `read()`
 *     results, so bytes are buffered until a `\n` shows up;
 *   - **a last line with no trailing newline**: `echo -n | node main.mjs` is a
 *     legitimate way to drive this server, and EOF must not swallow it. That is
 *     `flush()`.
 *
 * Blank lines are dropped: they are whitespace, not a request, and framing them
 * as one would answer `-32700` to a client that merely emitted a stray newline.
 *
 * @returns {{push: (chunk: string|Uint8Array) => string[], flush: () => string|null}}
 */
export function createLineFramer() {
  let buffer = "";

  return {
    /** Bytes in → every *complete* line that became available. */
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const lines = [];
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (line.trim() !== "") lines.push(line);
        at = buffer.indexOf("\n");
      }
      return lines;
    },
    /** EOF → the trailing partial line, once, or `null` when there is none. */
    flush() {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      return rest.trim() === "" ? null : rest;
    },
  };
}
