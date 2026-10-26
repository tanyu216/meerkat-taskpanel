/**
 * `lib/activity-feed.js` + the Activity store's own readers (R12x · B26).
 *
 * The feed is a *derivation*, and the whole of it lives in one pure module, so
 * the design's rules can be asserted here — browser-free, no fetch, no DOM:
 * admission (§3), folding (§5), day grouping (§4 L1), the filters (§3.4/§6), the
 * two empty states (§8) and the unread split (§4/§6).
 *
 * The two external boundaries are stubbed exactly as the neighbouring store
 * suites stub them: `vue` through the in-repo shim (the container ships no
 * `node_modules`) and nothing else — `lib/activity-feed.js` imports nothing at
 * all, which is why most of this file never touches a stub.
 *
 * Everything here is written against an **injected** clock and against local
 * calendar days built from that clock, never against the wall clock or a fixed
 * timezone: the feed groups days locally, so a test pinned to UTC would pass in
 * one timezone and fail in the next.
 *
 * Authority: `design/activity/DESIGN-activity.md` §3–§8, `design/BLOCKS.md` B26.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

import {
  ACTIVITY_GROUPS,
  ACTOR_VALUES,
  BURST_WINDOW_MS,
  DAY_PAGE_SIZE,
  EVENT_VALUES,
  buildFeed,
  changeLines,
  dayLabel,
  dayOf,
  emptyKind,
  feedRows,
  feedTime,
  filterItems,
  foldBursts,
  groupByDay,
  kindOf,
  markUnread,
  rowFrom,
  taskOptions,
} from "../../web/src/lib/activity-feed.js";

// Vue is aliased to the in-repo shim before any store is imported (see
// `./support/vue-loader.mjs`); the pure module above needs no such thing.
register("./support/vue-loader.mjs", import.meta.url);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fixed "now" so day grouping and the time ladder are asserted, not the clock. */
const NOW = Date.parse("2026-10-13T09:51:00Z");
/** An instant `minutes` before NOW, as ISO. */
const at = (minutes) => new Date(NOW - minutes * MINUTE).toISOString();

