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
 * The cursor is the activity's `revision`. `recordActivity` records the value
 * its own insert produced, so revisions are unique and strictly increasing:
 * `revision > cursor` is the whole contract, and a row written before its state
 * change (the acceptance prune) can never be skipped.
 */

import { currentRevision } from "../core/index.mjs";
import { SSE_HEARTBEAT_MS, SSE_NOISE_EVENTS, SSE_POLL_MS, SSE_REPLAY_LIMIT, SSE_RETRY_MS, SSE_SHUTDOWN_EVENT } from "../foundation/constants.mjs";
import { DomainError } from "../foundation/errors.mjs";
import { activityToWire } from "../foundation/wire.mjs";

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
 * The one frame that *is* named — the server's notice that it is ending the
 * stream on purpose (T-20261014-213238).
 *
 * A named frame is invisible to `onmessage`, which is the point: this is not an
 * activity and must never be mistaken for one. A client that wants it asks for
 * it by name; a client that does not is unaffected. It carries no `id:`, so a
 * client cannot advance its cursor past events it has not seen.
 *
 * The constant lives in `foundation/constants.mjs`; this module only formats it.
 */

/** @param {string} reason */
export function formatShutdown(reason) {
  return `event: ${SSE_SHUTDOWN_EVENT}\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/**
 * Attach an SSE stream to a live response.
 *
 * @param {{
 *   res: import('node:http').ServerResponse,
 *   board: {db: object, repos: object},
 *   after?: number|null,          // replay increments newer than this revision
 *   pollMs?: number, heartbeatMs?: number, retryMs?: number, replayLimit?: number,
 *   onClose?: () => void,         // told once, whenever the stream ends
 *   onError?: (err: unknown) => void, // a read failed; the stream is closed
 * }} input
 * @returns {{close: (reason?: string|null) => void}}
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
    onClose = null,
    onError = null,
  } = input;

  const cursor = { revision: after ?? currentRevision(board.db) };
  let closed = false;
  /** `res.write` said its buffer is full; wait for `drain` before writing more. */
  let paused = false;
  /** One drain at a time: the poll timer and the initial replay may collide. */
  let flushing = false;
  let poll = null;
  let beat = null;
  /** `res.end()` happens once, whichever path (peer, error, server stop) closes. */
  let ended = false;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Node flushes each `write` on its own; tell intermediaries not to buffer.
    "x-accel-buffering": "no",
  });
  res.write(`retry: ${retryMs}\n\n`);
  res.write(`: connected revision=${cursor.revision}\n\n`);

  /**
   * Write one frame. `false` means "not now": either the peer is gone (the
   * `closed` flag is set by a throw) or the socket buffer is full (the caller
   * pauses and resumes on `drain`).
   */
  const write = (text) => {
    if (closed) return false;
    try {
      return res.write(text) !== false;
    } catch {
      // A peer that vanished mid-write is not an error worth propagating; the
      // `close` handler tears the timers down either way.
      closed = true;
      return false;
    }
  };

  /**
   * End the stream.
   *
   * `reason` is given by a caller that is *stopping the server* rather than
   * reacting to a client: the client is then told why, with a named frame, so it
   * can tell "the daemon is going down" from "your network broke" and reconnect
   * on a different schedule (T-20261014-213238). A client-initiated end passes
   * nothing and writes nothing — the peer is already gone. A read failure is
   * also silent on the wire: a `shutdown` frame would reset the client's
   * backoff and make a broken board a hot reconnect loop.
   */
  const close = (reason = null) => {
    if (!closed && reason !== null) write(formatShutdown(reason));
    closed = true;
    // `write` may already have marked us closed (a vanished peer); the response
    // still has to be ended, or the socket is left half-open.
    if (!ended) {
      ended = true;
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    // Timers are cleared even when `write` already marked us closed (a vanished
    // peer): otherwise a dead stream would keep a poll timer alive forever.
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
    if (beat !== null) {
      clearInterval(beat);
      beat = null;
    }
    // Called even when the stream was already closed: a registry that added us
    // before the end must not be left holding a dead entry, and deleting twice
    // is free.
    if (typeof onClose === "function") onClose();
  };

  /**
   * Drain every activity newer than the cursor.
   *
   * One query shape, one contract: `revision > cursor`. Revisions are unique
   * and strictly increasing, so a page never overlaps the previous one. A full
   * page yields to the event loop before the next one — a long reconnect replay
   * must not block every other request. A page that makes no cursor progress is
   * malformed (or a raw row with a NULL revision); stop rather than spin.
   */
  const flush = async () => {
    if (closed || paused || flushing) return;
    flushing = true;
    try {
      for (;;) {
        if (closed || paused) break;
        const before = cursor.revision;
        const rows = board.repos.activities.list({
          afterRevision: cursor.revision,
          limit: replayLimit,
          order: "revision",
        });
        if (rows.length === 0) break;

        for (const activity of rows) {
          if (closed) break;
          const revision = Number(activity.revision);
          if (!Number.isFinite(revision) || revision <= cursor.revision) continue;
          const noise = isNoiseActivity(activity);
          const ok = noise ? true : write(formatEvent(activity));
          cursor.revision = revision;
          if (!ok) {
            // A throw already set `closed`; only a full buffer is resumable.
            if (closed) close();
            else paused = true;
            break;
          }
        }

        if (closed || paused) break;
        if (rows.length < replayLimit) break;
        if (cursor.revision === before) break; // no progress: do not spin
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (err) {
      if (typeof onError === "function") onError(err);
      close();
    } finally {
      flushing = false;
    }
  };

  // Timers first, so a failure in the initial replay's `close()` can clear
  // them; listeners before any async work, so a hang-up or a full socket during
  // that replay is seen rather than missed.
  poll = setInterval(() => void flush(), pollMs);
  beat = setInterval(() => {
    if (!paused) write(`: ping ${Date.now()}\n\n`);
  }, heartbeatMs);
  if (typeof poll.unref === "function") poll.unref();
  if (typeof beat.unref === "function") beat.unref();

  res.on("drain", () => {
    if (closed) return;
    paused = false;
    void flush();
  });
  // `res`, not `req`: the response is what stays open for the life of the
  // stream, and it emits `close` on a client abort on every supported Node.
  // (An `IncomingMessage` 'close' can fire as soon as the request is fully
  // consumed, which for a bodyless GET is immediately.)
  res.on("close", () => close());
  res.on("error", () => close());

  // A client that quoted a revision gets the missed increments *before* the
  // stream goes live, so a reconnect never has a gap it must close itself.
  if (after !== null) void flush();

  return { close };
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
