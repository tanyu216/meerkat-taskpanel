/**
 * The live stream client (F4).
 *
 * A single `EventSource` on `/api/v1/events`. The frames are unnamed (the server
 * deliberately omits `event:`), so this listens on `onmessage` only, and the
 * activity's own name arrives inside the JSON. `id:` is the revision, so a
 * native reconnect already carries `Last-Event-ID` — we do not have to track the
 * header by hand; we only keep the cursor for the *manual* resync (`?after=`).
 *
 * Reconnect policy: the browser reconnects on its own (including `Last-Event-ID`)
 * and we surface `onStatus` so the top bar can show "live"/"reconnecting".
 * `resync()` is the manual escape hatch — it tears the socket down and opens a
 * fresh one with `?after=<cursor>`, replaying whatever was missed.
 *
 * Nothing here retries a *write*: conflict handling is the board store's job
 * (F4: never silently overwrite, never auto-retry with a bumped version).
 */
import { advanceCursor, eventTargets, resyncQuery } from "../lib/events.js";

/**
 * @param {{
 *   url?: string,
 *   onActivity?: (activity: object, revision: number) => void,
 *   onStatus?: (status: "connecting"|"open"|"closed") => void,
 *   EventSourceImpl?: typeof EventSource,
 * }} [options]
 */
export function createEventClient(options = {}) {
  const url = options.url ?? "/api/v1/events";
  const onActivity = options.onActivity ?? (() => {});
  const onStatus = options.onStatus ?? (() => {});
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource;

  let source = null;
  /** @type {number|null} */
  let cursor = null;

  const close = () => {
    if (source) {
      source.close();
      source = null;
      onStatus("closed");
    }
  };

  /**
   * Open the stream. `after` (a revision) is replayed by the server before it
   * goes live; omit it to start from the current revision.
   */
  const connect = (after) => {
    close();
    if (!EventSourceImpl) {
      onStatus("closed");
      return;
    }
    onStatus("connecting");
    source = new EventSourceImpl(`${url}${resyncQuery(after ?? cursor)}`);
    source.onopen = () => onStatus("open");
    source.onerror = () => onStatus("connecting"); // the browser will retry; Last-Event-ID goes with it
    source.onmessage = (event) => {
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