/** Local noon, `days` before NOW's local day — the day-grouping fixture's unit. */
function localNoon(days) {
  const date = new Date(NOW);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

const TASKS = [
  { id: "td_1", identifier: "TD-1", title: "Draft the onboarding copy" },
  { id: "td_2", identifier: "TD-2", title: "Collect the install survey" },
  { id: "td_3", identifier: "TD-3", title: "Wire the board" },
];

/** One audit row, with the fields the wire carries. */
function wire(id, event, overrides = {}) {
  return {
    id,
    task_id: "td_1",
    actor_kind: "agent",
    actor_id: "jobs",
    event,
    changes: {},
    revision: Number(String(id).replace(/\D/g, "")) || 1,
    created_at: at(10),
    ...overrides,
  };
}

/** The wire rows, normalised the way the store normalises them. */
const rowsOf = (activities) => feedRows(activities, TASKS);
/** A field edit, already normalised — what `foldBursts` actually receives. */
const edit = (id, minutesAgo, fields) => rowsOf([wire(id, "task_updated", { changes: { fields }, created_at: at(minutesAgo) })])[0];

const feedOf = (activities, extra = {}) => buildFeed({ activities, tasks: TASKS, now: NOW, ...extra });

describe("B26 · admission is an allow-list", () => {
  it("admits the families the design names and drops the machine's own events", () => {
    assert.deepEqual(kindOf(wire("a1", "task_created")), { kind: "created", verb: "created", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "task_claimed")), { kind: "claimed", verb: "claimed", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "task_moved")), { kind: "status", verb: "status", group: "status" });
    assert.deepEqual(kindOf(wire("a1", "task_reopened")), { kind: "status", verb: "status", group: "status" });
    assert.deepEqual(kindOf(wire("a1", "task_delivered")), { kind: "delivery", verb: "delivered", group: "delivery" });
    assert.deepEqual(kindOf(wire("a1", "report_written")), { kind: "delivery", verb: "delivered", group: "delivery" });
    assert.deepEqual(kindOf(wire("a1", "report_waived")), { kind: "delivery", verb: "delivered", group: "delivery" });
    assert.deepEqual(kindOf(wire("a1", "comment_added")), { kind: "comment", verb: "commented", group: "comment" });
    assert.deepEqual(kindOf(wire("a1", "relation_added")), { kind: "relation", verb: "linked", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "relation_removed")), { kind: "relation", verb: "linked", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "epic_auto_start")), { kind: "status", verb: "status", group: "status" });
    assert.deepEqual(kindOf(wire("a1", "attachment_added")), { kind: "attachment", verb: "attached", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "attachment_removed")), { kind: "attachment", verb: "attached", group: "meta" });
    assert.deepEqual(kindOf(wire("a1", "task_archived")), { kind: "archived", verb: "status", group: "status" });

    for (const noise of ["task_heartbeat", "session_registered", "session_closed", "progress", "anomaly", "label_gc", "dictionary_upsert", "project_created", "project_updated", "attachment_updated", "import_completed"]) {
      assert.equal(kindOf(wire("a1", noise)), null, `${noise} must not be admitted`);
    }
    assert.equal(kindOf(wire("a1", "task_updated", { changes: {} })), null, "a field-less update is a revision tick, not an event");
  });

  it("classifies a field edit by the field it names", () => {
    const kind = (fields) => kindOf(wire("a1", "task_updated", { changes: { fields } }));
    assert.equal(kind(["labels"]).kind, "label");
    assert.equal(kind(["assignee"]).kind, "assignee");
    assert.equal(kind(["reporter"]).kind, "assignee");
    // The command layer writes these field names (the older role words stay
    // accepted for historical frames).
    assert.equal(kind(["assigneeId", "assigneeKind"]).kind, "assignee");
    assert.equal(kind(["reporterId", "reporterKind"]).kind, "assignee");
    assert.equal(kind(["title"]).kind, "updated");
    assert.equal(kind(["priority"]).kind, "updated");
    // The first *classifiable* field decides: `fields` is the whole patch, so a
    // patch that renames a card and re-labels it is a label change to a reader.
    assert.equal(kind(["idem", "labels", "title"]).kind, "label");
    // A field the update path cannot even write is not a kind.
    assert.equal(kind(["status"]), null);
  });

  it("drops a row whose task is not on this board, and one with no instant", () => {
    assert.equal(rowFrom(wire("a1", "task_created"), null), null, "no task, no row — the identifier and title come from the board");
    assert.equal(rowFrom(wire("a1", "task_created", { created_at: "" }), TASKS[0]), null);
    const admitted = rowFrom(wire("a1", "task_created"), TASKS[0]);
    assert.equal(admitted.identifier, "TD-1");
    assert.equal(admitted.title, "Draft the onboarding copy");
    assert.equal(admitted.actorKind, "agent");
  });

  it("resolves every row's task through the board's own set and sorts newest first", () => {
    const rows = feedRows(
      [
        wire("a1", "task_created", { created_at: at(60) }),
        wire("a2", "comment_added", { task_id: "td_2", created_at: at(10) }),
        wire("a3", "task_heartbeat", { created_at: at(1) }),
        wire("a4", "task_created", { task_id: "td_nope", created_at: at(1) }),
      ],
      TASKS,
    );
    assert.deepEqual(rows.map((entry) => entry.id), ["a2", "a1"]);
    assert.deepEqual(rows.map((entry) => entry.identifier), ["TD-2", "TD-1"]);
  });
});

