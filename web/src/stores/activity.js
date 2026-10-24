/**
 * B26 · the Activity view's state (R12x).
 *
 * The view answers "what happened in this project, and what is new to me", and
 * this module is where its two halves come from:
 *
 *   * **The ledger** — every admitted activity of the current project, newest
 *     first. `GET /activities` returns the board-wide audit trail in one read;
 *     the feed scopes it to the board's own task set (the current project), so
 *     another project's rows are dropped at derivation, not at the read. The
 *     store keeps what it has read, so re-entering the view re-reads only what
 *     the stream has not already handed it.
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
import { activityQuery, readActivityQuery } from "../lib/route.js";
import { lang } from "../i18n/index.js";
import { api } from "../services/api.js";

import { assigneeFilterValue, board, ME, onActivityStream } from "./board.js";

/** The read cursor's storage key — the same browser-local surface theme/lang use. */
export const ACTIVITY_SEEN_KEY = "meerkat-taskpanel.activitySeen";

/**
 * The ledger's backfill cap — one board-wide page, newest first. The route's
 * own ceiling is 1000; the feed's "Load older" pages inside what was read.
 */
const LEDGER_LIMIT = 1_000;

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
    // The board's own assignee value joins the three activity slots: the
    // sidebar roster writes it, and this view is one of the surfaces it
    // narrows (`design/fidelity-r13.md` §10.1 extended across views).
    filters: { ...activity.filters, assignee: assigneeFilterValue(), assigneeMe: ME },
    seenAt: activity.seenAt,
    page: activity.page,
    lang: lang.value,
  }),
);

/** The unread rows the reader can currently see — one number, three readers (§6). */
export const unreadCount = computed(() => feed.value.unreadCount);

/**
 * §8 — the project-level empty state, and the one word the raw derivation cannot
 * supply on its own: *has anything ever happened here?* `buildFeed` sees only the
 * entries it was handed, so until the first read lands every project looks
 * admissible-empty — which is how a ledger that had simply not been read yet came
 * to announce itself with the answer for a project that never had an event. The
 * view asks for the pair: the derivation says nothing is admissible, **and** the
 * ledger has been read (`activity.loaded`, the same flag that makes the read
 * memoised per project). Before that the view shows neither empty state — a
 * ledger that has not been read is not a finding, and the design's own static
 * document is explicit that both ship `hidden` (§8).
 */
export const projectEmpty = computed(() => feed.value.emptyKind === "project" && activity.loaded);

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

/**
 * R16 §4.2 — writer B: mirror the filters onto the address bar with
 * `replaceState`, so a narrowed feed is shareable and survives a reload.
 *
 * The carrier moved from the fragment to the query (`/activity?actor=agent`) —
 * the fragment is the drawer's own slot and must stay free for `#/task/<id>`
 * (§4.4) — and the payload's four rules moved with it, unchanged: the fixed slot
 * order, `all` never written, the whole query omitted when all three are at rest,
 * and a value outside its domain never written. `lib/route.js` builds and parses
 * the string; this writer is the only thing that touches `location`.
 *
 * `replaceState` (never `pushState`) is what keeps the back button meaning "the
 * view before" — so **back and forward undo view changes and never undo filter
 * changes** — and the path and the fragment are preserved verbatim, which is what
 * keeps the drawer's `#/task/<id>` off this writer's account.
 *
 * A writer whose target address is already the current one writes nothing: the
 * same idempotence the fragment writer had, and what keeps a re-press of the
 * chosen filter row out of the history.
 */
export function replaceActivityQuery(location = globalThis.location, history = globalThis.history) {
  if (!location || typeof history?.replaceState !== "function") return null;
  const query = activityQuery(activity.filters);
  if ((location.search ?? "") === query) return query;
  history.replaceState(null, "", `${location.pathname ?? ""}${query}${location.hash ?? ""}`);
  return query;
}

/**
 * §4.6 — the reader's feed half: land the three filters exactly as the address
 * states them. A slot the address does not name is `all`, which is also what the
 * literal `all` and an out-of-domain value mean, so an address that names nothing
 * is not "leave the filters alone" but "no condition anywhere" — "a refresh does
 * not lose the filters" and "a back press does not leave stale ones" are the same
 * rule. It never writes history: `stores/route.js` owns that, and the address is
 * what the reader is reading.
 *
 * @param {string} source a query (`?actor=agent`) or the old fragment's payload
 * @returns {boolean} whether the address named any condition at all
 */
export function applyActivityQuery(source) {
  const parsed = readActivityQuery(source);
  activity.filters = { ...parsed.filters };
  activity.page = 1;
  return parsed.applied;
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

/**
 * Which fan-out owns the ledger. Two reads can overlap — a project switch starts
 * the next one while the previous project's is still in the air — and only the
 * newest may commit or clear `loading`: a stale `finally` hiding the skeleton
 * mid-read (or a stale merge replacing the new project's rows) is exactly the
 * flash this store must not produce.
 */
let loadToken = 0;

/** Drop everything and forget the project the entries came from. */
export function resetActivity() {
  loadToken += 1;
  activity.entries = [];
  activity.loaded = false;
  activity.loading = false;
  activity.page = 1;
  activity.projectId = null;
  activity.error = null;
}

/**
 * Backfill the ledger for the current project.
 *
 * Idempotent per project: entering the view again with entries already read for
 * this project resolves immediately, so a view switch never re-issues the read.
 * A project switch invalidates and re-reads. One read failure surfaces through
 * `activity.error`; the board-wide response is not split into rows that could
 * fail independently.
 */
export async function loadActivities() {
  const token = ++loadToken;
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
    const data = await api.boardActivities({ limit: LEDGER_LIMIT, order: "desc" });
    // A read the store has already left behind (another project, or a reset) is
    // history: it may not merge into the ledger that replaced it.
    if (token !== loadToken) return activity.entries;
    // The stream may have delivered rows while the read was in flight; the
    // merge is by id, so nothing is counted twice and nothing is lost.
    const byId = new Map(activity.entries.map((entry) => [entry.id, entry]));
    for (const entry of data.activities ?? []) if (!byId.has(entry.id)) byId.set(entry.id, entry);
    activity.entries = [...byId.values()];
    // A read taken while the board is still loading its task list sees a partial
    // project; marking that memoised would leave a project switch showing an
    // empty ledger until the next entry. Leave `loaded` false so the read that
    // arrives *with* the tasks re-runs; a project that genuinely owns no card
    // settles on `loaded` the moment the board stops loading.
    activity.loaded = !board.loading;
  } catch (err) {
    if (token === loadToken) activity.error = err;
    throw err;
  } finally {
    if (token === loadToken) activity.loading = false;
  }
  return activity.entries;
}
