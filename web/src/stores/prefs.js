/**
 * Client preferences (M6b · F5).
 *
 * Two keys, both browser-local, both defaulting to their lightest value:
 *
 *   meerkat-taskpanel.theme   "light" | "dark" | "auto"   (default "light")
 *   meerkat-taskpanel.lang    "en" | "zh"                 (default "en")
 *
 * Nothing else is persisted, and nothing is sent anywhere. `applyTheme` and
 * `applyLang` are the *only* writers, and each mirrors its value onto the
 * document so the contract's `html[data-theme]` / `html[data-theme-mode]` /
 * `html[lang]` hold:
 *
 *   html[data-theme]       "meerkat-taskpanel" | "dark" | "auto"   — what the CSS reads
 *   html[data-theme-mode]  "light" | "dark" | "auto"       — the mode in force
 *
 * `auto` is resolved entirely by CSS (`@media (prefers-color-scheme: dark)`),
 * never by script — so `applyTheme` writes the mode, not the resolved colour,
 * and the source contains no `matchMedia` call (the browser's media-query
 * emulation then covers it too).
 *
 * The theme is a **three-state cycle**, not a toggle: light → dark → auto →
 * light.
 */

/** The three theme modes, in cycle order. */
export const THEME_MODES = Object.freeze(["light", "dark", "auto"]);
export const DEFAULT_THEME = "light";
export const THEME_STORAGE_KEY = "meerkat-taskpanel.theme";

/** The two shipped languages. */
export const LANGS = Object.freeze(["en", "zh"]);
export const DEFAULT_LANG = "en";
export const LANG_STORAGE_KEY = "meerkat-taskpanel.lang";

/** `data-theme` values, keyed by `data-theme-mode`. Different vocabulary, on purpose. */
const THEME_DOC = Object.freeze({ light: "meerkat-taskpanel", dark: "dark", auto: "auto" });

/** The mode one press of the theme cell reaches (light → dark → auto → light). */
export function nextTheme(mode) {
  const at = THEME_MODES.indexOf(mode);
  return THEME_MODES[(at + 1) % THEME_MODES.length];
}

/** The language one press of the language control reaches (en ⇄ zh). */
export function nextLang(value) {
  const at = LANGS.indexOf(value);
  return LANGS[(at + 1) % LANGS.length];
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
 * Read the persisted language, falling back to `en`.
 *
 * @param {Pick<Storage, "getItem">} [storage]
 * @returns {"en"|"zh"}
 */
export function readLang(storage = globalThis.localStorage) {
  const stored = storage?.getItem(LANG_STORAGE_KEY);
  return LANGS.includes(stored) ? stored : DEFAULT_LANG;
}

/**
 * Write the theme mode onto the document and persist it. The single writer.
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
