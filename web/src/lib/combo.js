/**
 * Combobox matching + rosters (B22/B24/B25) — the pure half.
 *
 * The prototype drives five controls (assignee, reporter, parent, depends-on,
 * labels, plus the drawer's label family) from one implementation. The
 * behaviour that matters is a pure function of a list and a query, so it lives
 * here, browser-free and unit-testable, and the Vue component only renders what
 * these functions return.
 *
 * Matching (`matchEntries`): case-insensitive, ranked **prefix → contains →
 * subsequence**, with the seed order preserved inside each bucket. Fuzzy is only
 * consulted for an entry that neither starts with nor contains the needle, so
 * nothing fuzzy ever outranks a real prefix or contains.
 *
 * Rosters (`createRoster`): an ordered map. `put` trims, ignores blanks and keys
 * case-insensitively while **keeping the first spelling** — which is what makes
 * `bug` / `Bug` / `bug ` one label whose displayed spelling never flip-flops.
 * Growth happens only through `upsert` (use). There is no remove, rename or
 * merge: the roster entry point is a *use*, never a management surface (C10).
 */

/** The normalisation key: trim, then lowercase. Never touches the display spelling. */
export function rosterKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

/** True when `needle` is a subsequence of `hay` (chars matched in order). */
export function subsequence(needle, hay) {
  if (needle.length === 0) return true;
  let at = 0;
  for (let i = 0; i < hay.length && at < needle.length; i++) {
    if (hay[i] === needle[at]) at += 1;
  }
  return at === needle.length;
}

/**
 * Rank `entries` against `query`, preserving seed order within each bucket.
 *
 * @param {{name: string, keys?: string[]}[]} entries
 * @param {string} query
 * @returns {Array}
 */
export function matchEntries(entries, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "") return entries.slice();
  const starts = [];
  const contains = [];
  const fuzzy = [];
  for (const entry of entries) {
    const keys = (entry.keys ?? [entry.name]).map((k) => String(k ?? "").toLowerCase());
    const startsHit = keys.some((k) => k.indexOf(needle) === 0);
    const containsHit = keys.some((k) => k.indexOf(needle) > 0);
    if (startsHit) starts.push(entry);
    else if (containsHit) contains.push(entry);
    else if (keys.some((k) => subsequence(needle, k))) fuzzy.push(entry);
  }
  return starts.concat(contains, fuzzy);
}

/**
 * An ordered, keyed roster of names.
 *
 * @param {string[]} [seed]
 */
export function createRoster(seed = []) {
  /** @type {Map<string, {name: string, keys?: string[], [key: string]: unknown}>} */
  const byKey = new Map();
  const order = [];

  const put = (entry) => {
    const name = String(entry?.name ?? entry ?? "").trim();
    if (name === "") return null;
    const key = rosterKey(name);
    const existing = byKey.get(key);
    if (existing) return existing; // keep the first spelling, keep the first position
    const record = typeof entry === "object" ? { ...entry, name } : { name };
    byKey.set(key, record);
    order.push(key);
    return record;
  };

  for (const entry of seed) put(entry);

  return {
    get: (name) => byKey.get(rosterKey(name)) ?? null,
    has: (name) => byKey.has(rosterKey(name)),
    put,
    /** The only growth path: use a name and it joins the roster (adopting the first spelling). */
    upsert: (name, extra) => put(typeof extra === "object" ? { ...extra, name } : { name }),
    all: () => order.map((key) => byKey.get(key)),
    match(query) {
      return matchEntries(this.all(), query);
    },
  };
}

/**
 * The option list a combobox should show: the `· new` row (only for free-text
 * controls, when something is typed that the roster does not already hold)
 * prepended to the real matches.
 *
 * @param {{roster: ReturnType<typeof createRoster>, query: string, freeText?: boolean, chosen?: string[]}} input
 * @returns {{entries: object[], isNew: boolean}}
 */
export function comboOptions({ roster, query, freeText = true, chosen = [] }) {
  const typed = String(query ?? "").trim();
  const chosenKeys = new Set(chosen.map(rosterKey));
  const matches = roster.match(typed).filter((entry) => !chosenKeys.has(rosterKey(entry.name)));
  const exact = roster.get(typed);
  const isNew = freeText && typed !== "" && !exact && !chosenKeys.has(rosterKey(typed));
  return { entries: matches, isNew, typed };
}
