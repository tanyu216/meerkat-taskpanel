/**
 * B26 · the Activity feed's pure layer.
 *
 * Authority: `design/activity/DESIGN-activity.md` — §3 admission, §4 levels,
 * §5 folding, §6 interaction, §7 density, §8 empty states; block contract
 * `design/BLOCKS.md` B26. This module is the *derivation* half of that design:
 * admission, folding, day grouping, filtering, pagination. It is pure — an
 * activity array in, a feed out — so `node --test` can assert the rules without
 * a browser and `ActivityView.vue` stays a rendering of the result.
 *
 * Three rules are load-bearing, and each is stated exactly once, here:
 *
 *   * **Admission is an allow-list, not a filter.** The board's audit trail is
 *     machine-shaped: heartbeats, session lifecycle, per-field auto-save, label
 *     GC. Those rows answer no question a reader has, so the feed admits a fixed
 *     set of events (§3.2) and drops the rest by construction rather than by a
 *     deny-list that silently starts missing things. A `task_updated` is admitted
 *     only when its `fields` name a human-visible change — the "revision ticked,
 *     nothing moved" rows are noise (§3.3).
 *   * **A burst is a fold, not a new event.** Same actor, same task, same
 *     field-edit family, inside a five-minute window ⇒ one lighter row (§5). The
 *     folded row keeps the newest member's instant, and its own group is `meta`,
 *     so an event-filtered feed shows it only under "All events".
 *   * **The count is the number of rows the reader can see** (§6): a folded burst
 *     is one row, and the count sentence is never the number of hidden events.
 *
 * Data the audit row does not carry is never invented. A `task_updated`'s audit
 * names the *new* value (`changes.dictionaries` / `changes.labels`), not the old
 * one, so a detail line reads `Assignee · jobs` where the prototype's sample
 * markup reads `elon → jobs`; a `task_moved` and a `task_delivered` *do* carry
 * `from`/`to`, and those render as the transition. A comment's body likewise has
 * no producer on this surface — the row carries the comment's id and kind, and
 * the line says the kind.
 */

import { kindLabel } from "./actor-kind.js";
import { actorMatches } from "./assignee-filter.js";
import { TIME_RUNGS_THREE, timeLadder } from "./time.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** §5 — the fold window: one "operating round" of edits. */
export const BURST_WINDOW_MS = 5 * MINUTE;

/**
 * §6 — `Load older` unfolds **day groups**, not rows: a page is three days, so
 * the first page is the feed's recent past and each press adds one more day.
 */
export const DAY_PAGE_SIZE = 3;

/**
 * The feed's actor filter domain (§3.4 / the prototype's `[data-activity-filter="actor"]`).
 */
export const ACTOR_VALUES = Object.freeze(["all", "human", "agent"]);

/**
 * The feed's event filter domain. Exactly four values, and the mapping is
 * explicit rather than inferred (§3.4): `status` = a status move, `comment` = a
 * comment, `delivery` = a report/delivery, everything else is background and
 * appears under `all` only.
 */
export const EVENT_VALUES = Object.freeze(["all", "status", "comment", "delivery"]);

/**
 * §3.4 — the four buckets a row's `[data-activity-group]` may name. `meta` is the
 * background the three event-filtered readings leave out; it is still a bucket,
 * because a row's group is what the filter compares and every row must have one.
 */
export const ACTIVITY_GROUPS = Object.freeze(["status", "comment", "delivery", "meta"]);

/**
 * §3.2 — the allow-list. Core activity event → the row it may become.
 *
 * `verb` is the sentence's catalogue key suffix (`activity.verb.<verb>`): only
 * the verb lives in the row, so the object of the sentence can be the task link
 * beside it. `group` is the event filter's bucket (§3.4).
 *
 * `task_updated` is deliberately **absent**: its kind depends on its `fields`
 * (see `kindOfTaskUpdated`), so it cannot be a flat table entry.
 */
