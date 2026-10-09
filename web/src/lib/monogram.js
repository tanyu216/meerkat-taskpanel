/**
 * Project monogram — the pure half of the sidebar rail (B03).
 *
 * At ≤1023px the sidebar collapses to an icon rail (prototype `tw.css`), and a
 * project row's rail glyph is its name compressed to at most three capitals:
 *
 *   * **multi-word** → the initial of each of the first three words
 *     (`"Site Refresh"` → `"SR"`);
 *   * **single word** → its first three letters (`"Orchestrator"` → `"ORC"`);
 *   * a blank or missing name → `""` (the span still exists; the box is empty).
 *
 * Uppercased either way. Kept out of the component so it can be unit-tested
 * without a browser — the Vue file only renders what this returns.
 */
export function initialsOf(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((word) => word.charAt(0)).join("").toUpperCase();
}
