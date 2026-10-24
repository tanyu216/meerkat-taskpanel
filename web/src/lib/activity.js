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

import { TIME_RUNGS_DRAWER, timeLadder } from "./time.js";

/**
 * The events the drawer gives a localised sentence, as the **suffix** of their
 * `activity.*` catalogue key: the key family is static (the template writes
 * `activity.${sentence}`) and only the sentence varies with the event. An event
 * not listed here reads as the generic `activity.other`.
 */
export const ACTIVITY_SENTENCES = Object.freeze({
  task_created: "created",
  task_claimed: "claimed",
  comment_added: "commented",
  task_archived: "archived",
  task_updated: "verb.updated",
  task_delivered: "verb.delivered",
  report_written: "verb.delivered",
  report_waived: "verb.delivered",
  relation_added: "verb.linked",
  relation_removed: "verb.linked",
  epic_auto_start: "verb.status",
  attachment_added: "verb.attached",
  attachment_removed: "verb.attached",
  session_registered: "session",
  session_closed: "session",
  progress: "progress",
});

/**
 * The row's timestamp: the drawer's four-step ladder — `time.justNow` under a
 * minute, `time.minutesAgo` under an hour, `time.hoursAgo` under a day,
 * `time.daysAgo` from a day up — as `{key, arg, absolute}`.
 *
 * A stamp in the future (a clock that disagrees with the server's) reads as the
 * freshest row rather than as a negative number, and anything unparseable
 * returns `null` so the caller drops the node instead of printing `NaN`.
 *
 * @param {string|null} iso
 * @param {number} [now] epoch ms — injected by the tests, never by the app
 * @returns {{key: string, arg: number, absolute: string}|null}
 */
export function relativeTime(iso, now = Date.now()) {
  return timeLadder(iso, now, TIME_RUNGS_DRAWER);
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
  if (event === "task_moved" || event === "task_reopened" || event === "task_resumed") {
    const { from, to } = activity?.changes ?? {};
    if (from && to) return { text: `status: ${from} → ${to}` };
  }
  // An unknown event reads as a generic "recorded an event", never as a raw
  // English identifier in a Chinese UI.
  return event === "" ? { text: "" } : { sentence: "other" };
}