export const ADMITTED_EVENTS = Object.freeze({
  task_created: Object.freeze({ kind: "created", verb: "created", group: "meta" }),
  task_claimed: Object.freeze({ kind: "claimed", verb: "claimed", group: "meta" }),
  task_moved: Object.freeze({ kind: "status", verb: "status", group: "status" }),
  task_reopened: Object.freeze({ kind: "status", verb: "status", group: "status" }),
  // Archive is a terminal act, not a transition to a status of its own; its
  // `changes.from` names the stage it left.
  task_archived: Object.freeze({ kind: "archived", verb: "status", group: "status" }),
  task_delivered: Object.freeze({ kind: "delivery", verb: "delivered", group: "delivery" }),
  report_written: Object.freeze({ kind: "delivery", verb: "delivered", group: "delivery" }),
  report_waived: Object.freeze({ kind: "delivery", verb: "delivered", group: "delivery" }),
  comment_added: Object.freeze({ kind: "comment", verb: "commented", group: "comment" }),
  relation_added: Object.freeze({ kind: "relation", verb: "linked", group: "meta" }),
  relation_removed: Object.freeze({ kind: "relation", verb: "linked", group: "meta" }),
  // The parent's own start: a child entered work and the board moved the epic.
  epic_auto_start: Object.freeze({ kind: "status", verb: "status", group: "status" }),
  attachment_added: Object.freeze({ kind: "attachment", verb: "attached", group: "meta" }),
  attachment_removed: Object.freeze({ kind: "attachment", verb: "attached", group: "meta" }),
  // `attachment_updated` is a content replace, not a new file: it stays out of
  // the human feed (the drawer's attachment list still refreshes from it).
});

/**
 * The `task_updated` field names that make a row a *classifiable* change, and
 * the kind each becomes. A `task_updated` whose `fields` name none of these is
 * a machine-side revision tick and is dropped (§3.3).
 */
export const TASK_UPDATED_KINDS = Object.freeze({
  labels: Object.freeze({ kind: "label", verb: "label" }),
  // The command layer writes the **database field names**; the older role words
  // are kept so a test or a historical frame still classifies.
  assigneeId: Object.freeze({ kind: "assignee", verb: "assignee" }),
  assigneeKind: Object.freeze({ kind: "assignee", verb: "assignee" }),
  reporterId: Object.freeze({ kind: "assignee", verb: "assignee" }),
  reporterKind: Object.freeze({ kind: "assignee", verb: "assignee" }),
  assignee: Object.freeze({ kind: "assignee", verb: "assignee" }),
  reporter: Object.freeze({ kind: "assignee", verb: "assignee" }),
  title: Object.freeze({ kind: "updated", verb: "updated" }),
  description: Object.freeze({ kind: "updated", verb: "updated" }),
  priority: Object.freeze({ kind: "updated", verb: "updated" }),
  kind: Object.freeze({ kind: "updated", verb: "updated" }),
});

/**
 * §5 — the field-edit family: the kinds that fold with each other. A comment or
 * a delivery is an event of its own and never folds into a neighbouring edit.
 */
export const BURST_KINDS = Object.freeze(["label", "assignee", "updated", "status"]);

/* ------------------------------------------------------------------ time */

const pad = (n) => String(n).padStart(2, "0");

/** `2026-10-05 11:20` — the absolute stamp the row's `title` carries. */
export { absoluteStamp } from "./time.js";

/**
 * The row's visible time, on the feed's three-rung ladder: minutes under an
 * hour, hours under a day, days from a day up. Anything in the future (a clock
 * that disagrees with the server's) reads as the freshest rung rather than as a
 * negative, and a stamp that will not parse reads as `null` so the caller drops
 * the node instead of printing `NaN`.
 *
 * @param {string} iso
 * @param {number} [now] epoch ms — injected by the tests, never by the app
 * @returns {{key: string, arg: number, absolute: string}|null}
 */
