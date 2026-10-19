/**
 * The browser-free half of the block contract (L1).
 *
 * `blocks.contract.mjs` declares the hook surface; this suite proves the built
 * app still carries it, without a browser:
 *
 *   * **`selector-literal-present`** — every hook the contract declares that
 *     must *exist* appears as a literal attribute name in `web/dist/assets/*.js`.
 *     Vue compiles a `data-*` attribute to a string key in the bundle, so a grep
 *     is a faithful proxy for "the hook survived the framework compile". The
 *     selectors used *only* by an `absent` rule are excluded — their whole point
 *     is that they do **not** appear — and the walk runs over
 *     `implementationSelectors()`, so prototype-only blocks (B15, B18) are not
 *     demanded either. Individual attribute names are checked rather than whole
 *     selector strings, because Vue never emits a compound like
 *     `[data-column][data-status]` verbatim.
 *   * the four authored-CSS **source** checks (C03/C04/C05/C08), run against
 *     `web/src/styles/*.css` — the files this repo authors — rather than the
 *     built stylesheet, which also carries Tailwind's and daisyUI's own output.
 *
 * When `web/dist` is absent the build-dependent checks **skip with a printed
 * reason** (the "absent tool ⇒ SKIP, never FAIL" precedent from
 * `scripts/verify/host-cli.mjs`); the CSS checks only need the source and always
 * run.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  DOMAINS,
  IMPLEMENTED_CONTRACT_ITEMS,
  implementationSelectors,
  parseHookSelector,
} from "./blocks.contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(ROOT, "web/dist");
const ASSETS = resolve(DIST, "assets");
const HAS_DIST = existsSync(resolve(DIST, "index.html"));
const STYLE_DIR = resolve(ROOT, "web/src/styles");

const SKIP_BUILD = HAS_DIST ? false : "web/dist is not built — run `npm -w web run build`";

/** Every authored stylesheet, concatenated, with its filename for messages. */
function readStyles() {
  const files = readdirSync(STYLE_DIR).filter((name) => name.endsWith(".css"));
  return files.map((name) => ({ name, css: readFileSync(resolve(STYLE_DIR, name), "utf8") }));
}

/** The bundle text (all JS chunks), or null when there is no build. */
function readBundle() {
  if (!HAS_DIST || !existsSync(ASSETS)) return null;
  const chunks = readdirSync(ASSETS).filter((name) => name.endsWith(".js"));
  return chunks.map((name) => readFileSync(resolve(ASSETS, name), "utf8")).join("\n");
}

/**
 * Does this selector name its attributes *without* a value — `[data-x]` rather
 * than `[data-x="y"]`?
 *
 * The distinction decides what an `absent` rule means. A bare hook forbids the
 * attribute outright; a value-qualified one forbids a **value** of an attribute
 * the block requires (`[data-project-count=""]` — no project row may carry an
 * empty count), which says nothing about whether the hook may exist.
 */
function isValuelessSelector(selector) {
  const parsed = parseHookSelector(selector);
  return parsed !== null && parsed.attributes.every((attribute) => attribute.value === null);
}

/**
 * Selectors that appear **only** in an `absent` rule: the contract requires them
 * to be missing, so the presence scan must not demand them.
 *
 * Walked over `IMPLEMENTED_CONTRACT_ITEMS`: this whole suite is an
 * implementation-side check, so prototype-only blocks (B15, B18) contribute
 * neither a "must exist" nor a "must not exist" here.
 */
function absentOnlySelectors() {
  const mustExist = new Set();
  const mustNotExist = new Set();
  for (const item of IMPLEMENTED_CONTRACT_ITEMS) {
    if (item.root !== null) mustExist.add(item.root);
    for (const selector of [...item.required, ...item.states]) mustExist.add(selector);
    for (const rule of item.rules) {
      if (rule.kind === "absent") {
        if (typeof rule.selector === "string" && isValuelessSelector(rule.selector)) mustNotExist.add(rule.selector);
        if (typeof rule.within === "string") mustExist.add(rule.within);
      } else {
        for (const field of ["selector", "equalsSelector", "within"]) {
          if (typeof rule[field] === "string") mustExist.add(rule[field]);
        }
      }
    }
  }
  return new Set([...mustNotExist].filter((selector) => !mustExist.has(selector)));
}

