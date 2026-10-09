/**
 * The preference store's pure contract (F5), browser-free.
 *
 * No DOM and no real `localStorage` are needed: `prefs.js` takes its storage as
 * an argument and guards `document`, so a stub is enough to prove the cycle
 * order, the two storage keys, the value domains and the defaults.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_LANG,
  DEFAULT_THEME,
  LANGS,
  LANG_STORAGE_KEY,
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyTheme,
  nextLang,
  nextTheme,
  readLang,
  readTheme,
} from "../../web/src/stores/prefs.js";

/** A tiny in-memory `Storage`. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    written: map,
  };
}

describe("web/theme — the three-state cycle", () => {
  it("cycles light → dark → auto → light", () => {
    assert.deepEqual(THEME_MODES, ["light", "dark", "auto"]);
    assert.equal(nextTheme("light"), "dark");
    assert.equal(nextTheme("dark"), "auto");
    assert.equal(nextTheme("auto"), "light");
  });

  it("wraps after a full cycle", () => {
    let mode = DEFAULT_THEME;
    for (let i = 0; i < 3; i++) mode = nextTheme(mode);
    assert.equal(mode, "light");
  });

  it("is a cycle, not a two-state toggle", () => {
    assert.equal(new Set(THEME_MODES).size, 3);
  });
});

describe("web/theme — storage keys, domains and defaults", () => {
  it("uses the two named keys", () => {
    assert.equal(THEME_STORAGE_KEY, "taskpanel.theme");
    assert.equal(LANG_STORAGE_KEY, "taskpanel.lang");
  });

  it("defaults to light / en with nothing persisted", () => {
    assert.equal(DEFAULT_THEME, "light");
    assert.equal(DEFAULT_LANG, "en");
    assert.equal(readTheme(fakeStorage()), "light");
    assert.equal(readLang(fakeStorage()), "en");
  });

  it("ignores an unknown stored value", () => {
    assert.equal(readTheme(fakeStorage({ [THEME_STORAGE_KEY]: "neon" })), "light");
    assert.equal(readLang(fakeStorage({ [LANG_STORAGE_KEY]: "fr" })), "en");
  });

  it("round-trips a valid value", () => {
    const storage = fakeStorage();
    assert.equal(applyTheme("dark", storage), "dark");
    assert.equal(storage.written.get(THEME_STORAGE_KEY), "dark");
    assert.equal(readTheme(storage), "dark");
  });

  it("coerces an invalid write back to the default", () => {
    const storage = fakeStorage();
    assert.equal(applyTheme("neon", storage), "light");
    assert.equal(storage.written.get(THEME_STORAGE_KEY), "light");
  });
});

describe("web/theme — language cycle", () => {
  it("moves en ⇄ zh", () => {
    assert.deepEqual(LANGS, ["en", "zh"]);
    assert.equal(nextLang("en"), "zh");
    assert.equal(nextLang("zh"), "en");
  });
});