export function feedTime(iso, now = Date.now()) {
  return timeLadder(iso, now, TIME_RUNGS_THREE);
}

/** The local calendar day of an instant, as `YYYY-MM-DD` (§4 L1 `data-day`). */
export function dayOf(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A day group's heading: two relative names from the catalogue, and every other
 * day an **absolute** date the script localises — there is no sentence to
 * translate there, only a date to format (§4 L1).
 *
 * @param {string} day `YYYY-MM-DD`
 * @param {number} now epoch ms
 * @param {string} lang `en` | `zh`
 * @returns {{text: string|null, key: string|null, kind: "today"|"yesterday"|"absolute"}}
 */
export function dayLabel(day, now = Date.now(), lang = "en") {
  if (day === dayOf(new Date(now).toISOString())) return { text: null, key: "activity.day.today", kind: "today" };
  if (day === dayOf(new Date(now - DAY).toISOString())) return { text: null, key: "activity.day.yesterday", kind: "yesterday" };
  const [year, month, date] = day.split("-").map(Number);
  const at = new Date(year, (month ?? 1) - 1, date ?? 1);
  const text = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(at);
  return { text, key: null, kind: "absolute" };
}

/* -------------------------------------------------------------- admission */

/**
 * The kind/verb/group a `task_updated` row carries, or `null` when its `fields`
 * name nothing a reader can see (§3.3).
 *
 * @param {{fields?: string[]}|null|undefined} changes
 */
export function kindOfTaskUpdated(changes) {
  const fields = Array.isArray(changes?.fields) ? changes.fields : [];
  for (const field of fields) {
    const kind = TASK_UPDATED_KINDS[field];
    if (kind) return { ...kind, group: "meta" };
  }
  return null;
}

/**
 * The kind/verb/group of an admitted row, or `null` when the event is noise.
 *
 * @param {{event?: string, changes?: object}|null|undefined} activity
 */
export function kindOf(activity) {
  const event = activity?.event ?? "";
  if (event === "task_updated") return kindOfTaskUpdated(activity?.changes);
  return ADMITTED_EVENTS[event] ?? null;
}

/**
 * One audit row → one feed row, or `null` when it is not admitted (§3.2/§3.3).
 *
 * The task's own identifier and title come from the board's loaded set — the
 * audit row carries a `task_id`, and a row whose task is not on this board is
 * dropped rather than rendered with a made-up name.
 *
 * @param {{id: string, task_id?: string, actor_kind?: string, actor_id?: string, event?: string, changes?: object, created_at?: string}} activity
 * @param {{identifier: string, title: string}|null|undefined} task
 */
export function rowFrom(activity, task) {
  const kind = kindOf(activity);
  if (kind === null) return null;
  if (!task || !activity?.created_at) return null;
  return {
    id: activity.id,
    taskId: activity.task_id ?? "",
    identifier: task.identifier,
    title: task.title,
    actor: activity.actor_id ?? "",
    // `task_activities.actor_kind` is a free string (the audit log's own column),
    // and since 0018 a kind names a platform rather than a category -- so the
    // two-valued attribute is derived, not read off.
    actorKind: kindLabel(activity.actor_kind),
    event: kind.kind,
    verb: kind.verb,
    group: kind.group,
    changes: activity.changes ?? {},
    at: activity.created_at,
  };
}

/** task id → `{identifier, title}`, the lookup every row is resolved through. */
export function taskIndex(tasks) {
  return new Map((Array.isArray(tasks) ? tasks : []).map((task) => [task.id, task]));
}

/**
 * The admitted feed, newest first. Ordering is by instant and then by row id, so
 * two rows stamped the same second keep a stable order across re-reads.
 *
 * @param {object[]} activities wire rows (`GET /tasks/:ref/activities`)
 * @param {object[]} tasks the board's loaded tasks
 */
export function feedRows(activities, tasks) {
  const index = taskIndex(tasks);
  const rows = [];
  for (const activity of Array.isArray(activities) ? activities : []) {
    const row = rowFrom(activity, index.get(activity?.task_id));
    if (row !== null) rows.push(row);
  }
  return rows.sort((a, b) => (a.at === b.at ? String(b.id).localeCompare(String(a.id)) : a.at < b.at ? 1 : -1));
}

/* ----------------------------------------------------------------- folding */

const distance = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime());

