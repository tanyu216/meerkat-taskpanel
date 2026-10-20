/**
 * A zero-dependency SSE client: reads `text/event-stream` from a `fetch` body
 * and feeds the parser in `sse-parse.mjs`.
 *
 * The read-idle timer aborts a stream silent for longer than three heartbeats;
 * the backoff ladder is the caller's decision between connections.
 */

import { SUBSCRIBE_BACKOFF_MAX_MS } from "../../src/foundation/constants.mjs";
import { createSseParser } from "./sse-parse.mjs";

/** The reconnect ladder: 1 s, 2 s, 4 s … capped at 30 s. */
export function nextBackoff(current) {
  const next = current <= 0 ? 1000 : current * 2;
  return Math.min(next, SUBSCRIBE_BACKOFF_MAX_MS);
}

/**
 * Connect once and pump frames until the stream ends.
 *
 * @param {{
 *   url: string,
 *   token?: string|null,
 *   after?: number|null,
 *   idleMs?: number,
 *   signal?: AbortSignal,
 *   fetchFn?: typeof fetch,
 *   onOpen?: () => void,
 *   onFrame?: (frame: {id: string|null, event: string, data: string}) => void,
 * }} input
 * @returns {Promise<{reason: "eof"|"idle"|"aborted"|"shutdown"|"error", error?: Error, data?: object}>}
 */
export async function connectSse(input) {
  const {
    url,
    token = null,
    after = null,
    idleMs = 45_000,
    signal = null,
    fetchFn = fetch,
    onOpen = null,
    onFrame = null,
  } = input;

  const params = new URLSearchParams();
  if (after !== null && after !== undefined) params.set("after", String(after));
  if (typeof token === "string" && token !== "") params.set("token", token);
  const query = params.toString();
  const href = `${url.replace(/\/+$/, "")}/api/v1/events${query === "" ? "" : `?${query}`}`;

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) return { reason: "aborted" };
  signal?.addEventListener("abort", abort, { once: true });

  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  try {
    const response = await fetchFn(href, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`the board answered HTTP ${response.status} for the event stream`);
    }
    onOpen?.();
    armIdle();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { reason: "eof" };
      armIdle();
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (frame.event === "shutdown") {
          let data = null;
          try {
            data = JSON.parse(frame.data);
          } catch {
            /* a malformed shutdown frame still means the server is going away */
          }
          return { reason: "shutdown", data };
        }
        onFrame?.(frame);
      }
    }
  } catch (err) {
    if (signal?.aborted) return { reason: "aborted" };
    if (controller.signal.aborted) return { reason: "idle" };
    return { reason: "error", error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", abort);
  }
}
