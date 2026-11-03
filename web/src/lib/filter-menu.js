/**
 * The assignee and label filter menus' pure half (B04).
 *
 * Both controls are still the `<details class="dropdown">` family R15 ② built;
 * what this module owns is **which rows the menu shows**, given the control's
 * value and a search query. The ranking is `combo.js`'s `matchEntries` — the
 * matcher the drawer's comboboxes already use — so a typed prefix never loses
 * to a fuzzy match, and seed order is preserved inside each bucket.
 *
 * Two row classes:
 *
 *   * **pinned** — the assignee control's four static values
 *     (`all | me | human | agent`) and the label control's `all`. They are
 *     always first, in the order the caller passes, and a query never hides
 *     them (acceptance item 3).
 *   * **matched** — actors, or existing labels, ranked by the query. The
 *     assignee control shows the one named value its roster press wrote even
 *     while the query is empty; otherwise an empty query shows no actor rows,
 *     which is what keeps the resting `[data-assignee-filter-option]` count at
 *     four. Labels are always shown while the query is empty — the label menu
 *     has no named-on-demand row.
 *
 * There is deliberately no "new" row: the label control is a filter over the
 * board's existing labels, never a management surface (acceptance item 4).
 */

import { matchEntries, rosterKey } from "./combo.js";

/** An actor roster entry's display name, from a wire row or a bare string. */
function displayName(entry) {
  return String(entry?.display_name ?? entry ?? "").trim();
}

/**
 * The caller's active language. Passing `t` in keeps the module free of the
 * i18n runtime's reactive store; the component's `t()` already tracks the
 * language ref, so a `computed` over this call re-renders on a switch.
 */
function row(t, key, ...args) {
  return t(key, ...args);
}

/**
 * The assignee menu's rows: pinned static values, then ranked matching actors.
 *
 * @param {{
 *   staticValues: readonly string[],
 *   actors?: readonly (string|{display_name?: string})[],
 *   named?: string|null,
 *   query?: string,
 *   t: (key: string, ...args: unknown[]) => string,
 * }} input
 * @returns {{value: string, text: string, pinned: boolean}[]}
 */
export function assigneeMenuRows({ staticValues, actors = [], named = null, query = "", t }) {
  const pinned = staticValues.map((value) => ({
    value,
    text: row(t, `filters.assignee.${value}`),
    pinned: true,
  }));

  const staticKeys = new Set(staticValues.map(rosterKey));
  const namedName = String(named ?? "").trim();
  const namedKey = namedName === "" ? null : rosterKey(namedName);

  // The static values are pinned *and* excluded from the actor domain: an actor
  // called `human` (or `All`) is the four-row category, not a second row.
  const seen = new Set(staticKeys);
  const entries = [];
  const push = (name) => {
    const key = rosterKey(name);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    entries.push({ name });
  };
  for (const actor of actors) push(displayName(actor));
  // The named value is a row on its own even when the roster does not hold it
  // (a card may name an actor the dictionary has not returned). When the roster
  // does hold it, `push` is a no-op and the row is not duplicated.
  if (namedKey !== null) push(namedName);

  const needle = String(query ?? "").trim();
  const matched =
    needle === ""
      ? entries.filter((entry) => namedKey !== null && rosterKey(entry.name) === namedKey)
      : matchEntries(entries, needle);

  return pinned.concat(
    matched.map((entry) => ({
      value: entry.name,
      text: row(t, "filters.assigneeOption", entry.name),
      pinned: false,
    })),
  );
}

/**
 * The label menu's rows: `All` pinned, then the existing labels ranked by query.
 *
 * @param {{
 *   labels?: readonly (string|{display_name?: string})[],
 *   query?: string,
 *   t: (key: string, ...args: unknown[]) => string,
 * }} input
 * @returns {{value: string, text: string, pinned: boolean}[]}
 */
export function labelMenuRows({ labels = [], query = "", t }) {
  const pinned = [{ value: "all", text: row(t, "filters.label.all"), pinned: true }];
  const seen = new Set(["all"]);
  const entries = [];
  for (const label of labels) {
    const name = displayName(label);
    const key = rosterKey(name);
    // A label literally called `all` would share the pinned row's value and be
    // indistinguishable from "no label filter", so it is the pinned row.
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    entries.push({ name });
  }

  const needle = String(query ?? "").trim();
  const matched = needle === "" ? entries : matchEntries(entries, needle);

  return pinned.concat(
    matched.map((entry) => ({
      value: entry.name,
      text: row(t, "filters.labelOption", entry.name),
      pinned: false,
    })),
  );
}

/**
 * The index a query puts the highlight on: the first row the query actually
 * filtered to, or `-1` when every row is pinned (nothing to pick but the fixed
 * categories).
 *
 * @param {{pinned?: boolean}[]} rows
 */
export function firstUnpinnedIndex(rows) {
  return rows.findIndex((row) => !row.pinned);
}

/**
 * Move a highlight index by `delta` over `total` rows, wrapping at both ends.
 * From "nowhere" (`-1`) a down move starts at the first row and an up move at
 * the last.
 *
 * @param {number} index
 * @param {number} delta
 * @param {number} total
 */
export function moveActive(index, delta, total) {
  if (total <= 0) return -1;
  if (index < 0) return delta < 0 ? total - 1 : 0;
  return (index + delta + total) % total;
}