/** Is this row one the burst rule may fold with its neighbour? */
function foldable(row) {
  return BURST_KINDS.includes(row.event);
}

/**
 * §5 / §3.3 — the two folds, applied to a newest-first row list:
 *
 *   * **create → self-claim.** A claim that follows its own task's creation, by
 *     the same actor, inside the window, changes no external fact: it becomes a
 *     second line on the created row rather than a row of its own (§3.3, last
 *     entry). The *older* row (the creation) survives, because it is the one
 *     that carries the task's arrival.
 *   * **field edits.** Two or more field-edit rows by the same actor on the same
 *     task inside the window fold into one burst row, whose instant is the
 *     newest member's and whose group is `meta`.
 *
 * @param {object[]} rows newest first
 * @param {number} [windowMs]
 * @returns {object[]} items — a plain row, or a row plus `burst: {count, items}`
 */
export function foldBursts(rows, windowMs = BURST_WINDOW_MS) {
  const merged = mergeSelfClaims(rows, windowMs);
  const items = [];
  for (const row of merged) {
    const previous = items.at(-1);
    const members = previous === undefined ? null : previous.burst ? previous.burst.items : [previous];
    // The window is measured from the *last* member, so a run of edits folds
    // into one row however many there are, and a gap longer than the window
    // opens a new row instead of dragging a stale one along.
    const opens =
      previous === undefined ||
      !foldable(row) ||
      previous.actor !== row.actor ||
      previous.taskId !== row.taskId ||
      !foldable(members.at(-1)) ||
      distance(members.at(-1).at, row.at) > windowMs;
    if (opens) {
      items.push({ ...row });
      continue;
    }
    const next = [...members, row];
    // The folded row states the *newest* member's instant and family (§5): it is
    // a marker for the run, not one of the edits inside it.
    previous.burst = { count: next.length, items: next };
    previous.event = "meta";
    previous.verb = "updated";
    previous.group = "meta";
  }
  return items;
}

/** The create → self-claim merge, before the field-edit fold. */
function mergeSelfClaims(rows, windowMs) {
  /** @type {object[]} */
  const kept = [];
  for (const row of rows) {
    const newer = kept.at(-1);
    if (
      newer !== undefined &&
      row.event === "created" &&
      newer.event === "claimed" &&
      newer.actor === row.actor &&
      newer.taskId === row.taskId &&
      distance(newer.at, row.at) <= windowMs
    ) {
      // The claim folds into the creation, and the *creation* is the row that
      // survives (it is newer in the ledger's sense: it is what brought the task
      // into being). The claim's own instant is kept on the extra line.
      kept[kept.length - 1] = {
        ...row,
        extra: [{ ...newer, event: "claimed", verb: "claimed", group: "meta" }],
      };
      continue;
    }
    kept.push({ ...row });
  }
  return kept;
}

/**
 * The row's change lines — what `[data-activity-detail]` unfolds.
 *
 * Each line is `{field, kind}` (a catalogue key for the field label) plus either
 * a `value` string, a `transition` (`from`/`to`, rendered with the status dots
 * the board already has), or a `tokens` list (labels). Nothing here is invented:
 * a value the audit row does not carry simply is not rendered.
 *
 * @param {object} item a row or burst item
 */