describe("B26 · folding", () => {
  it("folds one actor's field edits on one task inside the window into a single row", () => {
    const items = foldBursts([edit("a1", 1, ["labels"]), edit("a2", 3, ["priority"]), edit("a3", 4, ["title"])]);
    assert.equal(items.length, 1);
    assert.equal(items[0].burst.count, 3);
    assert.deepEqual(items[0].burst.items.map((item) => item.id), ["a1", "a2", "a3"]);
    // §5 — the folded row states the *newest* member's instant, and its own family
    // is the field-edit one, so an event-filtered feed shows it only under `all`.
    assert.equal(items[0].at, at(1));
    assert.equal(items[0].event, "meta");
    assert.equal(items[0].group, "meta");
    assert.equal(items[0].verb, "updated");
  });

  it("does not fold across the window, across actors, across tasks, or across a comment", () => {
    assert.equal(foldBursts([edit("a2", 20, ["title"]), edit("a1", 1, ["title"])]).length, 2, "a gap longer than five minutes opens a new row");
    assert.equal(foldBursts([edit("a2", 2, ["title"]), { ...edit("a1", 1, ["title"]), actor: "linus" }]).length, 2, "two actors never fold together");
    assert.equal(foldBursts([edit("a2", 2, ["title"]), { ...edit("a1", 1, ["title"]), taskId: "td_2" }]).length, 2, "two tasks never fold together");
    const broken = foldBursts([edit("a2", 2, ["title"]), rowsOf([wire("a1", "comment_added", { created_at: at(1) })])[0]]);
    assert.equal(broken.length, 2, "a comment is an event of its own and ends the run");
    assert.equal(foldBursts([edit("a2", 2, ["title"]), edit("a1", 1, ["title"])]).length, 1);
  });

  it("folds a task's own creation and the claim that followed it into the creation", () => {
    const items = foldBursts(
      rowsOf([
        wire("a2", "task_claimed", { created_at: at(1), changes: { from: "backlog", to: "in_progress" } }),
        wire("a1", "task_created", { created_at: at(3), changes: { identifier: "TD-1" } }),
      ]),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].event, "created");
    assert.deepEqual(items[0].extra.map((item) => item.id), ["a2"]);
  });

  it("keeps a burst's own window at five minutes and no further", () => {
    const items = foldBursts([edit("a2", 5, ["title"]), edit("a1", 0, ["title"])]);
    assert.equal(items.length, 1);
    assert.equal(items[0].burst.count, 2);
    const span = Math.abs(new Date(items[0].burst.items[0].at).getTime() - new Date(items[0].burst.items[1].at).getTime());
    assert.equal(span, BURST_WINDOW_MS);
  });
});

