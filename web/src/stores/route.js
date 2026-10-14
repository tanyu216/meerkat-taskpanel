/**
 * R16 · the router — the two writers and the one reader (DESIGN.md §32.3).
 *
 * `lib/route.js` is the table and the pure functions over it; this module is the
 * only thing in the app that touches the address. It has exactly three entry
 * points, and the split between them is the round's whole rule:
 *
 *   * **`navigate(view)`** — a view change — **`pushState`**. Every view-switching
 *     press goes through it: the sidebar's nav, the top bar's toggle. A press whose
 *     target address is *already* the current one writes nothing (the idempotence
 *     the feed's filter writer has had since R12x), so a no-op press leaves no
 *     history entry. The feed row's task anchor is *not* one of these: F2 made it
 *     open the drawer in place, so the view — and this writer — never sees it.
 *   * **`replaceActivityQuery()`** — a filter change — and it lives with the
 *     filters it writes (`stores/activity.js`): `replaceState`, path and fragment
 *     preserved. That is what makes back/forward undo **view changes only** and
 *     never filter changes.
 *   * **`applyLocation()`** — the reader — **never writes history**. It is shared
 *     by the two events that both mean "an address arrived": the first load (a
 *     deep link, a refresh) and `popstate` (back and forward). One code path, so
 *     a deep link and a back press cannot drift apart.
 *
 * `history.state` carries nothing: the address is the whole truth, and a state
 * payload would be a second source able to disagree with it.
 *
 * Why here and not in `stores/ui.js` (the contract's suggested home for
 * `setView`'s successor): this module needs the feed's filters, and `ui.js` is
 * imported by `stores/board.js`, which `stores/activity.js` imports — putting
 * `navigate()` in `ui.js` would close that cycle. The responsibility split the
 * contract fixes (two writers, one reader, the mirror written only by the reader)
 * is unchanged; only the file that hosts the writers moved.
 */
import { activityQuery, isView, legacyActivityQuery, pathFor, readActivityQuery, routeFor } from "../lib/route.js";

import { activity, applyActivityQuery } from "./activity.js";
import { mirrorView, view } from "./ui.js";

/** `history.replaceState` for the reader's normalisations — a no-op without a
 *  `history` (a bare `node --test` run, a fixture with no window). */
function replace(history, target) {
  if (typeof history?.replaceState === "function") history.replaceState(null, "", target);
}

/**
 * §4.5 — writer A. Move to a view, and write the address that means it.
 *
 * The target is the view's **canonical address**, which for the feed is its path
 * *plus the filters the store is holding*: leaving the feed and coming back must
 * land on the same narrowed ledger the reader left ("the filters live in the
 * store and are there again on return", §4.6), and the address is what a reload
 * reads them from. The drawer's fragment is not part of it — a view's address is
 * its path, and the fragment is the drawer's own slot (§4.4).
 *
 * @param {"board"|"list"|"activity"|"waiting"} next
 * @returns {string} the view in force after the call
 */
export function navigate(next, location = globalThis.location, history = globalThis.history) {
  if (!isView(next)) return view.value;
  const target = pathFor(next) + (next === "activity" ? activityQuery(activity.filters) : "");
  const current = `${location?.pathname ?? ""}${location?.search ?? ""}`;
  if (target !== current && typeof history?.pushState === "function") history.pushState(null, "", target);
  mirrorView(next);
  return next;
}

/**
 * §4.3 — the reader: an address arrived (a deep link, a refresh, or a back /
 * forward press). Resolve it to a view and, for the feed, to its filters.
 *
 * Order, and each step is a rule rather than an implementation detail:
 *
 *   1. the path decides the view (the trailing slashes the server strips are
 *      stripped here too, because the browser still shows them);
 *   2. `routeFor().canonical` — a non-`null` answer means the address is one of
 *      the four landings that are not routes (`/`, `/index.html`, a trailing
 *      slash, anything unknown): the view is the board's and the address is
 *      **replaced** with the canonical path. The fragment rides along untouched
 *      — that is what keeps a deep-linked `#/task/<id>` drawer link pointing at
 *      the same card (§4.3 step 3, C13);
 *   3. the one exception to (2) is the **old feed address** (§4.4): an alias path
 *      whose fragment is `#/activity…`. The fragment *is* the payload, so the
 *      view is the feed's, the filters come from it, and the address is replaced
 *      with the query form — the fragment is consumed, and the write path never
 *      produces the old shape again. An old share link keeps working;
 *   4. on the feed, the filters land exactly as the address states them: a slot
 *      the address does not name is `all`, which is also why a refresh cannot
 *      lose the filters and a back press cannot leave stale ones (§4.6).
 *
 * @returns {string} the view in force after the call
 */
export function applyLocation(location = globalThis.location, history = globalThis.history) {
  const pathname = location?.pathname ?? "/";
  const search = location?.search ?? "";
  const hash = location?.hash ?? "";
  const route = routeFor(pathname);

  // §4.4 — the legacy read is scoped to the aliases on purpose: the drawer's
  // `#/task/<id>` also arrives as a fragment, and a route that is *not* an alias
  // may legitimately carry it.
  const legacy = route.alias ? legacyActivityQuery(hash) : null;
  if (legacy !== null) {
    const query = activityQuery(readActivityQuery(legacy).filters);
    mirrorView("activity");
    applyActivityQuery(query);
    replace(history, pathFor("activity") + query);
    return "activity";
  }

  mirrorView(route.view);
  if (route.view === "activity") applyActivityQuery(search);

  if (route.canonical !== null) {
    // The feed's query is part of its address and rides with it; the other
    // views have no query namespace this round, so their own is dropped (§4.7).
    replace(history, route.canonical + (route.view === "activity" ? search : "") + hash);
  }
  return route.view;
}

