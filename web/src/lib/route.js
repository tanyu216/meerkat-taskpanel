/**
 * R16 · the address layer — the route table and the pure functions over it.
 *
 * The four destinations the sidebar names (board, list, activity, waiting) were
 * switched by `stores/ui.js`'s `view` ref alone, so nothing outside the tab knew
 * which view was open. This module is the *shape* of the address layer that
 * replaces that: a closed route table, and the pure string functions the two
 * writers and the one reader are built from.
 *
 * Authority: `design/fidelity-r16.md` (the executable contract — §2 path routing,
 * §3 the route table and the four non-route landings, §4 the behaviour) and
 * `design/DESIGN.md` §32 (the same rules in prose). The split it fixes, and this
 * file keeps:
 *
 *   * **Parsing and formatting are pure** and never touch `location` — that is
 *     the precedent `activityHash()` set, and it is what lets the table be
 *     asserted without a browser (`test/web/route.test.mjs`). Everything that
 *     *writes* or *reads* the address lives in `stores/route.js` (the two writers
 *     and the reader) and `stores/activity.js` (the feed's own query writer).
 *   * **The table is the whole table.** Five addresses, matched exactly and
 *     case-sensitively; `/` and `/index.html` are aliases of the board, a matched
 *     route with a trailing slash is normalised, and **any other path** lands on
 *     the board. `/nope` is not an error surface because the server answers 200
 *     for any extensionless path (`src/server/static.mjs`): "no such route" can
 *     only be said in the frontend, and a new surface would contradict the
 *     round's "no visual change" (fidelity-r16 §3, §7.1).
 *   * **One parser for the feed's payload.** The activity slots are read by
 *     `readActivityQuery` whether they arrive as a query (`?actor=agent`) or in
 *     the old fragment form (`#/activity?actor=agent`), so the legacy carrier
 *     cannot grow a second set of domain rules (fidelity-r16 §4.4, B8).
 *
 * The drawer's fragment (`#/task/<id>`) is deliberately absent from every
 * function here: it is not a route, and the router neither reads nor writes it.
 */
import { ACTOR_VALUES, EVENT_VALUES } from "./activity-feed.js";

/** The four views, in the sidebar's own order (`stores/ui.js` binds them). */
export const VIEWS = Object.freeze(["board", "list", "activity", "waiting"]);

/** §3's table, rows 2–5 — the canonical address of each view. */
export const VIEW_ROUTES = Object.freeze({
  board: "/board",
  list: "/list",
  activity: "/activity",
  waiting: "/waiting",
});

/**
 * The two paths that are *aliases* of the board rather than routes of their own:
 * the bare entry point, and Vite's entry file. They matter beyond the table —
 * they are also the only paths today's app could have written the old
 * `#/activity?…` fragment on, which is why the legacy read is scoped to them
 * (§4.4, `legacyActivityQuery`).
 */
const ALIASES = Object.freeze(["/", "/index.html"]);

/** The feed's three slots, in the order the address writes them (§4.6). */
export const ACTIVITY_SLOTS = Object.freeze(["actor", "event", "task"]);

/** The view a route name maps to, or `null` when the name is not a view's. */
export function isView(name) {
  return VIEWS.includes(name);
}

/**
 * The canonical path of a view. An unknown name answers with the board's — the
 * same landing every other unknown input gets (§3), so a caller that forgot to
 * validate cannot invent an address.
 */
export function pathFor(view) {
  return VIEW_ROUTES[view] ?? VIEW_ROUTES.board;
}

/**
 * §3 — the table. `pathname` is matched after the trailing slashes the server
 * itself strips (`src/server/index.mjs`) are stripped here too, because the
 * *browser* still shows them and normalising is the frontend's job (§2, note 3).
 *
 * @param {string} pathname
 * @returns {{view: string, canonical: string|null, alias: boolean}}
 *   `view` is the view the address names; `canonical` is the path the reader
 *   must write back with `replaceState` (path only — the query and fragment are
 *   the caller's to compose), or `null` when the address is already canonical;
 *   `alias` says the path is `/` or `/index.html` rather than a route.
 */
