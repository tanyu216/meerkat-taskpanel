/**
 * B09 · the activity stream's two view functions (M2).
 *
 * An activity row is `{actor_id, event, changes, created_at}` on the wire. The
 * drawer renders it as the prototype does: the actor, a **sentence**, and a
 * relative timestamp whose `title` carries the absolute one. Both the sentence
 * and the timestamp are *views* — the record itself never carries either, so the
 * same row re-reads under any language and any clock.
 *
 * The event vocabulary is the core's (`ACTIVITY_EVENTS`); the sentences are the
 * catalogue's (`activity.*`). An event with no catalogue sentence falls back to
 * its own name rather than to an invented sentence — an unknown event must read
 * as unknown, not as a plausible lie.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The three events the prototype gives a localised sentence, as the **suffix**
 * of their `activity.*` catalogue key: the key family is static (the template
 * writes `activity.${sentence}`) and only the sentence varies with the event.
 */
export const ACTIVITY_SENTENCES = Object.freeze({
  task_created: "created",
  task_claimed: "claimed",
  comment_added: "commented",
});

const pad = (n) => String(n).padStart(2, "0");

/** `2026-10-05 11:20` — the prototype's absolute stamp, read in local time. */
function absoluteStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The row's timestamp: the prototype's two-step ladder — `time.hoursAgo` under a
 * day, `time.daysAgo` from a day up — as `{key, arg, absolute}`.
 *
 * A stamp in the future (a clock that disagree with the server's) reads as the
 * freshest row rather than as a negative number, and anything unparseable
 * returns `null` so the caller drops the node instead of printing `NaN`.
 *
 * @param {string|null} iso
 * @param {number} [now] epoch ms — injected by the tests, never by the app
 * @returns {{key: string, arg: number, absolute: string}|null}
 */
export function relativeTime(iso, now = Date.now()) {
  const parsed = new Date(iso ?? NaN);
  const then = parsed.getTime();
  if (!Number.isFinite(then)) return null;
  const delta = Math.max(0, now - then);
  const step = delta < DAY ? { key: "time.hoursAgo", arg: Math.round(delta / HOUR) } : { key: "time.daysAgo", arg: Math.round(delta / DAY) };
  return { ...step, arg: Math.max(1, step.arg), absolute: absoluteStamp(parsed) };
}

/**
 * The row's sentence as `{sentence}` — the suffix of an `activity.*` catalogue
 * key — or `{text}`, already final.
 *
 * @param {{event?: string, changes?: object}|null} activity
 * @returns {{sentence: string}|{text: string}}
 */
export function activityLine(activity) {
  const event = activity?.event ?? "";
  if (ACTIVITY_SENTENCES[event]) return { sentence: ACTIVITY_SENTENCES[event] };
  if (event === "task_moved") {
    const { from, to } = activity?.changes ?? {};
    if (from && to) return { text: `status: ${from} → ${to}` };
  }
  return { text: event };
}
