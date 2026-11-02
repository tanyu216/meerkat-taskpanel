/**
 * The create dialog's acceptance preselect.
 *
 * There is no project-level default any more: a new card starts on `auto`, and
 * the creator states `off` or `human` from the card's own context. The web
 * cannot import `src/`, so the fallback word is repeated here;
 * `test/web/acceptance-default.test.mjs` holds it in step with the domain.
 */

/** The three values a card stores — declared once in `board-enums.js`. */
export { ACCEPTANCE_MODES } from "./board-enums.js";

/** What an unresolved card falls back to. */
export const FALLBACK_ACCEPTANCE = "auto";

/**
 * @returns {"off"|"auto"|"human"}
 */
export function defaultAcceptanceMode() {
  return FALLBACK_ACCEPTANCE;
}
