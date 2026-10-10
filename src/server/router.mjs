/**
 * A very small router — `method + path` to a handler, and nothing else.
 *
 * M2 needs a local API, not a framework: `node:http` plus a segment matcher is
 * enough, keeps the runtime dependency count at zero, and makes the route table
 * readable in one screen. Two decisions worth naming:
 *
 *   * routes match **in registration order**, so a literal path
 *     (`/api/v1/projects/current`) is registered before a parameterised one
 *     (`/api/v1/projects/:id`) and wins.
 *   * a handler's return value *is* the `data` half of the envelope. Handlers do
 *     not write to the response; one place does, uniformly.
 *   * a route also carries a **declarative request schema** — `{query, body}`,
 *     the shape the contract snapshot freezes (`scripts/verify/contract.mjs`,
 *     `routes[].request`; `src/server/requests.mjs` owns the vocabulary). The
 *     router stores the declaration and does nothing else with it: it is not a
 *     validator, and handing it here changes no request's fate.
 */

import { toErrorPayload } from "../shared/errors.mjs";

/** Bodies are bounded so a runaway client cannot exhaust the service. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * A route's request part, normalised so the key is always present.
 *
 * `null` means "this route declares no schema for that part" — either it reads
 * nothing of that kind or, as with an attachment's raw bytes, the part is not
 * JSON at all. A caller can therefore ask the same question of every route
 * without a `?.`.
 *
 * @param {{query?: object|null, body?: object|null}|undefined} request
 */
function normalizeRequest(request) {
  return { query: request?.query ?? null, body: request?.body ?? null };
}

/** @returns {{add: Function, get: Function, post: Function, patch: Function, put: Function, delete: Function, match: Function, routes: object[]}} */
export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler, request) => {
    routes.push({
      method,
      pattern,
      segments: pattern.split("/").filter((segment) => segment !== ""),
      handler,
      request: normalizeRequest(request),
    });
  };

  return {
    routes,
    add,
    get: (pattern, handler, request) => add("GET", pattern, handler, request),
    post: (pattern, handler, request) => add("POST", pattern, handler, request),
    patch: (pattern, handler, request) => add("PATCH", pattern, handler, request),
    put: (pattern, handler, request) => add("PUT", pattern, handler, request),
    delete: (pattern, handler, request) => add("DELETE", pattern, handler, request),

    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {{handler: Function, params: Record<string,string>, pattern: string}|null}
     */
    match(method, pathname) {
      const parts = pathname.split("/").filter((segment) => segment !== "");
      for (const route of routes) {
        if (route.method !== method) continue;
        if (route.segments.length !== parts.length) continue;
        /** @type {Record<string,string>} */
        const params = {};
        let matched = true;
        for (let i = 0; i < parts.length; i += 1) {
          const segment = route.segments[i];
          if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(parts[i]);
          else if (segment !== parts[i]) {
            matched = false;
            break;
          }
        }
        if (matched) return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
  };
}

/**
 * Read a JSON object body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<object>}
 */
export function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (size > maxBytes) return; // already refused; stop buffering the rest
      size += chunk.length;
      if (size > maxBytes) {
        // Refuse *without* destroying the socket: the caller deserves a 413 it
        // can read, not a connection reset. The remaining bytes are dropped
        // rather than buffered, which is the part that actually matters.
        chunks.length = 0;
        reject(tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return reject(badBody(`body is not JSON: ${err.message}`));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(badBody("body must be a JSON object"));
      }
      return resolve(parsed);
    });
    req.on("error", reject);
  });
}

/**
 * Read a request body as **bytes**.
 *
 * The JSON reader is the right default, but an attachment is not JSON: its
 * content endpoint takes the raw body and must not try to parse it. Same bound,
 * same refusal shape — a body over the limit is a readable 413, never a reset.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<Buffer>}
 */
export function readRawBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (size > maxBytes) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        reject(tooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** A `VALIDATION_FAILED` carrying the status the router should answer with. */
function badBody(message) {
  return withStatus(Object.assign(new Error(message), { code: "VALIDATION_FAILED", details: {} }), 400);
}

function tooLarge(maxBytes) {
  return withStatus(
    Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), {
      code: "VALIDATION_FAILED",
      details: { maxBytes },
    }),
    413,
  );
}

/** Attach an explicit HTTP status to something error-shaped (used by `auth.mjs` too). */
export function withStatus(err, status) {
  Object.defineProperty(err, "httpStatus", { value: status, enumerable: false, writable: true });
  return err;
}

/**
 * Turn anything thrown into `{status, payload}`.
 *
 * A `DomainError` carries its own status (that is what the `http` column of
 * `ERROR_CODES` is for), and the payload is `toErrorPayload(err)` verbatim — the
 * body a client sees is the same document `--json` prints.
 *
 * @param {unknown} err
 */
export function errorResponse(err) {
  const payload = toErrorPayload(err);
  const status = Number(err?.httpStatus ?? payload.http ?? 500);
  return { status: status >= 400 && status < 600 ? status : 500, payload: { ok: false, error: payload } };
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} payload */
export function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // This is a local API for local tools; nothing should cache a board read.
    "cache-control": "no-store",
  });
  res.end(body);
}
