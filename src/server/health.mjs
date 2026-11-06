/**
 * The health probe behind `GET /health`.
 *
 * `/health` used to report only "this process is answering". That is true of a
 * board whose database has gone away and of a board whose event loop is blocked,
 * which is exactly when an operator needs the difference. This module measures
 * the two facts the endpoint now carries:
 *
 *   * **`db` / `lastOkAt`** — the database answers `currentRevision`, or it does
 *     not. The read is caught: `/health` reports `db: "unavailable"` instead of
 *     turning into a 500, and `revision` keeps its last known value so an SSE
 *     client can still resume.
 *   * **`eventLoopLagMs`** — how late the 1 s probe's timer fired against its
 *     schedule. A synchronous block cannot run a timer inside itself, so the
 *     block is measured when the loop frees up, and past
 *     {@link EVENT_LOOP_BLOCKED_MS} it is written as `event_loop_blocked`. The
 *     process cannot heal that state; the record is for the operator and the
 *     outside guard.
 *
 * The probe never throws and never writes to the database: a health reporter
 * that can fail the caller is worse than no reporter. `status: "ok"` on
 * `/health` keeps its old meaning (the HTTP surface is up); the new fields carry
 * the truth beside it.
 *
 * Node builtins only.
 */

import { currentRevision } from "../core/index.mjs";

/** How often the loop measures itself. */
export const HEALTH_PROBE_INTERVAL_MS = 1_000;

/** A tick later than this is a blocked loop, not scheduler jitter. */
export const EVENT_LOOP_BLOCKED_MS = 2_000;

/** A timestamp as ISO, tolerating a `Date` from an injected clock. */
function iso(ms) {
  const at = ms instanceof Date ? ms.getTime() : Number(ms);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Build the probe. `start()` arms the timer; `check()` and `tick()` are exposed
 * so the route, a test and the timer all use the one implementation.
 *
 * @param {{
 *   db: object,
 *   logger?: ((record: object) => void)|null,
 *   now?: () => number,
 *   intervalMs?: number,
 *   blockedThresholdMs?: number,
 *   setIntervalFn?: Function,
 *   clearIntervalFn?: Function,
 * }} options
 */
export function createHealthProbe(options = {}) {
  const {
    db,
    logger = null,
    now = Date.now,
    intervalMs = HEALTH_PROBE_INTERVAL_MS,
    blockedThresholdMs = EVENT_LOOP_BLOCKED_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  const state = {
    db: "unavailable",
    lastOkAt: null,
    eventLoopLagMs: 0,
    revision: null,
  };
  // The moment the next tick is due, kept in the same clock as `now()`.
  let expected = Number(now()) + intervalMs;
  let blocked = false;
  let timer = null;

  /** The snapshot the route serialises; a copy, so a caller cannot mutate it. */
  const snapshot = () => ({ ...state });

  /**
   * One database read. A failed read is a reported state, never a throw.
   *
   * @param {number} [at]
   */
  const check = (at = now()) => {
    try {
      state.revision = currentRevision(db);
      state.db = "ok";
      state.lastOkAt = iso(at);
    } catch {
      // The endpoint must still answer: `db` carries the failure and the last
      // good revision stays readable for a reconnecting SSE client.
      state.db = "unavailable";
    }
    return snapshot();
  };

  /**
   * One interval callback: measure how late it is, report a blocked episode
   * once, then check the database.
   *
   * @param {number} [at]
   */
  const tick = (at = now()) => {
    const atMs = Number(at);
    const lag = Math.max(0, atMs - expected);
    // Re-base on the real firing time: a block is reported once, not carried
    // forward as a permanent backlog on every later tick.
    expected = atMs + intervalMs;
    state.eventLoopLagMs = Math.round(lag);

    if (lag > blockedThresholdMs) {
      if (!blocked && typeof logger === "function") {
        blocked = true;
        logger({
          event: "event_loop_blocked",
          level: "error",
          lag_ms: state.eventLoopLagMs,
          threshold_ms: blockedThresholdMs,
        });
      }
    } else {
      blocked = false;
    }
    return check(atMs);
  };

  const start = () => {
    if (timer !== null) return;
    timer = setIntervalFn(() => tick(), intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  };

  const stop = () => {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  };

  // The first read happens before the daemon listens, so the first `/health`
  // answers with a real revision rather than `null`.
  check();

  return { snapshot, check, tick, start, stop, intervalMs, blockedThresholdMs };
}