describe("B26 · the row's visible time", () => {
  it("walks minutes → hours → days and never reads as zero", () => {
    assert.equal(feedTime(at(9), NOW).key, "time.minutesAgo");
    assert.equal(feedTime(at(9), NOW).arg, 9);
    assert.equal(feedTime(at(59), NOW).key, "time.minutesAgo");
    assert.equal(feedTime(at(61), NOW).key, "time.hoursAgo");
    assert.equal(feedTime(at(23 * 60), NOW).key, "time.hoursAgo");
    assert.equal(feedTime(at(25 * 60), NOW).key, "time.daysAgo");
    assert.equal(feedTime(at(0), NOW).arg, 1, "a just-now stamp is one minute, not zero");
    assert.equal(feedTime(new Date(NOW + HOUR).toISOString(), NOW).arg, 1, "a future stamp is the freshest rung, never a negative");
    assert.equal(feedTime("not a date", NOW), null);
    // The `title` is the same instant read in the reader's own zone and minute —
    // compared against the zone's own formatting, not against a UTC literal.
    const stamp = new Date(at(9));
    const expected = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}`;
    assert.equal(feedTime(at(9), NOW).absolute, expected);
  });

  it("heads today and yesterday from the catalogue and every other day with a localised date", () => {
    assert.deepEqual(dayLabel(dayOf(at(5)), NOW, "en"), { text: null, key: "activity.day.today", kind: "today" });
    assert.deepEqual(dayLabel(dayOf(localNoon(1)), NOW, "en"), { text: null, key: "activity.day.yesterday", kind: "yesterday" });
    const older = dayLabel(dayOf(localNoon(3)), NOW, "en");
    assert.equal(older.kind, "absolute");
    assert.equal(older.key, null);
    assert.match(older.text, /^[A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}$/);
    assert.match(dayLabel(dayOf(localNoon(3)), NOW, "zh").text, /月.*日/);
  });

  it("groups the feed by local calendar day, newest first", () => {
    const days = groupByDay([{ id: "a1", at: at(5) }, { id: "a2", at: localNoon(1) }, { id: "a3", at: at(7 * 60) }], "en", NOW);
    assert.deepEqual(days.map((day) => day.day), [dayOf(at(5)), dayOf(localNoon(1))]);
    assert.deepEqual(days[0].items.map((item) => item.id), ["a1", "a3"], "same local day, feed order kept");
    assert.deepEqual(days[1].items.map((item) => item.id), ["a2"]);
  });
});

describe("B26 · the three filters", () => {
  const items = [
    { id: "a1", identifier: "TD-1", actorKind: "agent", group: "status", title: "t" },
    { id: "a2", identifier: "TD-2", actorKind: "human", group: "comment", title: "t" },
    { id: "a3", identifier: "TD-2", actorKind: "agent", group: "meta", title: "t" },
    { id: "a4", identifier: "TD-1", actorKind: "human", group: "delivery", title: "t" },
  ];

  it("passes everything at `all` and ANDs the three conditions", () => {
    assert.equal(filterItems(items).length, 4);
    assert.deepEqual(filterItems(items, { actor: "agent" }).map((i) => i.id), ["a1", "a3"]);
    assert.deepEqual(filterItems(items, { event: "comment" }).map((i) => i.id), ["a2"]);
    assert.deepEqual(filterItems(items, { event: "delivery" }).map((i) => i.id), ["a4"]);
    assert.deepEqual(filterItems(items, { actor: "agent", task: "TD-2" }).map((i) => i.id), ["a3"]);
    assert.deepEqual(filterItems(items, { actor: "human", event: "delivery", task: "TD-1" }).map((i) => i.id), ["a4"]);
    assert.deepEqual(filterItems(items, { actor: "human", event: "delivery", task: "TD-2" }), []);
  });

  it("offers the feed's own tasks, newest first, one entry each", () => {
    assert.deepEqual(taskOptions(items).map((entry) => entry.identifier), ["TD-1", "TD-2"]);
  });

  it("keeps the three domains the design fixes", () => {
    assert.deepEqual([...ACTOR_VALUES], ["all", "human", "agent"]);
    assert.deepEqual([...EVENT_VALUES], ["all", "status", "comment", "delivery"]);
    assert.deepEqual([...ACTIVITY_GROUPS], ["status", "comment", "delivery", "meta"]);
    assert.equal(DAY_PAGE_SIZE, 3);
  });
});

describe("B26 · the sidebar's assignee narrowing", () => {
  const items = [
    { id: "a1", identifier: "TD-1", actor: "jobs", actorKind: "agent", group: "status", title: "t" },
    { id: "a2", identifier: "TD-2", actor: "Terry", actorKind: "human", group: "comment", title: "t" },
    { id: "a3", identifier: "TD-2", actor: "jobs", actorKind: "agent", group: "meta", title: "t" },
    { id: "a4", identifier: "TD-1", actor: "Terry", actorKind: "human", group: "delivery", title: "t" },
  ];
  const me = "Terry";

  it("is no condition at all / all, and reads like the board's four values", () => {
    assert.equal(filterItems(items).length, 4);
    assert.equal(filterItems(items, { assignee: "all", assigneeMe: me }).length, 4);
    assert.equal(filterItems(items, { assignee: "", assigneeMe: me }).length, 4);
    assert.deepEqual(filterItems(items, { assignee: "agent", assigneeMe: me }).map((i) => i.id), ["a1", "a3"]);
    assert.deepEqual(filterItems(items, { assignee: "human", assigneeMe: me }).map((i) => i.id), ["a2", "a4"]);
    assert.deepEqual(filterItems(items, { assignee: "me", assigneeMe: me }).map((i) => i.id), ["a2", "a4"]);
    assert.deepEqual(filterItems(items, { assignee: "jobs", assigneeMe: me }).map((i) => i.id), ["a1", "a3"]);
  });

  it("ANDs with the feed's own three controls", () => {
    assert.deepEqual(filterItems(items, { actor: "agent", assignee: "jobs", assigneeMe: me }).map((i) => i.id), ["a1", "a3"]);
    assert.deepEqual(
      filterItems(items, { actor: "human", assignee: "jobs", assigneeMe: me }),
      [],
      "the sidebar narrowing and the actor control are two conditions on one axis — both must hold",
    );
    assert.deepEqual(filterItems(items, { event: "comment", assignee: "jobs", assigneeMe: me }), []);
  });
});

describe("B26 · the count, the empty states and the unread split", () => {
  it("counts rows, not events: a folded burst counts once", () => {
    const feed = feedOf([
      wire("a3", "task_updated", { changes: { fields: ["title"] }, created_at: at(2) }),
      wire("a2", "task_updated", { changes: { fields: ["priority"] }, created_at: at(1) }),
      wire("a1", "comment_added", { created_at: at(30) }),
    ]);
    assert.equal(feed.items.length, 2, "two edits fold into one row");
    assert.equal(feed.shown, 2);
    assert.equal(feed.admissible, 2);
  });

  it("distinguishes a project that has never happened from a filter that matches nothing", () => {
    assert.equal(emptyKind(0, 0), "project");
    assert.equal(emptyKind(3, 0), "filter");
    assert.equal(emptyKind(3, 1), null);

    const empty = feedOf([]);
    assert.equal(empty.emptyKind, "project");
    assert.equal(empty.days.length, 0);

    const filtered = feedOf([wire("a1", "comment_added", { created_at: at(5) })], { filters: { event: "delivery" } });
    assert.equal(filtered.emptyKind, "filter");
    assert.equal(filtered.shown, 0);
    assert.equal(filtered.admissible, 1, "the ledger itself is not empty — only this reading of it is");
  });

  it("reads unread off one cursor: everything newer than it, and everything on a first visit", () => {
    const items = [{ id: "a1", at: at(1) }, { id: "a2", at: at(60) }, { id: "a3", at: at(120) }];
    assert.equal(markUnread(items, null).size, 3, "a reader who has never looked has seen none of it");
    assert.deepEqual([...markUnread(items, at(60))], ["a1"], "the cursor's own row is read; only strictly newer rows are new");
  });

  it("places one boundary, after the last unread row, inside its own day group", () => {
    const feed = feedOf(
      [
        wire("a1", "comment_added", { created_at: at(5) }),
        wire("a2", "comment_added", { created_at: at(30) }),
        wire("a3", "comment_added", { created_at: at(25 * 60) }),
        wire("a4", "comment_added", { created_at: at(50 * 60) }),
      ],
      { seenAt: at(20 * 60) },
    );
    assert.equal(feed.unreadCount, 2, "the two rows newer than the cursor are new");
    const boundaries = feed.days.filter((day) => day.boundary >= 0);
    assert.equal(boundaries.length, 1, "one boundary per feed, not one per day");
    const day = boundaries[0];
    assert.equal(day.items[day.boundary].id, "a2", "the boundary sits after the last unread row");
    assert.equal(day.items.length - 1, day.boundary);
    assert.equal(feed.days.filter((entry) => entry.boundary >= 0).length, 1);
  });

  it("marks a burst unread when any of its members is, and counts it once", () => {
    const feed = feedOf(
      [
        wire("a2", "task_updated", { changes: { fields: ["title"] }, created_at: at(1) }),
        wire("a1", "task_updated", { changes: { fields: ["priority"] }, created_at: at(2) }),
      ],
      { seenAt: at(90) },
    );
    assert.equal(feed.items.length, 1);
    assert.equal(feed.unreadCount, 1);
    assert.equal(feed.unread.has(feed.items[0].id), true);
  });

  it("pages day groups and offers `Load older` only while a page is unread", () => {
    const activities = [0, 1, 2, 3, 4, 5].map((index) => wire(`a${index + 1}`, "comment_added", { created_at: localNoon(index) }));
    const first = feedOf(activities);
    assert.equal(first.days.length, DAY_PAGE_SIZE, "the first page is three day groups");
    assert.equal(first.hasMore, true);
    assert.deepEqual([...new Set(first.days.map((day) => day.page))], [1]);
    const second = feedOf(activities, { page: 2 });
    assert.equal(second.days.length, 6);
    assert.equal(second.hasMore, false);
    assert.deepEqual([...new Set(second.days.map((day) => day.page))], [1, 2]);
    assert.equal(feedOf([]).hasMore, false, "an empty project has nothing older to load");
  });
});

describe("B26 · the change lines a row unfolds", () => {
  it("renders a transition where the row carries one and the new value where it does not", () => {
    const moved = rowFrom(wire("a1", "task_moved", { changes: { from: "todo", to: "in_progress" } }), TASKS[0]);
    assert.deepEqual(changeLines(moved), [{ field: "activity.detail.status", kind: "status", transition: { from: "todo", to: "in_progress" } }]);

    // The audit row names the *new* assignee only, so the line states that and
    // never invents an arrow the record cannot support.
    const assigned = rowFrom(
      wire("a2", "task_updated", { changes: { fields: ["assignee"], dictionaries: [{ displayName: "jobs", action: "existing" }] } }),
      TASKS[0],
    );
    assert.deepEqual(changeLines(assigned), [{ field: "activity.detail.assignee", kind: "assignee", value: "jobs" }]);

    const delivered = rowFrom(wire("a3", "task_delivered", { changes: { round: 2, from: "in_progress", to: "in_review" } }), TASKS[0]);
    assert.equal(changeLines(delivered)[0].value, "Round 2");

    const labelled = rowFrom(wire("a4", "task_updated", { changes: { fields: ["labels"], labels: [{ displayName: "perf", action: "existing" }] } }), TASKS[0]);
    assert.deepEqual(changeLines(labelled)[0].tokens, ["+ perf"]);

    // The command layer's field names, not the UI's role words.
    const reassigned = rowFrom(
      wire("a5", "task_updated", { changes: { fields: ["assigneeId", "assigneeKind"], dictionaries: [{ displayName: "jobs" }] } }),
      TASKS[0],
    );
    assert.deepEqual(changeLines(reassigned), [{ field: "activity.detail.assignee", kind: "assignee", value: "jobs" }]);

    // Archiving records the stage it left, not a transition to an "archived" status.
    const archived = rowFrom(wire("a6", "task_archived", { changes: { from: "done", archivedAt: at(1) } }), TASKS[0]);
    assert.deepEqual(changeLines(archived), [{ field: "activity.detail.archived", kind: "status", value: "done" }]);

    const attached = rowFrom(wire("a7", "attachment_added", { changes: { filename: "spec.md" } }), TASKS[0]);
    assert.deepEqual(changeLines(attached), [{ field: "activity.detail.attachment", kind: "attachment", value: "spec.md" }]);
  });
});

describe("B26 · the store's address-bar shadow", () => {
  it("uses `replaceState`, preserving the path and the fragment, and only when the address changes", async () => {
    const store = await import("../../web/src/stores/activity.js");
    store.resetActivityFilters();
    const calls = [];
    // R16 §4.4 — the payload moved from the fragment to the query, and the
    // drawer's `#/task/<id>` is now the thing the writer must carry through
    // untouched rather than the thing it wrote.
    const location = { pathname: "/activity", search: "", hash: "#/task/TD-1" };
    const history = { replaceState: (...args) => calls.push(args) };
    store.replaceActivityQuery(location, history);
    assert.equal(calls.length, 0, "the resting address is already the resting query");
    store.writeActivityFilter("actor", "agent");
    store.replaceActivityQuery(location, history);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [null, "", "/activity?actor=agent#/task/TD-1"]);
    store.resetActivityFilters();
  });

  it("lands the filters exactly as the address states them", async () => {
    const store = await import("../../web/src/stores/activity.js");
    store.applyActivityQuery("?actor=agent&event=status&task=TD-1");
    assert.deepEqual({ ...store.activity.filters }, { actor: "agent", event: "status", task: "TD-1" });
    assert.equal(store.applyActivityQuery("?actor=nonsense"), false, "an out-of-domain value is no condition");
    assert.deepEqual({ ...store.activity.filters }, { actor: "all", event: "all", task: "all" });
    store.writeActivityFilter("actor", "agent");
    store.applyActivityQuery("");
    assert.deepEqual(
      { ...store.activity.filters },
      { actor: "all", event: "all", task: "all" },
      "a slot the address does not name is `all` — the address is the truth for this slot group",
    );
  });

  it("absorbs a streamed row once and moves the read cursor past the ledger", async () => {
    const store = await import("../../web/src/stores/activity.js");
    const { board } = await import("../../web/src/stores/board.js");
    board.tasks = [{ id: "td_1", identifier: "TD-1", title: "Draft the onboarding copy", project_id: "p1" }];
    store.resetActivity();
    store.absorb(wire("live-1", "comment_added", { created_at: at(1) }));
    store.absorb(wire("live-1", "comment_added", { created_at: at(1) }));
    store.absorb(null);
    assert.equal(store.activity.entries.length, 1, "the stream's row lands once");
    // `markAllRead` moves the cursor past every admitted row, so the pill, the
    // boundary and the boundary's count all reach zero together.
    assert.equal(store.markAllRead(), at(1));
    assert.equal(store.unreadCount.value, 0);
    store.resetActivity();
    store.activity.seenAt = null;
    board.tasks = [];
  });

  /**
   * §8 — "a ledger that has not been read yet is not a finding" (T-20261013-160505).
   *
   * `buildFeed` sees only the entries it was handed, so a project whose ledger has
   * simply not been read derives the *same* `emptyKind` as a project that has never
   * had an event. The view is not allowed to say the second when it only knows the
   * first: `projectEmpty` is the store's pair — the derivation *and* the read.
   */
  it("does not call a ledger that has not been read empty", async () => {
    const store = await import("../../web/src/stores/activity.js");
    const { board } = await import("../../web/src/stores/board.js");
    board.tasks = [{ id: "td_1", identifier: "TD-1", title: "Draft the onboarding copy", project_id: "p1" }];

    store.resetActivity();
    assert.equal(store.activity.loaded, false, "nothing has been read yet");
    assert.equal(store.feed.value.emptyKind, "project", "the raw derivation cannot tell the two apart …");
    assert.equal(store.projectEmpty.value, false, "… which is exactly why the view reads this instead");

    // A read that lands with nothing to show is the finding: nothing has happened.
    store.activity.loaded = true;
    assert.equal(store.projectEmpty.value, true);

    // A read that lands with an admitted row is not.
    store.absorb(wire("live-2", "comment_added", { created_at: at(1) }));
    assert.equal(store.feed.value.emptyKind, null);
    assert.equal(store.projectEmpty.value, false);

    store.resetActivity();
    board.tasks = [];
  });
});
