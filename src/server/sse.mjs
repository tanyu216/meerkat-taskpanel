/**
 * `GET /api/v1/events` — the board's live stream (ARCHITECTURE §4.3 / §5.4).
 *
 * The whole design rests on one column. Every write already bumps
 * `global_revision` (a trigger, §4.2) and writes a `task_activities` row tagged
 * with the revision it produced, so "what changed since I last looked" is a
 * range query, not an event bus. The stream is therefore a **cursor over
 * `task_activities`**, and it needs no cooperation from the write paths: a
 * mutation made in-process (the label GC, a test fixture) is streamed exactly
 * like one made over HTTP.
 *
 * Three behaviours the card names, and how each falls out of that:
 *
 *   * **increments** — poll for rows newer than the cursor and push each one;
 *   * **reconnect with `?after=<rev>`** — replay the missed rows before
 *     streaming (also honours the standard `Last-Event-ID` header, which is what
 *     a browser's `EventSource` resends by itself);
 *   * **heartbeat keep-alive** — a `: ping` comment on a timer, *and* the
 *     mirrored rule that a `task_heartbeat` activity is **noise**: it is
 *     filtered out of the stream because it changes nothing a board renders
 *     (§4.3: "排除纯心跳").
 *
 * The cursor is `(revision, id)`. `revision` is what a client quotes back in
 * `?after=`; `id` is monotonic and gap-free, which is what the *server* advances
 * by while it is connected — an increment that shares a revision with one
 * already sent can never be skipped.
 */

import { currentRevision } from "../core/index.mjs";
import { SSE_HEARTBEAT_MS, SSE_NOISE_EVENTS, SSE_POLL_MS, SSE_REPLAY_LIMIT, SSE_RETRY_MS } from "../shared/constants.mjs";
import { DomainError } from "../shared/errors.mjs";
import { activityToWire } from "../shared/wire.mjs";

/** Activity events that are pure noise on the wire (§4.3). */
export function isNoiseActivity(activity) {
  return SSE_NOISE_EVENTS.includes(activity?.event);
}

/**
 * One SSE frame.
 *
 * The event is **unnamed** on purpose: an `event:` field would make the browser
 * deliver it only to `addEventListener("<name>")`, and the common board client
 * is an `onmessage` handler. The activity's own name travels inside the JSON,
 * and `id:` is set so a native `EventSource` reconnects with `Last-Event-ID`.
 *
 * @param {object} activity a core Activity DTO
 */
export function formatEvent(activity) {
  return `id: ${activity.revision}\ndata: ${JSON.stringify(activityToWire(activity))}\n\n`;
}

/**
 * Attach an SSE stream to a live response.
 *
 * @param {{
 *   res: import('node:http').ServerResponse,
 *   board: {db: object, repos: object},
 *   after?: number|null,          // replay increments newer than this revision
 *   pollMs?: number, heartbeatMs?: number, retryMs?: number, replayLimit?: number,
 * }} input
 * @returns {{cursor: {revision: number, id: number}, flush: () => number, close: () => void}}
 */
export function openEventStream(input) {
  const {
    res,
    board,
    after = null,
    pollMs = SSE_POLL_MS,
    heartbeatMs = SSE_HEARTBEAT_MS,
    retryMs = SSE_RETRY_MS,
    replayLimit = SSE_REPLAY_LIMIT,
  } = input;

  const cursor = { revision: after ?? currentRevision(board.db), id: 0 };
  let closed = false;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Node flushes each `write` on its own; tell intermediaries not to buffer.
    "x-accel-buffering": "no",
  });
  res.write(`retry: ${retryMs}\n\n`);
  res.write(`: connected revision=${cursor.revision}\n\n`);

  const write = (text) => {
    if (closed) return false;
    try {
      res.write(text);
      return true;
    } catch {
      // A peer that vanished mid-write is not an error worth propagating; the
      // `close` handler tears the timers down either way.
      closed = true;
      return false;
    }
  };

  /**
   * Drain every activity newer than the cursor.
   *
   * Two queries, one contract: the first pass after a reconnect filters by
   * *revision* (what the client quoted), every pass after by *id* (the
   * gap-free number the server owns). Because revision is non-decreasing in id,
   * the second pass picks up exactly where the first left off.
   *
   * @returns {number} how many activity rows were consumed (including noise)
   */
  const flush = () => {
    let consumed = 0;
    for (;;) {
      const filter = consumed === 0 && cursor.id === 0
        ? { afterRevision: cursor.revision, limit: replayLimit }
        : { afterId: cursor.id, limit: replayLimit };
      const rows = board.repos.activities.list(filter);
      if (rows.length === 0) break;
      for (const activity of rows) {
        if (activity.id > cursor.id) cursor.id = activity.id;
        if (activity.revision > cursor.revision) cursor.revision = activity.revision;
        if (!isNoiseActivity(activity)) write(formatEvent(activity));
      }
      consumed += rows.length;
      if (rows.length < replayLimit) break;
    }
    return consumed;
  };

  // A client that quoted a revision gets the missed increments *before* the
  // stream goes live, so a reconnect never has a gap it must close itself.
  if (after !== null) flush();

  const poll = setInterval(flush, pollMs);
  const beat = setInterval(() => write(`: ping ${Date.now()}\n\n`), heartbeatMs);
  if (typeof poll.unref === "function") poll.unref();
  if (typeof beat.unref === "function") beat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    try {
      res.end();
    } catch {
      /* already gone */
    }
  };
  // `res`, not `req`: the response is what stays open for the life of the
  // stream, and it emits `close` on a client abort on every supported Node.
  // (An `IncomingMessage` 'close' can fire as soon as the request is fully
  // consumed, which for a bodyless GET is immediately.)
  res.on("close", close);
  res.on("error", close);

  return { cursor, flush, close };
}

/**
 * Read `?after=` / `Last-Event-ID` into a revision, or explain why not.
 *
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|null}
 */
export function revisionFromRequest(url, req) {
  const query = url.searchParams.get("after");
  const header = req.headers["last-event-id"];
  const raw = query !== null ? query : typeof header === "string" ? header : null;
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    // A `DomainError` rather than a bare one: the details reach the client
    // verbatim, which is the whole point of naming the offending field.
    throw new DomainError("VALIDATION_FAILED", {
      message: `after must be a non-negative integer revision, got ${JSON.stringify(raw)}`,
      details: { field: "after", received: raw },
      hint: { fix: "reconnect with ?after=<revision> from a previous event's id" },
    });
  }
  return Number.parseInt(raw, 10);
}
