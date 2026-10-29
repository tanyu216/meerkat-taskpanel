/**
 * The Acceptance tab's projection: a card's frozen criteria joined to a
 * delivery report's verdicts.
 *
 * The drawer renders two different things that the same word used to cover
 * (`drawer.tab.acceptance`):
 *
 *   * the card's **criteria** — `task.acceptance`, the immutable baseline
 *     seeded at creation (`acceptance_revision` is its version);
 *   * a report's **verdicts** — `report.acceptance[]`, `{text, status, note}`,
 *     which exist only once a delivery has happened (from `in_review` on).
 *
 * Rendering only the second made a `todo` card's tab always look empty. This
 * module is the one place the two are joined, as a pure function, so the
 * ordering and the pairing can be asserted without a browser.
 *
 * **The matching rule is the core's** (`src/core/domain/acceptance.mjs`):
 * normalised text — NFKC, one space for every whitespace run, trimmed, then
 * case-folded — because neither the baseline nor a report carries a stable
 * criterion id. A reworded criterion is a different criterion; there is no
 * fuzzy matching. The frontend keeps a copy instead of importing `src/`,
 * because the board and the engine are separate trees; the two must agree.
 *
 * Pure: no `node:` specifiers, no DOM, no clock.
 */

/** The UI-only face of a criterion the report has not answered. */
export const PENDING_STATUS = "pending";

/** Report statuses, worst last — the order duplicate rows are merged by. */
const STATUS_RANK = Object.freeze({ met: 0, not_applicable: 1, partial: 2, not_met: 3 });

/** Canonical display text: NFKC, one space per whitespace run, trimmed. */
export function normalizeAcceptanceText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** The match key: the display text case-folded. */
export function acceptanceKey(value) {
  return normalizeAcceptanceText(value).toLowerCase();
}

/** A criterion's display text, from the wire's `string[]` or a `{text}` legacy entry. */
function textOf(value) {
  if (typeof value === "string") return normalizeAcceptanceText(value);
  if (value !== null && typeof value === "object" && typeof value.text === "string") {
    return normalizeAcceptanceText(value.text);
  }
  return "";
}

/**
 * Merge duplicate report rows by key: the worst status wins, and the first
 * non-empty note/text survives. A report is not supposed to repeat a criterion,
 * but a stored one may, and the tab must not show two rows for one item.
 *
 * @param {unknown[]} reportItems
 * @returns {Map<string, {text: string, status: string, note: string}>}
 */
function verdictsByKey(reportItems) {
  const byKey = new Map();
  for (const item of Array.isArray(reportItems) ? reportItems : []) {
    if (item === null || typeof item !== "object") continue;
    const text = textOf(item);
    if (text === "") continue;
    const key = acceptanceKey(text);
    const status = typeof item.status === "string" ? item.status : "";
    const note = typeof item.note === "string" ? item.note : "";
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, { text, status, note });
      continue;
    }
    const rank = (value) => (value in STATUS_RANK ? STATUS_RANK[value] : -1);
    byKey.set(key, {
      text: prior.text,
      status: rank(status) > rank(prior.status) ? status : prior.status,
      note: prior.note || note,
    });
  }
  return byKey;
}

/**
 * Join the card's criteria to a report's verdicts.
 *
 * Every criterion comes first, in the card's own order, carrying the card's
 * spelling. One the report answered is `paired`; one it did not is
 * `status: "pending"`. Report rows that answer no criterion are appended after
 * the criteria (`extra: true`) — a verdict is a fact and must not disappear
 * because the baseline changed under it.
 *
 * @param {unknown[]} criteria `task.acceptance`
 * @param {unknown[]} reportItems `report.acceptance`
 * @returns {{id: string, text: string, status: string, note: string, paired: boolean, extra: boolean}[]}
 */
export function acceptanceRowsFor(criteria, reportItems) {
  const verdicts = verdictsByKey(reportItems);
  const rows = [];
  const seen = new Set();
  for (const value of Array.isArray(criteria) ? criteria : []) {
    const text = textOf(value);
    if (text === "") continue;
    const key = acceptanceKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = verdicts.get(key);
    if (verdict !== undefined) verdicts.delete(key);
    rows.push({
      id: `criterion-${rows.length}`,
      text,
      status: verdict?.status || PENDING_STATUS,
      note: verdict?.note ?? "",
      paired: verdict !== undefined,
      extra: false,
    });
  }
  for (const [key, verdict] of verdicts) {
    rows.push({
      id: `verdict-${key}`,
      text: verdict.text,
      status: verdict.status,
      note: verdict.note,
      paired: true,
      extra: true,
    });
  }
  return rows;
}