describe("web/blocks.bundle — the hook surface survives the build", { skip: SKIP_BUILD }, () => {
  it("carries every must-exist hook as a literal attribute name in the bundle", (t) => {
    const bundle = readBundle();
    assert.ok(bundle, "no bundle read despite the skip guard");

    const absentOnly = absentOnlySelectors();
    const names = new Set();
    // `implementationSelectors()` is the declared surface minus the
    // prototype-only blocks and hooks: those are not supposed to be in the app,
    // so demanding them here would contradict the contract.
    for (const selector of implementationSelectors()) {
      if (absentOnly.has(selector)) continue;
      const parsed = parseHookSelector(selector);
      assert.ok(parsed, `${selector} does not parse`);
      for (const attribute of parsed.attributes) names.add(attribute.name);
    }

    const missing = [...names].filter((name) => !bundle.includes(name)).sort();
    t.diagnostic(`scanned ${names.size} distinct hook attribute names against the bundle`);
    // The B19 allow-list is editable since the access policy was persisted:
    // `data-cidr-add` / `data-cidr-remove` are real controls now, so there is
    // no exemption left to hold.
    assert.deepEqual(missing, [], `these hooks are absent from the bundle: ${missing.join(", ")}`);
  });

  it("keeps every retired/forbidden hook out of the bundle", (t) => {
    const bundle = readBundle();
    // Only *single data-* attribute* selectors are checkable by name: a compound
    // like `[data-list][hidden]` forbids a combination, not the attribute itself
    // (both names legitimately exist elsewhere). The retired B20/B21 hooks and
    // C10's forbidden label-management names are exactly the single-attribute kind.
    const single = [...absentOnlySelectors()].filter((selector) => {
      const parsed = parseHookSelector(selector);
      return parsed && parsed.attributes.length === 1 && parsed.hasDataHook;
    });
    t.diagnostic(`retired/forbidden single-hook selectors: ${single.length}`);
    const leaked = single.filter((selector) => bundle.includes(parseHookSelector(selector).attributes[0].name));
    assert.deepEqual(leaked, [], `retired/forbidden hooks leaked into the bundle: ${leaked.join(", ")}`);
  });
});

describe("web/blocks.bundle — authored CSS source checks", () => {
  it("C03 · maps every status to --status-color and every priority to --pri-color", () => {
    const css = readStyles().map((file) => file.css).join("\n");
    for (const status of DOMAINS.STATUS) {
      assert.match(css, new RegExp(`\\[data-status=["']?${status}["']?\\][^{]*\\{[^}]*--status-color`), `status ${status} has no colour mapping`);
    }
    for (const priority of DOMAINS.PRIORITY) {
      assert.match(css, new RegExp(`\\[data-priority=["']?${priority}["']?\\][^{]*\\{[^}]*--pri-color`), `priority ${priority} has no colour mapping`);
    }
  });

  it("C04 · `.td-mono` declares tabular numerals", () => {
    const css = readStyles().map((file) => file.css).join("\n");
    assert.match(css, /\.td-mono\b[^{]*\{[^}]*font-variant-numeric:\s*tabular-nums/, "`.td-mono` must declare tabular-nums");
  });

  it("C05 · no authored rule selects by id", () => {
    for (const { name, css } of readStyles()) {
      // Strip comments first so a `#` inside prose cannot trip the scan.
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      assert.equal(/#[A-Za-z_][-\w]*\s*(?=[,{])/.test(withoutComments), false, `${name}: an id selector is present`);
    }
  });

  it("C08 · six-digit hex lives only in the token block", () => {
    const HEX = /#[0-9a-fA-F]{6}\b/g;
    for (const { name, css } of readStyles()) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const hits = withoutComments.match(HEX) ?? [];
      if (name === "tokens.css") assert.ok(hits.length > 0, "the token block must hold the brand literals");
      else assert.deepEqual(hits, [], `${name} hard-codes brand hex outside the token block: ${hits.join(", ")}`);
    }
  });
});
