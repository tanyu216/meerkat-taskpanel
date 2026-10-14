/**
 * Parity and purity gate for the extracted prototype catalogue.
 *
 * `test/web/i18n.catalogue.mjs` is a copy of the prototype's `MESSAGES` object,
 * and the only thing that makes the copy trustworthy is a test that proves it
 * still *is* the prototype's catalogue. So the assertions split three ways:
 *
 *   1. **Internal parity** — `en` and `zh` have identical key sets, identical
 *      key order, no duplicate keys, no empty values, and the same `%s`
 *      placeholders key for key. This half runs everywhere, including the
 *      container image (which does not carry `design/prototype/`).
 *   2. **Against the prototype** — where `design/prototype/app.js` is present, the
 *      suite re-derives `MESSAGES` from that file and requires that the
 *      catalogue is that data minus exactly `PROTOTYPE_ONLY_KEYS` (the B15/B18
 *      demo vocabulary the ruling of 2026-10-12 drops from the implementation),
 *      entry line by entry line and key by key. The exclusions are an explicit
 *      closed list, so the real measured counts and every *shipped* string are
 *      still checked against the source rather than against a number written
 *      down here. `.dockerignore` excludes `design/prototype/`, so this half self-skips
 *      in the image, following the "absent tool ⇒ SKIP, never FAIL" precedent
 *      from `scripts/verify/host-cli.mjs`.
 *   3. **Purity** — the data module imports nothing, touches no global and
 *      cannot be mutated in place, so the frontend build and `node --test`
 *      can both consume it without ordering hazards.
 *
 * Counts are REPORTED, not hardcoded: `node --test` prints the measured en/zh
 * key counts via `t.diagnostic`. See the module header for the recorded
 * numbers and for the `BLOCKS.md` header discrepancy: its line quotes 626 hooks
 * (four of the five `data-i18n*` attributes, the 193 `data-i18n-arg` seats left
 * out) and 282 keys, while the documents measure 819 hooks and 282 prototype
 * `MESSAGES` keys, of which this catalogue ships the 265 that are not
 * prototype-only.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test, { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CATALOGUE,
  DEFAULT_LANGUAGE,
  LANGUAGES,
  hasKey,
  tableFor,
  translate,
} from "./i18n.catalogue.mjs";

const MODULE_PATH = fileURLToPath(new URL("./i18n.catalogue.mjs", import.meta.url));
const ROOT = resolve(dirname(MODULE_PATH), "../..");
const PROTOTYPE_APP = resolve(ROOT, "design/prototype/app.js");
const HAS_PROTOTYPE = existsSync(PROTOTYPE_APP);

const MODULE_SOURCE = readFileSync(MODULE_PATH, "utf8");

/** The count every key-count assertion is measured against, printed once. */
const LANGUAGE_LIST = [...LANGUAGES];

/* ------------------------------------------------------------------ helpers */

/**
 * Returns the text of the object literal starting at the first `{` at or after
 * `from`, brace-matched. String bodies and comments are stepped over so a `{`
 * inside a translated string (or a `/* note *​/`) cannot end the literal early.
 */
function objectLiteralAt(source, from) {
  const start = source.indexOf("{", from);
  assert.notEqual(start, -1, "no object literal found at the requested offset");
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") {
      i += 1;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2);
      if (i === -1) break;
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail("unterminated object literal");
}

/** The `{ en: …, zh: … }` literal embedded in the data module. */
function moduleLiteral() {
  const marker = "export const CATALOGUE = ";
  const at = MODULE_SOURCE.indexOf(marker);
  assert.notEqual(at, -1, "the module no longer exports CATALOGUE as a literal");
  return objectLiteralAt(MODULE_SOURCE, at + marker.length);
}

/**
 * Splits the two language bodies out of a catalogue literal, for text-level
 * checks (duplicate keys) that evaluation would silently collapse.
 */
