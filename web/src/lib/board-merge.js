/**
 * Merge the board's supplementary active read into its main page.
 *
 * The board's primary read (`board=1&limit=500`) already carries every active
 * card when the project has 500 or fewer of them. When it has more, the store
 * fetches the non-terminal set separately; the two lists overlap, and the
 * primary one is the page the reader is looking at. So the rule is:
 *
 *   - the primary page's order is the board's order and is never re-sorted;
 *   - duplicates are dropped by `id` (the wire's identity), first occurrence wins;
 *   - only cards the page does not carry are appended, in supplement order.
 *
 * Pure and Vue-free, so the ordering rule can be tested without a browser.
 *
 * @template {{id: string}} T
 * @param {T[]} [page] the primary read's cards
 * @param {T[]} [supplement] the supplementary read's cards
 * @returns {T[]} a new array
 */
export function mergeById(page = [], supplement = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(page ?? []), ...(supplement ?? [])]) {
    if (item === null || item === undefined) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}
