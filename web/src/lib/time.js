/**
 * The two timestamp views the board renders, in one place.
 *
 * The drawer's activity list (`lib/activity.js`) and the activity feed
 * (`lib/activity-feed.js`) each grew their own copy: a byte-identical
 * `absoluteStamp` and two versions of the same "how long ago" ladder. They
 * differ in exactly one thing — the feed has a minutes rung and the drawer
 * starts at hours — so the rung is an argument, not a second implementation.
 *
 * Both callers keep their own exported names (a delegating wrapper) so nothing
 * that imports `feedTime`/`relativeTime`/`absoluteStamp` has to move.
 *
 * Everything here is a *view*: the record carries an ISO stamp, and the reading
 * of it is local time by design.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The feed's ladder: minutes → hours → days. */
export const TIME_RUNGS_THREE = Object.freeze([
  Object.freeze({ under: HOUR, key: "time.minutesAgo", unit: MINUTE }),
  Object.freeze({ under: DAY, key: "time.hoursAgo", unit: HOUR }),
  Object.freeze({ under: Infinity, key: "time.daysAgo", unit: DAY }),
]);

/** The drawer's ladder: hours → days (no minutes rung). */
export const TIME_RUNGS_TWO = Object.freeze([
  Object.freeze({ under: DAY, key: "time.hoursAgo", unit: HOUR }),
  Object.freeze({ under: Infinity, key: "time.daysAgo", unit: DAY }),
]);

const pad = (n) => String(n).padStart(2, "0");

/**
 * `2026-10-05 11:20` — the prototype's absolute stamp, read in local time.
 *
 * @param {string|Date} value
 * @returns {string} `""` when the value will not parse
 */
export function absoluteStamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The row's visible time on the given ladder, as `{key, arg, absolute}`.
 *
 * A stamp in the future (a clock that disagrees with the server's) reads as the
 * freshest rung rather than as a negative number, and anything unparseable
 * returns `null` so the caller drops the node instead of printing `NaN`.
 *
 * @param {string|Date|null} value
 * @param {number} [now] epoch ms — injected by the tests, never by the app
 * @param {{under: number, key: string, unit: number}[]} [rungs]
 * @returns {{key: string, arg: number, absolute: string}|null}
 */
export function timeLadder(value, now = Date.now(), rungs = TIME_RUNGS_THREE) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  const then = date.getTime();
  if (!Number.isFinite(then)) return null;
  const delta = Math.max(0, now - then);
  const rung = rungs.find((entry) => delta < entry.under) ?? rungs[rungs.length - 1];
  return {
    key: rung.key,
    arg: Math.max(1, Math.round(delta / rung.unit)),
    absolute: absoluteStamp(date),
  };
}