function languageBodies(literal) {
  const enAt = literal.search(/\n\s*en:\s*\{/);
  const zhAt = literal.search(/\n\s*zh:\s*\{/);
  assert.ok(enAt !== -1 && zhAt !== -1, "catalogue literal must hold en and zh");
  assert.ok(enAt < zhAt, "en must precede zh");
  return { en: literal.slice(enAt, zhAt), zh: literal.slice(zhAt) };
}

/** Every `"key":` occurrence in a body, in source order, duplicates included. */
function keyOccurrences(body) {
  return [...body.matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
}

/**
 * The `%s` occurrences of a value. Only the *count* is comparable across
 * languages — `translate()` fills positionally, so a translation may reorder
 * its placeholders (`%s of %s` → `共 %s 项，显示 %s`); the contract is how many
 * slots a key takes, not which column each sits in.
 */
function placeholders(value) {
  return [...value.matchAll(/%s/g)];
}

/**
 * The prototype's demo vocabulary the implementation deliberately does not ship.
 *
 * Terry's ruling of 2026-10-12: the sidebar legend (B15) and the states gallery
 * (B18) are product-design demonstrations, not functional requirements, so the
 * shipped app renders neither and their strings have no consumer. This is an
 * explicit, closed list rather than a prefix rule, so the suite can prove both
 * directions — every listed key really is a prototype key (the list cannot be
 * padded to hide a real drift) and none of them is in the catalogue (the
 * deletion really happened).
 */
const PROTOTYPE_ONLY_KEYS = Object.freeze([
  "sidebar.legend",
  "sidebar.states",
  "states.title",
  "states.close",
  "states.loading",
  "states.loadingNote",
  "states.emptyColumn",
  "states.emptyColumnNote",
  "states.emptyResults",
  "states.emptyResultsNote",
  "states.error",
  "states.errorNote",
  "states.toasts",
  "states.toastsNote",
  "toast.sample.info",
  "toast.sample.success",
  "toast.sample.danger",
]);

/** Is this one of the prototype-only keys? */
function isPrototypeOnlyKey(key) {
  return PROTOTYPE_ONLY_KEYS.includes(key);
}

/** The prototype's `MESSAGES` literal text, as it stands in `design/prototype/app.js`. */
function prototypeLiteralText() {
  const source = readFileSync(PROTOTYPE_APP, "utf8");
  const at = source.indexOf("var MESSAGES = ");
  assert.notEqual(at, -1, "design/prototype/app.js no longer declares MESSAGES");
  return objectLiteralAt(source, at + "var MESSAGES = ".length);
}

/** The `"key": …` entry lines of a catalogue literal, in source order. */
function entryLines(literal) {
  return literal.split("\n").filter((line) => /^\s*"[^"]+"\s*:/.test(line));
}

/** The key an entry line declares. */
function keyOfEntry(line) {
  return /^\s*"([^"]+)"\s*:/.exec(line)[1];
}

/** A catalogue table with the prototype-only keys removed, order preserved. */
function withoutPrototypeOnly(table) {
  return Object.fromEntries(Object.entries(table).filter(([key]) => !isPrototypeOnlyKey(key)));
}

/** Re-derives `MESSAGES` from `design/prototype/app.js` without executing the app. */
function extractPrototypeCatalogue() {
  return new Function(`return ${prototypeLiteralText()};`)(); // eslint-disable-line no-new-func
}

/* ------------------------------------------------------------------- parity */

describe("catalogue parity", () => {
  it("exposes exactly the two shipped languages", () => {
    assert.deepEqual(LANGUAGE_LIST, ["en", "zh"]);
    assert.equal(DEFAULT_LANGUAGE, "en");
    assert.deepEqual(Object.keys(CATALOGUE).sort(), ["en", "zh"]);
  });

  it("mirrors en and zh key for key, in the same order", (t) => {
    const en = Object.keys(CATALOGUE.en);
    const zh = Object.keys(CATALOGUE.zh);

    t.diagnostic(`measured catalogue keys: en ${en.length} / zh ${zh.length}`);

    // Same *set* (the parity the catalogue promises) …
    assert.deepEqual([...en].sort(), [...zh].sort());
    // … and the same *order*, so a diff of the two blocks stays readable.
    assert.deepEqual(en, zh);
    assert.ok(en.length > 0, "an empty catalogue must fail rather than pass vacuously");
  });

  it("carries no duplicate keys (checked in the source text)", () => {
    // Evaluation collapses duplicates, so the count of `"key":` occurrences is
    // the only honest place to compare against the key count.
    const bodies = languageBodies(moduleLiteral());
    for (const lang of LANGUAGE_LIST) {
      const seen = keyOccurrences(bodies[lang]);
      const unique = new Set(seen);
      assert.equal(
        seen.length,
        unique.size,
        `${lang} declares ${seen.length - unique.size} duplicate key(s): ` +
          [...seen].filter((k, i) => seen.indexOf(k) !== i).join(", "),
      );
      assert.equal(seen.length, Object.keys(CATALOGUE[lang]).length);
    }
  });

  it("has no empty or non-string values", () => {
    for (const lang of LANGUAGE_LIST) {
      for (const [key, value] of Object.entries(CATALOGUE[lang])) {
        assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
        assert.notEqual(value.trim(), "", `${lang}.${key} must not be empty`);
      }
    }
  });

  it("agrees on the %s placeholder count for every key", () => {
    for (const key of Object.keys(CATALOGUE.en)) {
      assert.equal(
        placeholders(CATALOGUE.zh[key]).length,
        placeholders(CATALOGUE.en[key]).length,
        `%s placeholder count differs for "${key}": ` +
          `en ${JSON.stringify(CATALOGUE.en[key])} vs zh ${JSON.stringify(CATALOGUE.zh[key])}`,
      );
    }
  });
});

/* --------------------------------------------------------- against prototype */

describe("catalogue vs prototype", { skip: HAS_PROTOTYPE ? false : "design/prototype/ is not present" }, () => {
  it("carries the prototype's entries verbatim, minus the prototype-only keys", () => {
    // Whole literal equality is what this replaces: the catalogue is the
    // prototype's literal with exactly the prototype-only entries deleted, so
    // comparing entry lines key for key (order included) keeps the copy honest
    // *per string* rather than only in aggregate.
    const theirs = entryLines(prototypeLiteralText()).filter((line) => !isPrototypeOnlyKey(keyOfEntry(line)));
    const ours = entryLines(moduleLiteral());
    assert.ok(theirs.length > 0, "the prototype literal yielded no entries — the scan is broken");
    assert.deepEqual(ours, theirs, "a shipped entry no longer matches design/prototype/app.js byte for byte");
  });

  it("deep-equals the catalogue re-derived from design/prototype/app.js, minus the prototype-only keys", (t) => {
    const expected = extractPrototypeCatalogue();
    t.diagnostic(
      `prototype MESSAGES re-derived: en ${Object.keys(expected.en).length} / ` +
        `zh ${Object.keys(expected.zh).length} (of which ${PROTOTYPE_ONLY_KEYS.length} prototype-only)`,
    );
    assert.deepEqual(CATALOGUE, { en: withoutPrototypeOnly(expected.en), zh: withoutPrototypeOnly(expected.zh) });
  });

  it("matches the prototype's real key count minus the prototype-only keys", () => {
    const expected = extractPrototypeCatalogue();
    for (const lang of LANGUAGE_LIST) {
      assert.equal(
        Object.keys(CATALOGUE[lang]).length,
        Object.keys(expected[lang]).length - PROTOTYPE_ONLY_KEYS.length,
        `${lang} key count drifted from the prototype`,
      );
    }
  });

  it("keeps the prototype-only list closed and honest", () => {
    // No duplicates, nothing folded in by accident …
    assert.equal(new Set(PROTOTYPE_ONLY_KEYS).size, PROTOTYPE_ONLY_KEYS.length, "duplicate entry");
    // … every listed key really is a prototype key in both languages (so the
    // list cannot be padded with keys that never existed to mask a deletion) …
    const expected = extractPrototypeCatalogue();
    for (const key of PROTOTYPE_ONLY_KEYS) {
      for (const lang of LANGUAGE_LIST) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(expected[lang], key),
          `${key} is listed as prototype-only but ${lang} does not declare it`,
        );
      }
      // … and it really is absent from the shipped catalogue.
      assert.equal(hasKey("en", key), false, `${key} is prototype-only but present in the catalogue`);
    }
  });

  it("covers every translated hook in design/prototype/index.html", (t) => {
    // The catalogue is only "reusable" if the markup's hooks still resolve
    // against it — a key rename in the prototype would otherwise leave the
    // extraction looking complete.
    const htmlPath = resolve(ROOT, "design/prototype/index.html");
    if (!existsSync(htmlPath)) return t.skip("design/prototype/index.html is not present");
    const html = readFileSync(htmlPath, "utf8");

    const valuesOf = (attribute) =>
      [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map((m) => m[1].trim());

    let hooks = 0;
    const tolerated = new Set();
    for (const attribute of ["data-i18n", "data-i18n-aria-label", "data-i18n-title", "data-i18n-placeholder"]) {
      const values = valuesOf(attribute);
      hooks += values.length;
      const dangling = [...new Set(values)].filter((key) => !hasKey("en", key));
      // A hook whose key is gone is only acceptable when it is one of the
      // prototype-only keys — anything else is a real dangling hook.
      for (const key of dangling) {
        assert.ok(isPrototypeOnlyKey(key), `${attribute} names a key neither shipped nor recorded prototype-only: ${key}`);
        tolerated.add(key);
      }
    }
    t.diagnostic(
      `measured data-i18n* hooks in index.html: ${hooks}; ` +
        `${tolerated.size} of them resolve to prototype-only keys`,
    );

    // `data-i18n-arg` values are arguments, not keys: the prototype resolves
    // them through `text(arg)` and lets a non-key fall through verbatim.
    const args = valuesOf("data-i18n-arg");
    hooks += args.length;
    assert.ok(hooks > 0, "no hooks found — a vacuous scan must fail");
    const passthrough = [...new Set(args)].filter((arg) => !hasKey("en", arg));
    for (const arg of passthrough) {
      assert.equal(translate("en", arg), arg, `non-key arg "${arg}" must pass through verbatim`);
    }
  });
});

