/**
 * The live stream client (F4).
 *
 * A single `EventSource` on `/api/v1/events`. The activity frames are unnamed
 * (the server deliberately omits `event:`), so this listens on `onmessage` only,
 * and the activity's own name arrives inside the JSON. `id:` is the revision, so
 * a reconnect can resume from `?after=<cursor>`; we keep the cursor ourselves,
 * which is what the *manual* resync (`resync()`) uses.
 *
 * **Reconnect policy (T-20261014-213238).** The client owns the reconnect, and
 * the ladder is `lib/events.js#backoffDelay`: 1 s, 2 s, 4 s … held at 30 s. Three
 * rules make that defined rather than incidental:
 *
 *   1. a dropped socket is **closed by us** before we re-open it, so the
 *      browser's own retry — a fixed interval that repeats forever — never runs;
 *   2. the ladder **resets on `open`**, so a blip costs one second, not the
 *      delay the previous outage climbed to;
 *   3. when the server announces its own stop (`SHUTDOWN_EVENT`, sent as it ends
 *      the stream deliberately) the ladder starts over too: `taskd` said
 *      "restarting", not "your network broke".
 *
 * Status stays inside the frozen three-value vocabulary of `data-connection`
 * (`blocks.contract.mjs#CONNECTION`): `connecting` while a socket is being
 * opened *or* a reconnect is waiting out its delay, `open` while frames can
 * arrive, `closed` once nothing will reconnect on its own.
 *
 * Nothing here retries a *write*: conflict handling is the board store's job
 * (F4: never silently overwrite, never auto-retry with a bumped version).
 */
import { SHUTDOWN_EVENT, advanceCursor, backoffDelay, eventTargets, resyncQuery } from "../lib/events.js";

/**
 * @param {{
 *   url?: string,
 *   onActivity?: (activity: object, revision: number) => void,
 *   onStatus?: (status: "connecting"|"open"|"closed") => void,
 *   EventSourceImpl?: typeof EventSource,
 *   retryBaseMs?: number, retryMaxMs?: number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   cancel?: (timer: unknown) => void,
 * }} [options]
 */
export function createEventClient(options = {}) {
  const url = options.url ?? "/api/v1/events";
  const onActivity = options.onActivity ?? (() => {});
  const onStatus = options.onStatus ?? (() => {});
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;
  const retryBaseMs = options.retryBaseMs;
  const retryMaxMs = options.retryMaxMs;
  // The clock is the external boundary here, exactly as `EventSource` is: a test
  // can drive the ladder without sleeping through it. The default `unref`s where
  // it can, so a scheduled retry never holds a Node process open.
  const schedule = options.schedule ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer?.unref?.();
    return timer;
  });
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));

  /** @type {{close: () => void}|null} */
  let source = null;
  /** @type {number|null} */
  let cursor = null;
  /** Consecutive failed attempts since the last `open` — the ladder's input. */
  let attempt = 0;
  /** The pending reconnect, if one is waiting out its delay. */
  let timer = null;
  /** True once nothing is meant to reconnect until the next `connect`. */
  let stopped = true;
  /** The last status reported, so `onStatus` receives transitions, not repeats. */
  let status = null;

  /**
   * `connecting` covers two different situations — opening a socket and waiting
   * out a reconnect delay — so the reconnect path would otherwise report it
   * twice for one outage. Only changes are reported.
   */
  const report = (next) => {
    if (next === status) return;
    status = next;
    onStatus(next);
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  /** Let the current socket go without declaring the stream closed. */
  const drop = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  /** Wait out the ladder, then try again from the cursor. */
  const arm = (after) => {
    if (stopped) return;
    const waitMs = backoffDelay(attempt, retryBaseMs, retryMaxMs);
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      open(after);
    }, waitMs);
  };

  /**
   * Open a socket. `after` (a revision) is replayed by the server before it goes
   * live; omit it to start from the current cursor.
   */
  const open = (after) => {
    if (stopped) return;
    clearTimer();
    drop();
    if (!EventSourceImpl) {
      stopped = true;
      report("closed");
      return;
    }
    report("connecting");
    const socket = new EventSourceImpl(`${url}${resyncQuery(after ?? cursor)}`);
    source = socket;
    /** A socket we have already replaced must never steer the ladder. */
    const current = () => socket === source;

    socket.onopen = () => {
      if (!current()) return;
      attempt = 0;
      report("open");
    };
    socket.onerror = () => {
      if (!current()) return;
      drop();
      report("connecting");
      arm(cursor);
    };
    socket.addEventListener?.(SHUTDOWN_EVENT, () => {
      if (!current()) return;
      // Deliberate, so this is not a failure: start the ladder over.
      attempt = 0;
      drop();
      report("connecting");
      arm(cursor);
    });
    socket.onmessage = (event) => {
      cursor = advanceCursor(cursor, event.lastEventId);
      let activity = null;
      try {
        activity = JSON.parse(event.data);
      } catch {
        activity = null;
      }
      const revision = Number(event.lastEventId);
      onActivity(activity, Number.isFinite(revision) ? revision : cursor);
      return eventTargets(activity); // exposed for tests via the pure module, computed here for convenience
    };
  };

  const connect = (after) => {
    // `close()` stops any pending reconnect and reports `closed` for a socket
    // that was live; a connect is then the intent to run again.
    close();
    stopped = false;
    attempt = 0;
    open(after);
  };

  const close = () => {
    // `source` may already be gone — a drop leaves the client *waiting*, which
    // is still "connecting" to everyone watching. Closing while a retry is armed
    // therefore has to report `closed` too, or the top bar keeps promising a
    // reconnect that will never come.
    const wasLive = !stopped || source !== null;
    stopped = true;
    clearTimer();
    drop();
    if (wasLive) report("closed");
  };

  return {
    connect,
    close,
    /** Manual resync: reconnect from the current cursor so missed frames replay. */
    resync() {
      connect(cursor);
    },
    get cursor() {
      return cursor;
    },
    /** Seed the cursor (e.g. from `/meta.revision` before the first connect). */
    seed(revision) {
      cursor = advanceCursor(cursor, revision);
    },
  };
}
