/**
 * B09 · the drawer's relation-area projections (TP-0075).
 *
 * The Relations section used to be three read-only kind groups plus a
 * multi-chip `depends_on` control. It is now four explicit groups — Parent,
 * Children, Depends on, Related — each one row per card (identifier + title).
 * The epic's whole descendant tree arrives from the server
 * (`GET /tasks/:ref/relations` → `descendants`), because the browser's roster is
 * one page and the drawer must not page it to find a grandchild.
 *
 * The projections live here, pure and Vue-free, for the same reason
 * `lib/acceptance.js` and `lib/attachments.js` do: the ordering, the fallbacks
 * and the empty predicate are decisions worth asserting without a browser. The
 * **walk** stays on the server — `descendantRows` preserves the order the route
 * answered and never re-walks a graph the client cannot see.
 */

/**
 * The card's kind as the badge's vocabulary: an `epic` shows Epic; every other
 * card — an ordinary `task`, and a review card (which is also `kind=task`) —
 * shows Task. An absent kind reads as the default, like the column's own.
 *
 * @param {unknown} kind
 * @returns {"epic"|"task"}
 */
export function detailKind(kind) {
  return kind === "epic" ? "epic" : "task";
}

/** One card as the relation rows render it, with the raw id as the identifier fallback. */
function cardRow(id, lookup) {
  const card = typeof lookup === "function" ? lookup(id) : null;
  return {
    id: String(id ?? ""),
    identifier: String(card?.identifier ?? id ?? ""),
    title: String(card?.title ?? ""),
  };
}

/**
 * The epic's descendant rows, in the server's breadth-first order (both
 * children before a grandchild). A row the server sent without an identifier
 * falls back to its id; a missing title is `""` — the identifier still names the
 * card, which is the half that never disappears.
 *
 * @param {unknown} rows the `descendants` half of the relations read
 * @returns {{id: string, identifier: string, title: string}[]}
 */
export function descendantRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row?.id ?? ""),
    identifier: String(row?.identifier ?? row?.id ?? ""),
    title: String(row?.title ?? ""),
  }));
}

/**
 * The card's one parent, from the `parent` edges pointing **at** it (source =
 * parent, target = this card). A `parent` edge in the other direction is this
 * card's child and belongs to the descendants group, not here.
 *
 * @param {unknown} relations the `relations` half of the read
 * @param {string} taskId
 * @param {(id: string) => {identifier?: string, title?: string}|undefined} lookup
 * @returns {{id: string, identifier: string, title: string}|null}
 */
export function parentRowOf(relations, taskId, lookup) {
  const edge = (Array.isArray(relations) ? relations : []).find(
    (row) => row?.type === "parent" && row.target === taskId && row.source,
  );
  return edge ? cardRow(edge.source, lookup) : null;
}

/**
 * The card's `related` edges, either end, as id + title rows. `key` is the
 * relation id, so the renderer has a stable key for a label that is not unique.
 *
 * @param {unknown} relations
 * @param {string} taskId
 * @param {(id: string) => {identifier?: string, title?: string}|undefined} lookup
 * @returns {{key: unknown, id: string, identifier: string, title: string}[]}
 */
export function relatedRowsOf(relations, taskId, lookup) {
  return (Array.isArray(relations) ? relations : [])
    .filter((row) => row?.type === "related")
    .map((row) => ({
      key: row.id,
      ...cardRow(row.source === taskId ? row.target : row.source, lookup),
    }));
}

/**
 * Is the whole Relations area empty? True only when there is no parent, no
 * descendant, no dependency and no related edge — the four groups' data, not
 * their containers. The Depends-on group always renders (it owns the add box),
 * so the predicate is about what the card has, never what is on screen.
 *
 * @param {{parent?: object|null, children?: unknown[], depends?: unknown[], related?: unknown[]}} [groups]
 * @returns {boolean}
 */
export function relationsEmptyOf(groups = {}) {
  const { parent = null, children = [], depends = [], related = [] } = groups;
  return parent === null && children.length === 0 && depends.length === 0 && related.length === 0;
}