export function changeLines(item) {
  const changes = item.changes ?? {};
  switch (item.event) {
    case "status": {
      const lines = [];
      if (changes.from && changes.to) lines.push({ field: "activity.detail.status", kind: "status", transition: { from: changes.from, to: changes.to } });
      if (changes.awaitingReason) lines.push({ field: "activity.detail.reason", kind: "status", value: String(changes.awaitingReason) });
      return lines;
    }
    case "archived":
      return changes.from
        ? [{ field: "activity.detail.archived", kind: "status", value: String(changes.from) }]
        : [];
    case "delivery": {
      const lines = [{ field: "activity.detail.delivery", kind: "delivery", value: `Round ${changes.round ?? changes.deliveryRound ?? ""}`.trim() }];
      if (changes.reason) lines.push({ field: "activity.detail.reason", kind: "delivery", value: String(changes.reason) });
      return lines;
    }
    case "comment":
      return [{ field: "activity.detail.comment", kind: "comment", value: String(changes.kind ?? "") }];
    case "created":
      return [{ field: "activity.detail.created", kind: "created", value: String(changes.identifier ?? item.identifier) }];
    case "claimed":
      return [{ field: "activity.detail.claimed", kind: "claimed", transition: { from: changes.from ?? "", to: changes.to ?? "" } }];
    case "relation":
      return [{ field: "activity.detail.relation", kind: "relation", value: `${changes.type ?? ""} ${changes.target ?? ""}`.trim() }];
    case "attachment":
      return [{ field: "activity.detail.attachment", kind: "attachment", value: String(changes.filename ?? "") }];
    case "label":
      return [{ field: "activity.detail.labels", kind: "label", tokens: (changes.labels ?? []).map((entry) => `+ ${entry.displayName ?? entry.norm ?? ""}`) }];
    case "assignee":
      return [{ field: "activity.detail.assignee", kind: "assignee", value: (changes.dictionaries ?? []).map((entry) => entry.displayName ?? "").join(", ") }];
    default:
      return [{ field: "activity.detail.changes", kind: item.event, value: (changes.fields ?? []).join(", ") }];
  }
}

/* ------------------------------------------------------------- selection */

/**
 * §6 — the three filters, ANDed, plus the sidebar's assignee narrowing.
 *
 * A row passes the actor filter on its actor's kind, the event filter on its
 * group, and the task filter on the identifier it names. `all` in any slot is
 * the un-filtered state, not a value to compare.
 *
 * `assignee` is **not** one of B26's three controls: it is the board's own
 * assignee value, written by the sidebar roster and the board bar. The activity
 * view reads it as a fourth, ANDed condition — a row survives when the **actor
 * it already shows** passes the condition (`actorMatches`). The feed's `actor`
 * slot and this clause can both narrow at once; two conditions on one axis AND,
 * which is the only reading that does not silently drop one of them.
 *
 * @param {object[]} items
 * @param {{actor?: string, event?: string, task?: string, assignee?: string, assigneeMe?: string}} filters
 */
export function filterItems(items, filters = {}) {
  const actor = filters.actor ?? "all";
  const event = filters.event ?? "all";
  const task = filters.task ?? "all";
  const assignee = filters.assignee ?? "all";
  return items.filter((item) => {
    if (actor !== "all" && item.actorKind !== actor) return false;
    if (event !== "all" && item.group !== event) return false;
    if (task !== "all" && item.identifier !== task) return false;
    if (!actorMatches(assignee, item.actor, item.actorKind, filters.assigneeMe)) return false;
    return true;
  });
}

/** The distinct task identifiers the feed can be narrowed to, newest first. */
export function taskOptions(items) {
  const seen = new Map();
  for (const item of items) if (!seen.has(item.identifier)) seen.set(item.identifier, { identifier: item.identifier, title: item.title });
  return [...seen.values()];
}

/**
 * §4 L1 — fold the feed into day groups, newest day first, each group holding
 * the rows of that one calendar day in the order they arrived.
 *
 * @param {object[]} items
 * @param {string} [lang]
 * @param {number} [now]
 */
