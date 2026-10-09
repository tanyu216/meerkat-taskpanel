/**
 * i18n parity for the app's own catalogue (F5).
 *
 * Two things are checked, both browser-free:
 *
 *   1. **The runtime copy is the contract copy.** `web/src/i18n/catalogue.mjs`
 *      is a byte-identical copy of `test/web/i18n.catalogue.mjs` (which is itself
 *      pinned to `prototype/app.js` by its own suite). Copying is unavoidable —
 *      `web/` may not import `test/` — so a test proves they still agree.
 *   2. **Every hook the app authors resolves.** Each static `data-i18n*="key"`
 *      and each static `t("key")` in `web/src/**` must resolve in the catalogue
 *      or in `extra.mjs` (the new M6b strings the frozen catalogue lacks), and
 *      `extra.mjs` must itself keep en/zh key parity.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CATALOGUE as APP_CATALOGUE, tableFor as appTable } from "../../web/src/i18n/catalogue.mjs";
import { EXTRA } from "../../web/src/i18n/extra.mjs";
import { CATALOGUE as CONTRACT_CATALOGUE } from "./i18n.catalogue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../web/src");

/** Every `.vue` / `.js` file under `web/src`, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".vue") || name.endsWith(".js")) out.push(path);
  }
  return out;
}

const RESOLVES = new Set([
  ...Object.keys(APP_CATALOGUE.en),
  ...Object.keys(EXTRA.en),
]);

describe("web/i18n — the runtime catalogue is the contract catalogue", () => {
  it("is a deep-equal copy", () => {
    assert.deepEqual(APP_CATALOGUE, CONTRACT_CATALOGUE);
  });

  it("keeps en/zh key parity and order", () => {
    const en = Object.keys(APP_CATALOGUE.en);
    const zh = Object.keys(APP_CATALOGUE.zh);
    assert.deepEqual(en, zh);
    assert.ok(en.length > 0);
  });
});

describe("web/i18n — the extra table keeps the same parity contract", () => {
  it("mirrors en and zh key for key", () => {
    assert.deepEqual(Object.keys(EXTRA.en).sort(), Object.keys(EXTRA.zh).sort());
    for (const [key, value] of Object.entries(EXTRA.en)) {
      assert.equal(typeof value, "string");
      assert.notEqual(value.trim(), "", `extra.en.${key} is empty`);
      assert.equal([...value.matchAll(/%s/g)].length, [...EXTRA.zh[key].matchAll(/%s/g)].length, `%s count differs for ${key}`);
    }
  });

  it("does not shadow a catalogue key (extra is only for new states)", () => {
    for (const key of Object.keys(EXTRA.en)) {
      assert.equal(Object.prototype.hasOwnProperty.call(APP_CATALOGUE.en, key), false, `extra redefines catalogue key ${key}`);
    }
  });
});

describe("web/i18n — every authored hook resolves", () => {
  it("resolves each static data-i18n* and t() key in web/src", (t) => {
    const files = sourceFiles(SRC);
    const hooks = new Map(); // key -> [file:line]
    const staticT = new Map();

    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const rel = path.slice(SRC.length + 1);
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="([^"]*)"/g)) {
          // A bound-but-literal hook (`:data-i18n="'key'"`) normalises to the key;
          // a genuinely dynamic one (a backtick template with `${…}`) is skipped.
          const raw = match[1].replace(/^['"]|['"]$/g, "");
          if (raw === "" || raw.includes("${")) continue;
          hooks.set(raw, `${rel}:${index + 1}`);
        }
        for (const match of line.matchAll(/\bt\(\s*"([^"]+)"/g)) {
          staticT.set(match[1], `${rel}:${index + 1}`);
        }
      });
    }

    t.diagnostic(`scanned ${files.length} source files: ${hooks.size} data-i18n hooks, ${staticT.size} static t() calls`);

    const dangling = [];
    for (const [key, where] of [...hooks, ...staticT]) {
      if (!RESOLVES.has(key)) dangling.push(`${key} (${where})`);
    }
    assert.deepEqual(dangling, [], `keys with no translation: ${dangling.join(", ")}`);
  });
});

describe("web/i18n — the lookup helper is shared", () => {
  it("exposes the same table from the runtime copy", () => {
    assert.equal(appTable("de"), APP_CATALOGUE.en);
    assert.equal(appTable("zh"), APP_CATALOGUE.zh);
  });
});
