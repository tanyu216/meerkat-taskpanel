/**
 * The list view's own data plane (TP-0094).
 *
 * The board and the list stopped sharing one reading when the board became a
 * **working set** (TP-0092: every active card plus the newest terminals, capped
 * at 500). The list therefore pages the server: `limit=200&offset=N` over the
 * filtered set, keeping the weight order. Its state is deliberately separate
 * from `board.tasks`, because paging the list must never change what the
 * waiting queue, the acceptance queue or the activity feed read.
 *
 * Filtering is pushed to the server, so pages are cut from the **filtered**
 * set — the same mapping the board's client-side filters use, expressed in the
 * query `/api/v1/tasks` accepts (`q`, `priority`, repeated `status`, `label`,
 * `assignee` / `assignee_kind`). The one exception is `priority=none`: it is the
 * priority control's display band for an unset value, the column is NOT NULL
 * with a four-value CHECK, so no stored card can carry it. `loadFirst()` answers
 * it with an empty result instead of a request the server would refuse.
 *
 * `offset` advances by the rows the server **returned**, not by the deduped
 * display length: a weight order can drift between requests, and counting the
 * deduped length would make the cursor lag and re-fetch forever. The display
 * list still dedupes by id (`lib/board-merge.js`).
 *
 * Vue's `watch` is a component concern here, as in the other stores: the view
 * owns the watchers and calls `loadFirst` / `reset` / `scheduleSearchLoad`.
 */

import { computed, reactive } from "vue";

import { mergeById } from "../lib/board-merge.js";
import { api } from "../services/api.js";
import { AWAITING, assigneeFilterValue, board, ME, statusFilterValues } from "./board.js";
import { view } from "./ui.js";

/** One page of the list. */
export const LIST_PAGE = 200;

/** The search box's debounce, in milliseconds (the card freezes 250). */
export const SEARCH_DEBOUNCE_MS = 250;

/** @type {{tasks: object[], total: number, offset: number, loading: boolean, loaded: boolean, loadingMore: boolean, error: Error|null}} */
export const list = reactive({
  tasks: [],
  total: 0,
  /** How many rows the server has been asked past — the cursor. */
  offset: 0,
  /** The first page is in flight (the skeleton's signal). */
  loading: false,
  /** Has a first page landed for the current scope? */
  loaded: false,
  /** A later page is in flight; the rows stay on screen. */
  loadingMore: false,
  /** This store's own failure — never `board.error`, which owns the page banner. */
  error: null,
});

/** Is there another page to fetch? `offset` is the raw server cursor. */
export const more = computed(() => list.offset < list.total);

/**
 * The server's status list for the board's status filter.
 *
 * The board's control offers the seven **stage** statuses; an `awaiting` card
 * keeps its stage (`in_progress`) but its own `status` is the overlay. Selecting
 * `in_progress` therefore asks the server for both, exactly as `stageOf` buckets
 * them client-side. The other statuses are sent as they are.
 *
 * @returns {string[]}
 */
function serverStatuses() {
  const statuses = statusFilterValues();
  if (statuses.length === 0) return [];
  return statuses.includes("in_progress") && !statuses.includes(AWAITING)
    ? [...statuses, AWAITING]
    : statuses;
}

/**
 * `board.filters` → the `/api/v1/tasks` query the list sends.
 *
 * One spelling per condition: `me` resolves to the local human's name, the two
 * categorical values go to `assignee_kind`, and any other value is a given name
 * sent to `assignee`. `all` is omitted rather than special-cased.
 *
 * @returns {Record<string, string|number|string[]>}
 */