export function groupByDay(items, lang = "en", now = Date.now()) {
  /** @type {Map<string, object>} */
  const groups = new Map();
  for (const item of items) {
    const day = dayOf(item.at);
    if (!groups.has(day)) groups.set(day, { day, items: [], ...dayLabel(day, now, lang) });
    groups.get(day).items.push(item);
  }
  return [...groups.values()];
}

/**
 * §8 — which empty state the feed shows, if any. The two are mutually exclusive:
 * the project-level one means *no admissible event has ever happened*, the
 * filter one means *there are events, none of them match*.
 *
 * @returns {"project"|"filter"|null}
 */
export function emptyKind(admissible, shown) {
  if (admissible === 0) return "project";
  if (shown === 0) return "filter";
  return null;
}

/**
 * The unread reading (§4 / §6): the rows the reader has not seen yet, by the
 * instant the ledger was last read to.
 *
 * A row is unread when its instant is **strictly newer** than `seenAt`; with no
 * stored instant (a first visit) every row is new, which is the honest reading —
 * the reader has seen none of them. A burst is unread when any member is, and it
 * counts once, because the count is rows.
 *
 * @param {object[]} items
 * @param {string|null} seenAt
 */
export function markUnread(items, seenAt) {
  const unread = new Set();
  for (const item of items) {
    const members = item.burst ? item.burst.items : [item];
    if (members.some((member) => seenAt === null || member.at > seenAt)) unread.add(item.id);
  }
  return unread;
}

/**
 * The whole feed, derived. The view calls this once per render and paints the
 * result; every rule above lands here in one place.
 *
 * @param {{
 *   activities: object[],
 *   tasks: object[],
 *   filters?: {actor?: string, event?: string, task?: string, assignee?: string, assigneeMe?: string},
 *   seenAt?: string|null,
 *   page?: number,
 *   lang?: string,
 *   now?: number,
 *   windowMs?: number,
 * }} input
 */
export function buildFeed(input) {
  const now = input.now ?? Date.now();
  const filters = input.filters ?? {};
  const rows = feedRows(input.activities, input.tasks);
  const all = foldBursts(rows, input.windowMs ?? BURST_WINDOW_MS).map((item) => ({ ...item, stamp: feedTime(item.at, now) }));
  const matched = filterItems(all, filters);
  const groups = groupByDay(matched, input.lang ?? "en", now);

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const dayCount = Math.max(1, Math.floor(input.pageSize ?? DAY_PAGE_SIZE));
  const visibleDays = groups.slice(0, page * dayCount);
  const shownItems = visibleDays.flatMap((group) => group.items);
  const unread = markUnread(shownItems, input.seenAt ?? null);

  // §4 — **one** boundary for the feed: it sits inside the day group that holds
  // it, directly after the last unread row, so "everything above this line is new"
  // is true of the whole ledger and survives a filter that hides some of the rows
  // it describes. (A boundary per day group would repeat the sentence for every
  // day the reader had not opened, which says nothing the first one does not.)
  const lastUnread = shownItems.reduce((found, item) => (unread.has(item.id) ? item.id : found), null);
  const days = visibleDays.map((group, index) => ({
    ...group,
    // `[data-activity-page]` — which page of day groups unfolded this one: the
    // first page is `1`, everything `Load older` revealed is `2` and up (§6).
    page: Math.floor(index / dayCount) + 1,
    boundary: lastUnread === null ? -1 : group.items.findIndex((item) => item.id === lastUnread),
  }));

  return {
    rows,
    items: all,
    days,
    shown: shownItems.length,
    admissible: all.length,
    unread,
    unreadCount: unread.size,
    emptyKind: emptyKind(all.length, shownItems.length),
    hasMore: groups.length > visibleDays.length,
    taskOptions: taskOptions(all),
  };
}
