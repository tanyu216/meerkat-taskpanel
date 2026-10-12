/**
 * B26 · the Activity view's state (R12x).
 *
 * The view answers "what happened in this project, and what is new to me", and
 * this module is where its two halves come from:
 *
 *   * **The ledger** — every admitted activity of the current project, newest
 *     first. `GET /tasks/:ref/activities` is M6a's only audit read: it is scoped
 *     to one card, so the project-wide ledger is read by fanning out over the
 *     board's own task list (bounded pool) and **merging**. That is a deliberate
 *     choice of the frozen API: no project-level activities route exists, and
 *     this card may not add one (its boundary is the implementation). The cost is
 *     one small read per card, paid once per view entry, and the store keeps what
 *     it has read, so re-entering the view re-reads only what the stream has not
 *     already handed it. A project-wide route in M6 replaces the fan-out without
 *     changing anything above this module.
 *   * **The live tail** — the board's own SSE stream already delivers every
 *     activity as it happens (`stores/board.js` → `absorb`), so a card that moves
 *     after the backfill lands in the feed without a second connection.
 *
 * Unread is a **local** fact (design §4: "未读语义只存本地", §17 leaves the
 * persistence question open). It is one instant — `seenAt`, the ledger's read
 * cursor — persisted beside the theme and the language, and every row newer than
 * it is new. With no stored cursor (a first visit) every row is new, which is the
 * honest reading: the reader has seen none of them. One writer (`markAllRead`)
 * moves the cursor, so the pill, the boundary and the boundary's count can never
 * disagree (§6).
 */
import { computed, reactive } from "vue";

import { ACTOR_VALUES, EVENT_VALUES, buildFeed } from "../lib/activity-feed.js";
import { lang } from "../i18n/index.js";
import { api } from "../services/api.js";

import { board, onActivityStream } from "./board.js";

/** The read cursor's storage key — the same browser-local surface theme/lang use. */
export const ACTIVITY_SEEN_KEY = "meerkat-taskpanel.activitySeen";

/** How many per-card audit reads are in flight at once during a backfill. */
const POOL = 8;
/** The per-card read cap. The ledger's first pages live far inside it. */
const PER_TASK_LIMIT = 50;

/** Read the persisted read cursor, or `null` when this browser has never read. */
export function readSeen(storage = globalThis.localStorage) {
  const stored = storage?.getItem(ACTIVITY_SEEN_KEY);
  return typeof stored === "string" && stored !== "" ? stored : null;
}

/** Persist the read cursor (the single writer's storage half). */
export function writeSeen(value, storage = globalThis.localStorage) {
  if (value === null) storage?.removeItem(ACTIVITY_SEEN_KEY);
  else storage?.setItem(ACTIVITY_SEEN_KEY, value);
  return value;
}

/** @type {{entries: object[], loading: boolean, loaded: boolean, error: unknown, filters: {actor: string, event: string, task: string}, page: number, seenAt: string|null, projectId: string|null}} */
export const activity = reactive({
  entries: [],
  loading: false,
  loaded: false,
  error: null,
  filters: { actor: "all", event: "all", task: "all" },
  page: 1,
  seenAt: readSeen(),
  /** Which project the entries belong to — a project switch invalidates them. */
  projectId: null,
});

/**
 * The whole derivation: admission, folding, day grouping, filtering and the
 * unread split. The view paints this and nothing else, so every rule in
 * `lib/activity-feed.js` reaches the DOM through one value.
 */
export const feed = computed(() =>
  buildFeed({
    activities: activity.entries,
    tasks: board.tasks,
    filters: activity.filters,
    seenAt: activity.seenAt,
    page: activity.page,
    lang: lang.value,
  }),
);

/** The unread rows the reader can currently see — one number, three readers (§6). */
export const unreadCount = computed(() => feed.value.unreadCount);

/** Write one of the three filters. The domain is fixed, so an unknown value is refused. */
export function writeActivityFilter(name, value) {
  if (name === "actor" && ACTOR_VALUES.includes(value)) activity.filters.actor = value;
  else if (name === "event" && EVENT_VALUES.includes(value)) activity.filters.event = value;
  else if (name === "task" && typeof value === "string" && value !== "") activity.filters.task = value;
  activity.page = 1;
}

/** Back to all three `all` — the reset button and the filter-empty state's own button. */
export function resetActivityFilters() {
  activity.filters = { actor: "all", event: "all", task: "all" };
  activity.page = 1;
}

/** `Load older` — unfold the next page of day groups. */
export function loadOlder() {
  if (!feed.value.hasMore) return false;
  activity.page += 1;
  return true;
}

/* ------------------------------------------------------------- the address */

/** The three slots, in the order the address writes them (§6). */
export const HASH_SLOTS = Object.freeze(["actor", "event", "task"]);

/**
 * The feed's address for the current filters: `#/activity?actor=agent`, with the
 * `all` slots left out. A pure string builder, so the test can assert the shape
 * without a `location`.
 */