export function queryFor() {
  const { search, priority, label } = board.filters;
  const query = { include_archived: 0 };

  const q = String(search ?? "").trim();
  if (q !== "") query.q = q;
  // `none` cannot match a stored row (see the module note); `loadFirst`
  // short-circuits it rather than sending a value the server refuses.
  if (priority !== "all" && priority !== "none") query.priority = priority;
  if (label !== "all") query.label = label;

  const statuses = serverStatuses();
  if (statuses.length > 0) query.status = statuses;

  const assignee = assigneeFilterValue();
  if (assignee === "me") query.assignee = ME;
  else if (assignee === "human" || assignee === "agent") query.assignee_kind = assignee;
  else if (assignee !== "all") query.assignee = assignee;

  return query;
}

/** Which read owns the store; a newer read (or a reset) invalidates an older one. */
let loadToken = 0;
/** The pending search debounce, if any. */
let searchTimer = null;

/**
 * Empty the store and invalidate every in-flight read.
 *
 * A filter change, a project switch or leaving the view all use this before the
 * next read, so a response for the old scope can never paint over the new one.
 */
export function reset() {
  loadToken += 1;
  list.tasks = [];
  list.total = 0;
  list.offset = 0;
  list.loading = false;
  list.loaded = false;
  list.loadingMore = false;
  list.error = null;
}

/**
 * Read the first page of the current scope.
 *
 * @returns {Promise<void>}
 */
export async function loadFirst() {
  const projectId = board.currentProjectId;
  const token = ++loadToken;
  if (!projectId) {
    list.tasks = [];
    list.total = 0;
    list.offset = 0;
    list.loaded = true;
    list.loading = false;
    list.error = null;
    return;
  }

  list.loading = true;
  list.loadingMore = false;
  list.error = null;

  if (board.filters.priority === "none") {
    // The display band for "no priority"; the column cannot hold it, so the
    // honest answer is empty — no request, no error.
    list.tasks = [];
    list.total = 0;
    list.offset = 0;
    list.loaded = true;
    list.loading = false;
    return;
  }

  try {
    const data = await api.tasks({
      project_id: projectId,
      limit: LIST_PAGE,
      offset: 0,
      ...queryFor(),
    });
    if (token !== loadToken || board.currentProjectId !== projectId) return;
    const tasks = data.tasks ?? [];
    list.tasks = tasks;
    list.total = Number.isInteger(data.total) ? data.total : tasks.length;
    list.offset = tasks.length;
    list.loaded = true;
    list.error = null;
  } catch (err) {
    if (token === loadToken && board.currentProjectId === projectId) list.error = err;
    throw err;
  } finally {
    if (token === loadToken) list.loading = false;
  }
}

/**
 * Read the next page and append the rows the list does not already hold.
 *
 * @returns {Promise<void>}
 */
export async function loadMore() {
  if (list.loading || list.loadingMore) return;
  if (list.offset >= list.total) return;
  const projectId = board.currentProjectId;
  if (!projectId || board.filters.priority === "none") return;

  const token = loadToken;
  list.loadingMore = true;
  list.error = null;
  try {
    const data = await api.tasks({
      project_id: projectId,
      limit: LIST_PAGE,
      offset: list.offset,
      ...queryFor(),
    });
    if (token !== loadToken || board.currentProjectId !== projectId) return;
    const page = data.tasks ?? [];
    list.tasks = mergeById(list.tasks, page);
    if (Number.isInteger(data.total)) list.total = data.total;
    // The cursor counts what the server returned, not what survived dedupe.
    list.offset += page.length;
  } catch (err) {
    if (token === loadToken) list.error = err;
    throw err;
  } finally {
    if (token === loadToken) list.loadingMore = false;
  }
}

/**
 * Schedule the debounced reload a search keystroke asks for.
 *
 * Only the list view owns this timer: on the board the search is a client-side
 * filter over the working set, and a keystroke must not start a server read.
 * The timer is restarted on every keystroke, and a timer that fires after the
 * reader left the list is dropped.
 */
export function scheduleSearchLoad() {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  if (view.value !== "list") return;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    if (view.value !== "list") return;
    reset();
    loadFirst().catch(() => {
      // The failure is on `list.error`; the list surface carries it.
    });
  }, SEARCH_DEBOUNCE_MS);
}
