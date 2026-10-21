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
 * Shared (extracted from `src/cli/client/http.mjs`): the transport seam to
 * `taskd`, so a gate refusal reaches the caller as *the same* `DomainError` the
 * domain raised — one error mapping, not two.
 */

import { DomainError, ERROR_CODES } from "../errors.mjs";
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

/**
 * The request headers every call shares.
 *
 * One construction for JSON and streaming calls, so a stream can never lose the
 * token, the actor or the session that a JSON request carries.
 */
export function buildHeaders({
  token = null,
  actor = null,
  session = null,
  seg = null,
  accept = "application/json",
  contentType = null,
} = {}) {
  const headers = { accept };
  if (token !== null && token !== "") headers.authorization = `Bearer ${token}`;
  if (actor !== null && typeof actor === "object") headers["x-taskctl-actor"] = JSON.stringify(actor);
  if (session !== null) headers["x-taskctl-session"] = session;
  if (seg !== null) headers["x-taskctl-seg"] = seg;
  if (contentType !== null) headers["content-type"] = contentType;
  return headers;
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
 * `rawBody` is the one non-JSON shape the board has: an attachment's bytes
 * (`PUT /api/v1/attachments/:id/content`, §5.1). It is a `Uint8Array` sent
 * verbatim, and it is **exclusive** with `body` — a request that carried both
 * would have to guess which one the server reads. The response is still the
 * usual JSON envelope, because that endpoint answers JSON even though it takes
 * bytes.
 *
 * @param {{
 *   url: string, method?: string, path: string, body?: unknown,
 *   rawBody?: Uint8Array|null, contentType?: string|null,
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
    rawBody = null,
    contentType = null,
    token = null,
    actor = null,
    session = null,
    seg = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    fetchFn = fetch,
  } = options;

  if (rawBody !== null && body !== undefined) {
    throw new DomainError("CLI_IO", {
      message: "a request cannot carry a JSON body and raw bytes at once",
      details: { path: redactText(path) },
    });
  }

  const requestContentType =
    rawBody !== null
      ? contentType ?? "application/octet-stream"
      : body !== undefined
        ? "application/json"
        : null;
  const headers = buildHeaders({ token, actor, session, seg, contentType: requestContentType });

  const payload = rawBody !== null ? rawBody : body === undefined ? undefined : JSON.stringify(body);

  let response;
  try {
    response = await fetchFn(`${url}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
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

/** A caller abort, distinguishable from an idle timeout and a board error. */
function streamAbortedError() {
  return new DomainError("CLI_IO", {
    message: "the event stream was aborted by the caller",
    details: { reason: "aborted" },
  });
}

/** An idle timeout: no bytes for longer than the caller allowed. */
function streamIdleError(idleMs) {
  return new DomainError("CLI_IO", {
    message: `the event stream was silent for ${idleMs}ms`,
    details: { reason: "idle", idle_ms: idleMs },
  });
}

/**
 * Open a streaming response (`text/event-stream`) and yield decoded chunks.
 *
 * The distinction from `requestJson` is deliberate:
 *
 *   * only the **response-header** wait is bounded (`responseTimeoutMs`); the
 *     body itself has no overall deadline, because a live stream never ends;
 *   * an optional **idle** timer aborts a body that has gone silent (`idleMs`,
 *     0 disables it);
 *   * the caller's `signal` aborts both phases.
 *
 * The failure modes are tagged in `details.reason` (`aborted`, `idle`, `stream`)
 * so the CLI can turn them into the right terminal NDJSON line and exit code. A
 * non-2xx response that carries the usual `{ok:false,error}` envelope is rebuilt
 * as the same `DomainError` `requestJson` would raise.
 *
 * @param {{
 *   url: string, path: string,
 *   token?: string|null, actor?: object|null, session?: string|null, seg?: string|null,
 *   idleMs?: number, responseTimeoutMs?: number, signal?: AbortSignal|null,
 *   fetchFn?: typeof fetch,
 * }} options
 * @returns {Promise<AsyncGenerator<string, void, unknown>>}
 */
export async function requestStream(options) {
  const {
    url,
    path,
    token = null,
    actor = null,
    session = null,
    seg = null,
    idleMs = 0,
    responseTimeoutMs = REQUEST_TIMEOUT_MS,
    signal = null,
    fetchFn = fetch,
  } = options;

  if (signal?.aborted) throw streamAbortedError();

  const controller = new AbortController();
  let abortedByCaller = false;
  const onAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const headerTimer = setTimeout(() => controller.abort(), Math.max(1, responseTimeoutMs));
  if (typeof headerTimer.unref === "function") headerTimer.unref();

  let response;
  try {
    response = await fetchFn(`${url}${path}`, {
      headers: buildHeaders({ token, actor, session, seg, accept: "text/event-stream" }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(headerTimer);
    signal?.removeEventListener("abort", onAbort);
    if (abortedByCaller) throw streamAbortedError();
    if (controller.signal.aborted) {
      throw new DomainError("CLI_IO", {
        message: `the board at ${redactText(url)} did not answer within ${responseTimeoutMs}ms`,
        details: { url: redactText(url), path: redactText(path), reason: "timeout" },
        hint: { fix: "check the board is healthy, or pass --url" },
        cause: err,
      });
    }
    throw new DomainError("CLI_IO", {
      message: `cannot reach the board at ${redactText(url)}: ${redactText(err?.message ?? String(err))}`,
      details: { url: redactText(url), path: redactText(path), reason: "unreachable" },
      hint: { fix: "start one with `node src/server/main.mjs`, or pass --url <url>" },
      cause: err,
    });
  }
  clearTimeout(headerTimer);

  if (!response.ok || response.body === null) {
    signal?.removeEventListener("abort", onAbort);
    let text = "";
    try {
      text = await response.text();
    } catch {
      // The status is enough to report; the body was unreadable.
    }
    let envelope = null;
    try {
      envelope = text === "" ? null : JSON.parse(text);
    } catch {
      // Not the JSON envelope — report the status and a redacted slice.
    }
    if (envelope !== null && envelope.ok === false) throw domainErrorFromPayload(envelope.error);
    throw new DomainError("CLI_IO", {
      message: `the board answered HTTP ${response.status} for the event stream`,
      details: {
        url: redactText(url),
        path: redactText(path),
        status: response.status,
        reason: "http",
        body: redactText(text.slice(0, 200)),
      },
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    signal?.removeEventListener("abort", onAbort);
    throw new DomainError("CLI_IO", {
      message: `the board answered ${contentType || "an unknown content type"} for the event stream`,
      details: { url: redactText(url), path: redactText(path), reason: "content-type" },
    });
  }

  async function* chunks() {
    let idleTimer = null;
    let idleFired = false;
    const arm = () => {
      if (idleMs <= 0) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        controller.abort();
      }, idleMs);
      if (typeof idleTimer.unref === "function") idleTimer.unref();
    };

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      arm();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        arm();
        yield decoder.decode(value, { stream: true });
      }
    } catch (err) {
      if (abortedByCaller) throw streamAbortedError();
      if (idleFired) throw streamIdleError(idleMs);
      throw new DomainError("CLI_IO", {
        message: `the event stream failed: ${redactText(err?.message ?? String(err))}`,
        details: { url: redactText(url), path: redactText(path), reason: "stream" },
        cause: err,
      });
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return chunks();
}
