/**
 * The hub's only board connection.
 *
 * `GET /api/v1/events` is a 500 ms poll of the append-only activity table, so
 * every extra consumer is another poller. The hub owns exactly one connection
 * per board and fans its events out locally. It reconnects with the loop's
 * ladder (1 s doubling to 30 s), resuming from the last revision it saw.
 *
 * A small ring of recent events lets a local consumer that reconnects replay the
 * gap instead of losing it. The ring is bounded; a consumer whose cursor is
 * older than the oldest retained event starts live (the loop's own rescan is the
 * fallback for that case).
 */

import {
  SSE_SHUTDOWN_EVENT,
  SSE_SUBSCRIBE_IDLE_MS,
} from "../../foundation/constants.mjs";
import { createSseParser } from "../../foundation/sse-parse.mjs";

/** How many recent event frames the hub can replay to a reconnecting consumer. */
export const HUB_RING_SIZE = 4_096;

/** The reconnect ladder, matching the loop's subscriber. */
export const HUB_RETRY_MIN_MS = 1_000;
export const HUB_RETRY_MAX_MS = 30_000;

function sleep(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * @param {{
 *   client: {stream: Function},
 *   onEvent: (event: {id: number|null, data: object}) => void,
 *   onState?: (state: {state: string, error?: unknown}) => void,
 *   log?: (line: string) => void,
 *   idleMs?: number,
 *   ringSize?: number,
 *   retryMinMs?: number,
 *   retryMaxMs?: number,
 * }} input
 */
export function createBoardStream(input) {
  const {
    client,
    onEvent,
    onState = () => {},
    log = () => {},
    idleMs = SSE_SUBSCRIBE_IDLE_MS,
    ringSize = HUB_RING_SIZE,
    retryMinMs = HUB_RETRY_MIN_MS,
    retryMaxMs = HUB_RETRY_MAX_MS,
  } = input;

  /** @type {Array<{id: number|null, data: object}>} */
  const ring = [];
  let revision = null;
  let stopped = false;
  let loop = null;
  let controller = null;
  let backoff = retryMinMs;

  const remember = (event) => {
    ring.push(event);
    if (ring.length > ringSize) ring.shift();
  };

  /**
   * Events newer than `after`, or `{gap:true}` when the cursor fell out of the
   * ring. A null/absent cursor is a live subscription, not a replay request.
   *
   * @param {unknown} after
   */
  const since = (after) => {
    if (!Number.isInteger(after)) return { gap: false, events: [] };
    if (ring.length === 0) return { gap: false, events: [] };
    const oldest = ring[0].id;
    if (Number.isInteger(oldest) && after < oldest - 1) return { gap: true, events: [] };
    return {
      gap: false,
      events: ring.filter((event) => Number.isInteger(event.id) && event.id > after),
    };
  };

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      try {
        const stream = await client.stream("/api/v1/events", {
          query: { after: revision },
          idleMs,
          signal: controller.signal,
        });
        backoff = retryMinMs;
        onState({ state: "open" });
        const parser = createSseParser();
        let ended = false;
        for await (const chunk of stream) {
          for (const frame of parser.push(chunk)) {
            if (frame.event === SSE_SHUTDOWN_EVENT) {
              ended = true;
              break;
            }
            let data;
            try {
              data = JSON.parse(frame.data);
            } catch {
              continue; // a frame that is not JSON cannot name a board event
            }
            const parsedId = frame.id === null ? null : Number.parseInt(frame.id, 10);
            const id = Number.isFinite(parsedId)
              ? parsedId
              : (Number.isInteger(data?.revision) ? data.revision : revision);
            if (Number.isInteger(id)) revision = id;
            const event = { id, data };
            remember(event);
            try {
              onEvent(event);
            } catch (err) {
              log(`hub: event handler failed: ${err?.message ?? err}`);
            }
          }
          if (ended || stopped) break;
        }
        if (!stopped) onState({ state: "closed" });
      } catch (err) {
        if (stopped) break;
        onState({ state: "error", error: err });
        log(`hub: event stream failed: ${err?.message ?? err}`);
      }
      if (stopped) break;
      await sleep(backoff);
      backoff = Math.min(retryMaxMs, backoff * 2);
    }
  }

  return {
    /** Start the single reconnect loop (idempotent). */
    start() {
      if (loop === null) loop = run();
      return loop;
    },
    /** Stop the stream and wait for the loop to settle. */
    async stop() {
      stopped = true;
      try {
        controller?.abort();
      } catch {
        /* already gone */
      }
      await loop?.catch(() => {});
    },
    since,
    get revision() {
      return revision;
    },
    get retained() {
      return ring.length;
    },
  };
}
