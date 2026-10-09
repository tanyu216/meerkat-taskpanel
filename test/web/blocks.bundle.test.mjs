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
 *     is that they do **not** appear. Individual attribute names are checked
 *     rather than whole selector strings, because Vue never emits a compound
 *     like `[data-column][data-status]` verbatim.
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

import { ALL_CONTRACT_ITEMS, AUXILIARY_HOOKS, DOMAINS, allSelectors, parseHookSelector } from "./blocks.contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(ROOT, "web/dist");
const ASSETS = resolve(DIST, "assets");
const HAS_DIST = existsSync(resolve(DIST, "index.html"));
const STYLE_DIR = resolve(ROOT, "web/src/styles");

const SKIP_BUILD = HAS_DIST ? false : "web/dist is not built — run `npm -w web run build`";

/**
 * Hooks the contract lists but that a **ruling** deliberately drops.
 *
 * Ruling O6 renders B19's CIDR allow-list read-only: §5.1 defines no CIDR
 * read/write route and `/meta` exposes only `capabilities.allow_list` as a
 * boolean, so the "add range" / "remove range" controls are omitted rather than
 * shipped as dead buttons. The check below stays strict for everything else and
 * asserts this list is exactly these two, so the exemption cannot silently grow.
 */
const READ_ONLY_EXEMPT = Object.freeze(["data-cidr-add", "data-cidr-remove"]);

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
 * Selectors that appear **only** in an `absent` rule: the contract requires them
 * to be missing, so the presence scan must not demand them.
 */
function absentOnlySelectors() {
  const mustExist = new Set();
  const mustNotExist = new Set();
  for (const item of ALL_CONTRACT_ITEMS) {
    if (item.root !== null) mustExist.add(item.root);
    for (const selector of [...item.required, ...item.states]) mustExist.add(selector);
    for (const rule of item.rules) {
      if (rule.kind === "absent") {
        if (typeof rule.selector === "string") mustNotExist.add(rule.selector);
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
    for (const selector of allSelectors()) {
      if (absentOnly.has(selector)) continue;
      const parsed = parseHookSelector(selector);
      assert.ok(parsed, `${selector} does not parse`);
      for (const attribute of parsed.attributes) names.add(attribute.name);
    }
    // Auxiliary hooks are part of the surface too.
    for (const hook of AUXILIARY_HOOKS) {
      const parsed = parseHookSelector(hook.selector);
      if (parsed) for (const attribute of parsed.attributes) names.add(attribute.name);
    }

    const missing = [...names].filter((name) => !bundle.includes(name)).sort();
    t.diagnostic(`scanned ${names.size} distinct hook attribute names against the bundle`);
    const unexpected = missing.filter((name) => !READ_ONLY_EXEMPT.includes(name));
    assert.deepEqual(unexpected, [], `these hooks are absent from the bundle: ${unexpected.join(", ")}`);
    // The exemption must stay exactly the two O6 hooks — no silent growth.
    assert.deepEqual(missing, [...READ_ONLY_EXEMPT].sort(), "the read-only exemption drifted");
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