export function routeFor(pathname) {
  const raw = typeof pathname === "string" && pathname !== "" ? pathname : "/";
  const trimmed = raw.replace(/\/+$/, "") || "/";
  const alias = ALIASES.includes(trimmed);
  const view = VIEWS.find((name) => VIEW_ROUTES[name] === trimmed) ?? "board";
  // Already canonical only when the path is a route, spelled exactly, with no
  // trailing slash. Everything else — the aliases, an unknown path, a matched
  // route the browser shows with a slash — is rewritten to `pathFor(view)`.
  const canonical = !alias && VIEW_ROUTES[view] === trimmed && raw === trimmed ? null : VIEW_ROUTES[view];
  return { view, canonical, alias };
}

/* ------------------------------------------------------------- the feed's query */

/** Does this view understand the slot/value pair? `task` takes any identifier. */
function accepts(slot, value) {
  if (slot === "task") return value !== "";
  if (slot === "actor") return ACTOR_VALUES.includes(value);
  if (slot === "event") return EVENT_VALUES.includes(value);
  return false;
}

/** `decodeURIComponent`, but a malformed escape is left as the literal text
 *  rather than thrown: a hand-typed `?actor=%` must not break the boot (§3). */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * §4.6 — the feed's address *for* a set of filters: `?actor=agent`, `""` when all
 * three are at rest. The four rules are the ones the old `activityHash()` had,
 * moved from the fragment to the query: the fixed slot order (`actor` → `event`
 * → `task`), `all` never written, the whole query omitted when every slot is at
 * rest, and no value the slot's domain does not name.
 */
export function activityQuery(filters = {}) {
  const params = ACTIVITY_SLOTS.filter((slot) => (filters?.[slot] ?? "all") !== "all")
    .map((slot) => `${slot}=${encodeURIComponent(filters[slot])}`)
    .join("&");
  return params === "" ? "" : `?${params}`;
}

/**
 * §4.6 — the payload read back into three filters. Returns the **complete** set,
 * because the address is the truth for this slot group: a slot the address does
 * not name is `all`, which is also what an absent slot, the literal `all` and an
 * out-of-domain value all mean. `applied` says whether anything was written —
 * the "is this the feed's payload at all" question, as a `#/task/…` string and a
 * payload of nothing but values we refuse both answer `false`.
 *
 * It reads both carriers: the query form (`?actor=agent`, with or without the
 * `?`) and the old fragment's payload (`actor=agent`). The legacy prefix is
 * stripped if present so a caller may hand it the whole fragment — §4.4's "one
 * parser", not a second set of rules.
 */
export function readActivityQuery(source) {
  const rest = String(source ?? "")
    .replace(/^#\/activity/, "")
    .replace(/^\?/, "");
  const filters = { actor: "all", event: "all", task: "all" };
  let applied = false;
  for (const pair of rest.split("&")) {
    if (pair === "") continue;
    const [rawKey, rawValue] = pair.split("=");
    const slot = decode(rawKey ?? "");
    const value = decode(rawValue ?? "");
    // Repeated slots are applied in the order they appear, so the last accepted
    // value wins — the behaviour the slot-pair walk has always had.
    if (value === "" || !accepts(slot, value)) continue;
    filters[slot] = value;
    applied = true;
  }
  return { filters, applied };
}

/**
 * §4.4 — is this fragment the *old* feed address, and where does its payload
 * start? `null` when it is not (including the drawer's `#/task/<id>`, which the
 * router must not touch), `""` for the bare `#/activity`, `"?…"` for the
 * payload. This only answers *which part of the fragment is the payload*: the
 * domain rules stay in `readActivityQuery`.
 */
export function legacyActivityQuery(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#/activity")) return null;
  const rest = hash.slice("#/activity".length);
  if (rest === "") return "";
  return rest.startsWith("?") ? rest : null;
}
