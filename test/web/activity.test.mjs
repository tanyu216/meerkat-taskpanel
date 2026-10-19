/**
 * B09 · the drawer's activity rows and their relative timestamps (M2).
 *
 * Two pure functions the drawer leans on, tested without a browser:
 *
 *   * `relativeTime` — the prototype's two-step ladder (`time.hoursAgo` under a
 *     day, `time.daysAgo` from a day up) plus the absolute stamp the `title`
 *     carries. It is a *view* function: the board's own clock never enters the
 *     record, so the same activity can be re-read under any language.
 *   * `activityLine` — an activity row's sentence: a catalogue key for the
 *     events the prototype names (`activity.created` / `claimed` / `commented`),
 *     the prototype's `status: <from> → <to>` mono line for a move, and a
 *     generic fallback for anything else (never a raw identifier).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACTIVITY_SENTENCES, activityLine, relativeTime } from "../../web/src/lib/activity.js";
import { resolveText } from "../../web/src/i18n/messages.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A fixed "now" so the ladder is asserted, not the wall clock. */
const NOW = Date.parse("2026-10-08T11:20:00Z");

/** The relative half of the view, without the absolute stamp. */
const ladder = (iso) => {
  const { key, arg } = relativeTime(iso, NOW);
  return { key, arg };
};

describe("web/activity — relative time", () => {
  it("uses hours under a day and days from a day up", () => {
    assert.deepEqual(ladder(new Date(NOW - 2 * HOUR).toISOString()), { key: "time.hoursAgo", arg: 2 });
    assert.deepEqual(ladder(new Date(NOW - 3 * DAY).toISOString()), { key: "time.daysAgo", arg: 3 });
  });

  it("never reads as zero — a just-now stamp is one hour, not `0h`", () => {
    assert.deepEqual(ladder(new Date(NOW - 1_000).toISOString()), { key: "time.hoursAgo", arg: 1 });
  });

  it("rounds to the nearest unit, so the row does not drift a unit late", () => {
    assert.deepEqual(ladder(new Date(NOW - 90 * 60_000).toISOString()), { key: "time.hoursAgo", arg: 2 });
    assert.deepEqual(ladder(new Date(NOW - (DAY + 1 * HOUR)).toISOString()), { key: "time.daysAgo", arg: 1 });
  });

  it("treats a timestamp in the future as the freshest row, not a negative", () => {
    assert.deepEqual(ladder(new Date(NOW + 5 * HOUR).toISOString()), { key: "time.hoursAgo", arg: 1 });
  });

  it("returns null for a stamp it cannot read, so the row drops the node instead of printing NaN", () => {
    assert.equal(relativeTime("not a date", NOW), null);
    assert.equal(relativeTime(null, NOW), null);
  });

  it("formats the absolute stamp the way the prototype's `title` does", () => {
    const { absolute } = relativeTime(new Date(NOW - 3 * DAY).toISOString(), NOW);
    assert.match(absolute, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("web/activity — the row sentence", () => {
  it("names the three events the prototype names", () => {
    assert.deepEqual(activityLine({ event: "task_created" }), { sentence: "created" });
    assert.deepEqual(activityLine({ event: "task_claimed" }), { sentence: "claimed" });
    assert.deepEqual(activityLine({ event: "comment_added" }), { sentence: "commented" });
  });

  it("every sentence resolves in the shipped catalogue, in both languages", () => {
    // The template builds the hook as `activity.${sentence}`, which no source
    // scanner can read as a literal — so the key family is pinned here instead.
    for (const sentence of Object.values(ACTIVITY_SENTENCES)) {
      for (const language of ["en", "zh"]) {
        const key = `activity.${sentence}`;
        assert.notEqual(resolveText(language, key), key, `${key} missing in ${language}`);
      }
    }
  });

  it("renders a move as the prototype's `status: from → to` line", () => {
    assert.deepEqual(activityLine({ event: "task_moved", changes: { from: "backlog", to: "todo" } }), {
      text: "status: backlog → todo",
    });
  });

  it("uses a generic sentence for an event it does not know, never a raw identifier", () => {
    assert.deepEqual(activityLine({ event: "report_waived" }), { sentence: "verb.delivered" });
    assert.deepEqual(activityLine({ event: "task_moved", changes: {} }), { sentence: "other" });
    assert.deepEqual(activityLine({ event: "brand_new_event" }), { sentence: "other" });
    assert.deepEqual(activityLine(null), { text: "" });
  });
});