export function activityHash(filters = activity.filters) {
  const params = HASH_SLOTS.filter((slot) => (filters[slot] ?? "all") !== "all")
    .map((slot) => `${slot}=${encodeURIComponent(filters[slot])}`)
    .join("&");
  return `#/activity${params === "" ? "" : `?${params}`}`;
}

/**
 * §6 — mirror the filters onto the address bar with `replaceState`, so a narrowed
 * feed is shareable and survives a reload. `replaceState` (never `pushState`) is
 * what keeps the back button meaning "the view before", and the hook never
 * touches `#/task/<id>`, which is the drawer's own path.
 */
export function writeActivityHash(location = globalThis.location, history = globalThis.history) {
  if (!location || typeof history?.replaceState !== "function") return null;
  const hash = activityHash();
  if (location.hash === hash) return hash;
  history.replaceState(null, "", hash);
  return hash;
}

/**
 * Read a `#/activity?…` address back into the filters — a shared link, a reload.
 * Returns whether anything was applied; an address that is not the feed's (a
 * `#/task/…` from the drawer, say) is left alone.
 */
export function readActivityHash(hash = globalThis.location?.hash ?? "") {
  if (typeof hash !== "string" || !hash.startsWith("#/activity")) return false;
  /** Does this view understand the slot/value pair? (`task` takes any identifier.) */
  const accepted = (key, value) =>
    key === "task" || (key === "actor" ? ACTOR_VALUES : key === "event" ? EVENT_VALUES : []).includes(value);

  let seen = false;
  for (const pair of hash.slice("#/activity".length).replace(/^\?/, "").split("&")) {
    if (pair === "") continue;
    const [rawKey, rawValue] = pair.split("=");
    const key = decodeURIComponent(rawKey ?? "");
    const value = decodeURIComponent(rawValue ?? "");
    if (value === "" || !accepted(key, value)) continue;
    writeActivityFilter(key, value);
    seen = true;
  }
  return seen;
}

/**
 * `Mark all read` — move the cursor past every admitted row, so the boundary, its
 * count and the sidebar pill all reach zero together (§6). Nothing else changes:
 * the feed is not re-read and no row is removed.
 */
export function markAllRead() {
  const newest = feed.value.items.reduce((latest, item) => (latest === null || item.at > latest ? item.at : latest), null);
  if (newest === null) return null;
  activity.seenAt = writeSeen(newest);
  return newest;
}

/** Take one activity off the live stream into the ledger (deduped by id). */
export function absorb(entry) {
  if (!entry?.id) return;
  if (activity.entries.some((known) => known.id === entry.id)) return;
  activity.entries = [...activity.entries, entry];
}

/* The tail: every activity the board's stream receives lands in the ledger, so a
 * card that moves while the reader is on another view is already in the feed by
 * the time they open it — no second connection, no second poll. */
onActivityStream(absorb);

/** Drop everything and forget the project the entries came from. */
export function resetActivity() {
  activity.entries = [];
  activity.loaded = false;
  activity.page = 1;
  activity.projectId = null;
  activity.error = null;
}

/**
 * Backfill the ledger for the current project.
 *
 * Idempotent per project: entering the view again with entries already read for
 * this project resolves immediately, so a view switch never re-issues the
 * fan-out. A project switch invalidates and re-reads. Per-card failures are
 * swallowed — one unreadable card must not blank the ledger — and the view's
 * empty state is what says whether anything came back.
 */
export async function loadActivities() {
  const projectId = board.currentProjectId;
  if (projectId === null || projectId === undefined) {
    resetActivity();
    return activity.entries;
  }
  if (activity.loaded && activity.projectId === projectId) return activity.entries;
  if (activity.projectId !== projectId) {
    activity.entries = [];
    activity.page = 1;
  }
  activity.projectId = projectId;
  activity.loading = true;
  activity.error = null;
  try {
    const tasks = board.tasks.filter((task) => task.project_id === projectId);
    const collected = [];
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(POOL, queue.length) }, async () => {
      for (;;) {
        const task = queue.shift();
        if (task === undefined) return;
        try {
          const data = await api.taskActivities(task.identifier, { limit: PER_TASK_LIMIT });
          collected.push(...(data.activities ?? []));
        } catch {
          /* one card's trail is not the ledger; the others still load */
        }
      }
    });
    await Promise.all(workers);
    // The stream may have delivered rows while the fan-out was in flight; the
    // merge is by id, so nothing is counted twice and nothing is lost.
    const byId = new Map(activity.entries.map((entry) => [entry.id, entry]));
    for (const entry of collected) if (!byId.has(entry.id)) byId.set(entry.id, entry);
    activity.entries = [...byId.values()];
    // A read taken while the board is still loading its task list sees a partial
    // project; marking that memoised would leave a project switch showing an
    // empty ledger until the next entry. Leave `loaded` false so the read that
    // arrives *with* the tasks re-runs; a project that genuinely owns no card
    // settles on `loaded` the moment the board stops loading.
    activity.loaded = !board.loading;
  } catch (err) {
    activity.error = err;
    throw err;
  } finally {
    activity.loading = false;
  }
  return activity.entries;
}
