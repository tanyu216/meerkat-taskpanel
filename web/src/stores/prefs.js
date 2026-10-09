/**
 * Theme preference store (M6b · F5).
 *
 * Three-state cycle `light → dark → auto → light`, persisted under
 * `taskpanel.theme` and mirrored onto the document as (B01's contract):
 *
 *   html[data-theme]       "taskpanel" | "dark" | "auto"   — what the CSS reads
 *   html[data-theme-mode]  "light" | "dark" | "auto"       — the mode in force
 *
 * `auto` is resolved entirely by CSS (`@media (prefers-color-scheme: dark)`),
 * never by script — so `applyTheme` writes the mode, not the resolved colour.
 * Nothing reads or writes storage beyond these two keys.
 */

export const THEME_MODES = Object.freeze(["light", "dark", "auto"]);
export const DEFAULT_THEME = "light";
export const THEME_STORAGE_KEY = "taskpanel.theme";
export const LANG_STORAGE_KEY = "taskpanel.lang";

/** `data-theme` values, keyed by `data-theme-mode`. Different vocabulary, on purpose. */
const THEME_DOC = Object.freeze({ light: "taskpanel", dark: "dark", auto: "auto" });

/** The mode one press of the theme cell reaches (light → dark → auto → light). */
export function nextTheme(mode) {
  const at = THEME_MODES.indexOf(mode);
  return THEME_MODES[(at + 1) % THEME_MODES.length];
}

/**
 * Read the persisted theme, falling back to the default for anything unknown.
 *
 * @param {Pick<Storage, "getItem">} [storage] defaults to `globalThis.localStorage`
 * @returns {"light"|"dark"|"auto"}
 */
export function readTheme(storage = globalThis.localStorage) {
  const stored = storage?.getItem(THEME_STORAGE_KEY);
  return THEME_MODES.includes(stored) ? stored : DEFAULT_THEME;
}

/**
 * Write the mode onto the document and persist it. The single writer.
 *
 * @param {"light"|"dark"|"auto"} mode
 * @param {Pick<Storage, "setItem">} [storage]
 */
export function applyTheme(mode, storage = globalThis.localStorage) {
  const next = THEME_MODES.includes(mode) ? mode : DEFAULT_THEME;
  const root = globalThis.document?.documentElement;
  if (root) {
    root.setAttribute("data-theme", THEME_DOC[next]);
    root.setAttribute("data-theme-mode", next);
  }
  storage?.setItem(THEME_STORAGE_KEY, next);
  return next;
}