/* ------------------------------------------------------------------- purity */

describe("catalogue purity", () => {
  it("imports nothing and reaches for no ambient state", () => {
    assert.equal(/^\s*import\s/m.test(MODULE_SOURCE), false, "the module must not import anything");
    for (const forbidden of [/\brequire\s*\(/, /\bfetch\s*\(/, /\bprocess\s*\./, /\bMath\s*\.\s*random\b/, /\bDate\s*\.\s*now\b/]) {
      assert.equal(forbidden.test(MODULE_SOURCE), false, `module source matches ${forbidden}`);
    }
  });

  it("is inert at load time and cannot be mutated in place", async () => {
    const before = Object.getOwnPropertyNames(globalThis).sort();

    // A cache-busted import re-runs the module body in this same realm; if it
    // had a load-time side effect on the global object, the diff would show it.
    const fresh = await import(`${pathToFileURL(MODULE_PATH).href}?fresh=${Date.now()}`);
    assert.deepEqual(Object.getOwnPropertyNames(globalThis).sort(), before);
    assert.deepEqual(fresh.CATALOGUE, CATALOGUE);

    assert.ok(Object.isFrozen(CATALOGUE), "the catalogue table must be frozen");
    assert.ok(Object.isFrozen(CATALOGUE.en) && Object.isFrozen(CATALOGUE.zh));
    assert.throws(() => {
      "use strict";
      CATALOGUE.en["app.title"] = "tampered";
    }, TypeError);
    assert.equal(Object.isFrozen(fresh.LANGUAGES), true);
  });
});

/* ------------------------------------------------------------------ lookup */

describe("lookup helper", () => {
  it("resolves a language, falling back to English then to the key", () => {
    assert.equal(tableFor("zh"), CATALOGUE.zh);
    assert.equal(tableFor("en"), CATALOGUE.en);
    assert.equal(tableFor("de"), CATALOGUE.en);
    assert.equal(tableFor(undefined), CATALOGUE.en);
    assert.equal(hasKey("zh", "app.title"), true);
    assert.equal(hasKey("zh", "no.such.key"), false);
  });

  it("translates with the prototype's fallback order", () => {
    assert.equal(translate("zh", "app.brand"), CATALOGUE.zh["app.brand"]);
    assert.equal(translate("en", "app.brand"), CATALOGUE.en["app.brand"]);
    assert.equal(translate("de", "app.brand"), CATALOGUE.en["app.brand"]);
    assert.equal(translate("en", "no.such.key"), "no.such.key");
  });

  it("fills %s positionally, leaving surplus placeholders intact", () => {
    const two = Object.keys(CATALOGUE.en).find((k) => placeholders(CATALOGUE.en[k]).length === 2);
    assert.ok(two, "expected at least one two-placeholder message");
    const filled = translate("en", two, "A", "B");
    assert.equal(placeholders(filled).length, 0, `${two} should have been fully filled: ${filled}`);

    const one = Object.keys(CATALOGUE.en).find((k) => placeholders(CATALOGUE.en[k]).length === 1);
    assert.ok(one, "expected at least one one-placeholder message");
    assert.equal(placeholders(translate("en", one, "X")).length, 0);
    // Only one argument supplied for a two-placeholder message: the prototype
    // leaves the second `%s` visible rather than printing "undefined".
    assert.equal(placeholders(translate("en", two, "A")).length, 1);
    assert.equal(placeholders(translate("en", two, "A", undefined)).length, 1);
  });
});
