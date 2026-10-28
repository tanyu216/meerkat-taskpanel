/**
 * The create dialog's acceptance preselect — the client's copy of the server's
 * resolution (`src/core/domain/acceptance-mode.mjs`; the web cannot import
 * `src/`, so `test/web/acceptance-default.test.mjs` holds the two in step).
 *
 * The rules, in the server's order:
 *
 *   * a concrete project value is the default;
 *   * project `auto` (or an unreadable value) falls back to **agent** — a card
 *     nobody declared is reviewed;
 *   * `human` is opt-in, and **top-level only**: a card being given a parent is
 *     never preselected human, because the mode is a closure gate a person
 *     exercises on a card they own, not on a subtask.
 */

/** The three values a card stores; `auto` is a project word. */
export const ACCEPTANCE_MODES = Object.freeze(["off", "agent", "human"]);

/** What an unresolved card falls back to. */
export const FALLBACK_ACCEPTANCE = "agent";

/**
 * @param {unknown} projectAcceptance the selected project's `acceptance`
 * @param {{hasParent?: boolean}} [options] whether the card is being given a parent
 * @returns {"off"|"agent"|"human"}
 */
export function defaultAcceptanceMode(projectAcceptance, options = {}) {
  const project = String(projectAcceptance ?? "").trim().toLowerCase();
  if (project === "off") return "off";
  if (project === "agent") return "agent";
  if (project === "human") return options.hasParent === true ? FALLBACK_ACCEPTANCE : "human";
  // `auto`, empty, and anything the board would not accept.
  return FALLBACK_ACCEPTANCE;
}
