/**
 * i18n runtime (M6b · F5).
 *
 * A tiny reactive wrapper over the frozen catalogue — no `vue-i18n`, because the
 * runtime is zero-`npm`-dependency beyond Vue itself. The active language is a
 * `ref`; `t()` reads it, so every `computed`/template that calls `t()` re-renders
 * when the language changes. The catalogue itself is pure data and is imported
 * verbatim (`./catalogue.mjs`), so `node --test` can consume the same table the
 * bundle does.
 *
 * The language is mirrored onto `<html lang>` by `applyLang()` (the one writer),
 * and the value is persisted under `taskpanel.lang` (F5). Default `en`.
 */
import { computed, ref } from "vue";

import { CATALOGUE, DEFAULT_LANGUAGE, LANGUAGES, hasKey, tableFor, translate } from "./catalogue.mjs";
import { EXTRA } from "./extra.mjs";
import { LANG_STORAGE_KEY, readLang, nextLang as cycleLang } from "../stores/prefs.js";

export { CATALOGUE, DEFAULT_LANGUAGE, LANGUAGES, EXTRA };

/** The active language. One reactive source of truth for the whole app. */
export const lang = ref(readLang());

/** Resolve a key against the extra table (new M6b states), then the catalogue. */
function resolve(language, key, args) {
  const table = EXTRA[language] ?? EXTRA[DEFAULT_LANGUAGE];
  if (Object.prototype.hasOwnProperty.call(table, key)) {
    let out = table[key];
    for (const arg of args) if (arg !== undefined && arg !== null) out = out.replace("%s", String(arg));
    return out;
  }
  return translate(language, key, ...args);
}

/** `t(key, ...args)` bound to the active language. */
export function t(key, ...args) {
  return resolve(lang.value, key, args);
}

/** A computed accessor for templates that prefer `tt.value`. */
export const tt = computed(() => (key, ...args) => resolve(lang.value, key, args));

/** True when the key resolves in the active language (over the en fallback). */
export function has(key) {
  return (
    Object.prototype.hasOwnProperty.call(EXTRA[lang.value] ?? {}, key) ||
    hasKey(lang.value, key) ||
    hasKey(DEFAULT_LANGUAGE, key)
  );
}

/** The catalogue table for the active language. */
export const table = computed(() => tableFor(lang.value));

/** The next language in the two-entry cycle (en ⇄ zh). */
export function nextLang() {
  return cycleLang(lang.value);
}

/**
 * The single writer: set the active language, mirror it onto `<html lang>` and
 * persist it. Returns the language actually applied.
 *
 * @param {"en"|"zh"} value
 */
export function applyLang(value, storage = globalThis.localStorage) {
  const next = LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE;
  lang.value = next;
  const root = globalThis.document?.documentElement;
  if (root) root.setAttribute("lang", next);
  storage?.setItem(LANG_STORAGE_KEY, next);
  return next;
}
