/**
 * The HTTP transport (`fetch`, which Node 22 ships — no dependency).
 *
 * Two responsibilities, and nothing else:
 *
 *   1. **carry the envelope**: send `Authorization: Bearer` when there is a
 *      token, read `{ok,data}` / `{ok,false}` back, and hand the `data` half up;
 *   2. **rebuild the domain error**: a `{ok:false,error}` body becomes a
 *      `DomainError` again, with `code`, `http`, `details` and `hint` intact, so
 *      `issue move … in_review` fails on the client with exactly the error the
 *      service raised — same code, same repair command. The transport does not
 *      reinterpret anything.
 *
 * A connection that never happens is `CLI_IO`, not a domain error, and its
 * message never contains the token (it goes through `redactText` on the way out,
 * and the token is only ever put in a header).
 *
 * Shared (extracted from `src/cli/client/http.mjs`): this is the transport seam
 * both the CLI and the MCP surface sit on, so a gate refusal reaches an MCP
 * caller as *the same* `DomainError` the CLI sees — one error mapping, not two.
 */

import { DomainError, ERROR_CODES, isDomainError } from "../errors.mjs";
import { redactText } from "../redact.mjs";

/** How long a single request may take before it is reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Whatever the server's `{ok:false,error}` said, as a throwable. */
export function domainErrorFromPayload(payload) {
  const code = typeof payload?.code === "string" ? payload.code : null;
  const message = typeof payload?.message === "string" ? payload.message : "the board refused the request";
  if (code !== null && Object.hasOwn(ERROR_CODES, code)) {
    const err = new DomainError(code, {
      message,
      details: payload.details ?? {},
      hint: payload.hint,
    });
    // The service's status is authoritative: it may narrow a code's default.
    if (Number.isInteger(payload.http)) err.http = payload.http;
    return err;
  }
  // A code this client does not know (a newer server): keep it verbatim rather
  // than flattening it to VALIDATION_FAILED — the code is the contract.
  const err = new Error(redactText(message));
  err.name = "DomainError";
  err.code = code ?? "CLI_IO";
  err.http = Number.isInteger(payload?.http) ? payload.http : 500;
  err.details = payload?.details ?? {};
  err.hint = payload?.hint ?? null;
  return err;
}

/** Build the query string, skipping empty values. */
export function withQuery(path, query) {
  if (query === undefined || query === null) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? path : `${path}${path.includes("?") ? "&" : "?"}${text}`;
}

/**
 * One request. Returns the `data` half of a success envelope.
 *
 * @param {{
 *   url: string, method?: string, path: string, body?: unknown,
 *   token?: string|null, actor?: object|null, session?: string|null, seg?: string|null,
 *   timeoutMs?: number, fetchFn?: typeof fetch,
 * }} options
 */
export async function requestJson(options) {
  const {
    url,
    method = "GET",
    path,
    body,
    token = null,
    actor = null,
    session = null,
    seg = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchFn = fetch,
  } = options;

  const headers = { accept: "application/json" };
  if (token !== null && token !== "") headers.authorization = `Bearer ${token}`;
  if (actor !== null && typeof actor === "object") headers["x-taskctl-actor"] = JSON.stringify(actor);
  if (session !== null) headers["x-taskctl-session"] = session;
  if (seg !== null) headers["x-taskctl-seg"] = seg;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response;
  try {
    response = await fetchFn(`${url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new DomainError("CLI_IO", {
        message: `the board at ${redactText(url)} did not answer within ${timeoutMs}ms`,
        details: { url: redactText(url), method, path: redactText(path), timeoutMs },
        hint: { fix: "check the board is healthy (`taskctl token rotate` prints where it lives), or pass --url" },
        cause: err,
      });
    }
    throw new DomainError("CLI_IO", {
      message: `cannot reach the board at ${redactText(url)}: ${redactText(err?.message ?? String(err))}`,
      details: { url: redactText(url), method, path: redactText(path) },
      hint: { fix: `start one with \`node src/server/main.mjs\`, or pass --url <url>` },
      cause: err,
    });
  }

  const text = await response.text();
  let envelope;
  try {
    envelope = text === "" ? null : JSON.parse(text);
  } catch {
    throw new DomainError("CLI_IO", {
      message: `the board answered with something that is not JSON (HTTP ${response.status})`,
      details: { url: redactText(url), status: response.status, body: redactText(text.slice(0, 200)) },
    });
  }

  if (envelope !== null && envelope.ok === false) throw domainErrorFromPayload(envelope.error);
  if (!response.ok) {
    throw new DomainError("CLI_IO", {
      message: `the board answered HTTP ${response.status} without an error payload`,
      details: { url: redactText(url), status: response.status },
    });
  }
  if (envelope === null || envelope.ok !== true) {
    throw new DomainError("CLI_IO", {
      message: "the board answered with an envelope this client does not understand",
      details: { url: redactText(url), keys: envelope === null ? [] : Object.keys(envelope) },
    });
  }
  return envelope.data;
}
