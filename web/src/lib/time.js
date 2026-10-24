/**
 * The two timestamp views the board renders, in one place.
 *
 * The drawer's activity list (`lib/activity.js`) and the activity feed
 * (`lib/activity-feed.js`) each grew their own copy: a byte-identical
 * `absoluteStamp` and two versions of the same "how long ago" ladder. They
 * differ only in their rungs — the feed starts at minutes, the drawer at "just
 * now" — so the rung is an argument, not a second implementation.
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

/**
 * The drawer's ladder: just now → minutes → hours → days.
 *
 * The bounds are strict, so exactly one minute reads as `1m` (never "just now")
 * and exactly an hour reads as `1h`. The two long rungs are the prototype's own
 * catalogue strings; `time.minutesAgo` is the feed's string, reused; and
 * `time.justNow` lives in the extra table, because the prototype's only "just
 * now" is the comment-scoped `comment.now` its demo composer writes.
 */
export const TIME_RUNGS_DRAWER = Object.freeze([
  Object.freeze({ under: MINUTE, key: "time.justNow", unit: MINUTE }),
  Object.freeze({ under: HOUR, key: "time.minutesAgo", unit: MINUTE }),
  Object.freeze({ under: DAY, key: "time.hoursAgo", unit: HOUR }),
  Object.freeze({ under: Infinity, key: "time.daysAgo", unit: DAY }),
]);

const pad = (n) => String(n).padStart(2, "0");

/**
 * A stamp as epoch milliseconds, or `null` when it will not parse. The one
 * reading every view here shares, so a malformed value never reaches
 * arithmetic that would print `NaN`.
 *
 * @param {string|Date|null|undefined} value
 * @returns {number|null}
 */
function stampOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

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
 * The chronological lists' one ordering rule: **newest first**.
 *
 * The drawer's comments and activity trail are read as `desc` from the API, but
 * the *display* must not depend on the server having honoured that parameter —
 * a board predating it, or a fixture that ignores it, would otherwise put the
 * oldest line at the top. Sorting here makes the rendered order the same
 * whatever the read answered.
 *
 * A row whose stamp is missing or unreadable sorts after every dated row rather
 * than disappearing or landing at random; ties (including two unreadable rows)
 * keep their input order, which `Array#sort` guarantees as stable.
 *
 * @template {{}} T
 * @param {T[]} rows
 * @param {string} [key] the stamp's field name (`created_at`, or a session's `ts`)
 * @returns {T[]} a new array; the caller's list is untouched
 */
export function newestFirst(rows, key = "created_at") {
  return [...(rows ?? [])].sort((a, b) => {
    const left = stampOf(a?.[key]);
    const right = stampOf(b?.[key]);
    return (right ?? -Infinity) - (left ?? -Infinity);
  });
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
  const then = stampOf(value);
  if (then === null) return null;
  const date = value instanceof Date ? value : new Date(then);
  const delta = Math.max(0, now - then);
  const rung = rungs.find((entry) => delta < entry.under) ?? rungs[rungs.length - 1];
  return {
    key: rung.key,
    arg: Math.max(1, Math.round(delta / rung.unit)),
    absolute: absoluteStamp(date),
  };
}
