/**
 * The block contract's own test: it validates the **module**, not the DOM.
 *
 * `blocks.contract.mjs` transcribes `prototype/BLOCKS.md` (B01–B25 + the ten
 * consistency items) into assertion data. Nothing here needs a browser or a build:
 * this suite must be green today, before `web/` exists, and it runs in the container
 * as part of the ordinary `node --test` pass. The assertions that need a live DOM live
 * in `BROWSER_LAYER_RULES` and are executed later by the browser-layer suite.
 *
 * ## The BLOCKS.md header-count discrepancy (why no prose number is ever asserted)
 *
 * BLOCKS.md's header contradicts its own body and the shipped DOM. It claims
 * "**252** `data-i18n*` hooks" and "**198** catalogue keys"; measured against
 * `prototype/index.html` and `prototype/app.js`, the document carries **606**
 * `data-i18n*` attributes (389 `data-i18n` + 144 `-arg` + 47 `-aria-label` +
 * 8 `-placeholder` + 18 `-title`) and the catalogue holds **214 keys per language**
 * (en = 214, zh = 214, exact parity — which is what the *body* says). Only the
 * "7 columns · 18 cards · 18 detail templates" line survives measurement. A contract
 * that quoted "252" or "198" would be wrong the day it was written, and one that
 * asserted "18 cards" would freeze a demo fixture into the spec. So every count in the
 * contract is either a domain-fixed multiplicity (7 statuses ⇒ 7 columns, 3 nav items,
 * 2 views, 2 languages, 3 editor modes), a relation the rule kind expresses without a
 * number, or a `manual` note; the stale claims are exported as `STALE_PROSE_COUNTS` and
 * this suite proves none of them leaked into a rule.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { describe, it } from "node:test";

import * as contract from "./blocks.contract.mjs";
import {
  ALL_CONTRACT_ITEMS,
  AUXILIARY_HOOKS,
  BLOCK_CONTRACT,
  BROWSER_LAYER_RULES,
  CONSISTENCY_CONTRACT,
  CONTRACT_SOURCE,
  DOMAINS,
  MANUAL_RULES,
  RULE_KINDS,
  SCOPES,
  SOURCE_CHECKS,
  SOURCE_LAYER_RULES,
  STALE_PROSE_COUNTS,
  allSelectors,
  isHookSelector,
  parseHookSelector,
  validateContract,
} from "./blocks.contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(HERE, "blocks.contract.mjs");

/** The inventory BLOCKS.md defines: 25 numbered blocks plus 10 consistency items. */
const EXPECTED_BLOCK_IDS = Array.from({ length: 25 }, (_, i) => `B${String(i + 1).padStart(2, "0")}`);
const EXPECTED_CONSISTENCY_IDS = Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`);

/** The three kinds the plan names, plus the vocabulary this contract adds around them. */
const PLAN_KINDS = ["count", "order", "identical-hookset"];

const BLOCK_FIELDS = ["id", "title", "root", "scope", "status", "required", "states", "rules"];

/** Every selector a rule or a block declares, paired with where it came from. */
function declaredSelectors() {
  const out = [];
  for (const item of ALL_CONTRACT_ITEMS) {
    if (item.root !== null) out.push({ at: `${item.id}.root`, selector: item.root });
    item.required.forEach((selector, i) => out.push({ at: `${item.id}.required[${i}]`, selector }));
    item.states.forEach((selector, i) => out.push({ at: `${item.id}.states[${i}]`, selector }));
    item.rules.forEach((rule, i) => {
      for (const field of ["selector", "equalsSelector", "within"]) {
        if (typeof rule[field] === "string") out.push({ at: `${item.id}.rules[${i}].${field}`, selector: rule[field] });
      }
    });
  }
  for (const hook of AUXILIARY_HOOKS) out.push({ at: "AUXILIARY_HOOKS", selector: hook.selector });
  return out;
}

describe("web/blocks.contract — module hygiene", () => {
  it("loads without side effects: importing it in a fresh process prints nothing", () => {
    const url = pathToFileURL(MODULE_PATH).href;
    const stdout = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(stdout, "", "importing the contract module must not print anything");
  });

  it("is pure data + frozen exports", () => {
    assert.equal(CONTRACT_SOURCE, "prototype/BLOCKS.md");
    for (const value of [
      SCOPES,
      BLOCK_CONTRACT,
      CONSISTENCY_CONTRACT,
      ALL_CONTRACT_ITEMS,
      BROWSER_LAYER_RULES,
      SOURCE_LAYER_RULES,
      MANUAL_RULES,
      STALE_PROSE_COUNTS,
      AUXILIARY_HOOKS,
      allSelectors(),
    ]) {
      assert.ok(Object.isFrozen(value), "exported collections must be frozen");
    }
    for (const item of ALL_CONTRACT_ITEMS) {
      assert.ok(Object.isFrozen(item), `${item.id} must be frozen`);
      assert.ok(Object.isFrozen(item.required), `${item.id}.required must be frozen`);
      assert.ok(Object.isFrozen(item.states), `${item.id}.states must be frozen`);
      assert.ok(Object.isFrozen(item.rules), `${item.id}.rules must be frozen`);
    }
    for (const domain of Object.values(DOMAINS)) {
      assert.ok(Object.isFrozen(domain) && domain.every((v) => typeof v === "string"), "domains are frozen string lists");
    }
  });

  it("re-importing yields the same module instance (no per-import work)", async () => {
    const again = await import("./blocks.contract.mjs");
    assert.equal(again.BLOCK_CONTRACT, BLOCK_CONTRACT);
  });
});

describe("web/blocks.contract — inventory completeness", () => {
  it("covers B01–B25 with no gap and no duplicate", () => {
    assert.deepEqual(
      BLOCK_CONTRACT.map((item) => item.id),
      EXPECTED_BLOCK_IDS,
    );
  });

  it("covers the ten consistency items C01–C10", () => {
    assert.deepEqual(
      CONSISTENCY_CONTRACT.map((item) => item.id),
      EXPECTED_CONSISTENCY_IDS,
    );
  });

  it("gives every item the prescribed shape", () => {
    for (const item of ALL_CONTRACT_ITEMS) {
      assert.deepEqual(
        Object.keys(item),
        BLOCK_FIELDS,
        `${item.id} must carry exactly ${BLOCK_FIELDS.join(", ")}`,
      );
      assert.equal(typeof item.title, "string");
      assert.ok(item.title.length > 0, `${item.id} needs a title`);
      assert.ok(SCOPES.includes(item.scope), `${item.id} scope ${item.scope}`);
      assert.ok(["active", "retired"].includes(item.status), `${item.id} status`);
      assert.ok(Array.isArray(item.required) && Array.isArray(item.states) && Array.isArray(item.rules));
    }
  });

  it("keeps retired blocks rootless and free of positive assertions", () => {
    const retired = ALL_CONTRACT_ITEMS.filter((item) => item.status === "retired");
    assert.deepEqual(retired.map((item) => item.id), ["B20", "B21"]);
    for (const item of retired) {
      assert.equal(item.root, null, `${item.id} was removed, so it has no root`);
      assert.equal(item.scope, "retired");
      assert.deepEqual(item.required, [], `${item.id} declares no owned hooks`);
      assert.ok(item.rules.length > 0, `${item.id} must still assert its absence`);
      for (const rule of item.rules) {
        assert.ok(["absent", "manual"].includes(rule.kind), `${item.id} may only assert absence, not ${rule.kind}`);
      }
    }
  });

  it("gives the C-items no root and the global scope (they are cross-cutting)", () => {
    for (const item of CONSISTENCY_CONTRACT) {
      assert.equal(item.root, null, `${item.id} is cross-cutting`);
      assert.equal(item.scope, "global");
      assert.equal(item.status, "active");
    }
  });

  it("records BLOCKS.md's auxiliary hooks (outside the numbered blocks) as hooks too", () => {
    assert.ok(AUXILIARY_HOOKS.length > 0);
    for (const hook of AUXILIARY_HOOKS) {
      assert.ok(isHookSelector(hook.selector), `${hook.selector} must be a data-* hook`);
      assert.ok(hook.purpose.length > 0, `${hook.selector} needs a purpose`);
    }
  });
});

describe("web/blocks.contract — selectors are semantic hooks", () => {
  it("parses the hook grammar and rejects classes, ids and combinators", () => {
    assert.ok(parseHookSelector("[data-card]"));
    assert.deepEqual(parseHookSelector("html[data-theme]")?.dataAttributes, ["data-theme"]);
    assert.deepEqual(parseHookSelector("[data-column][data-status]")?.dataAttributes, ["data-column", "data-status"]);
    assert.equal(parseHookSelector('[data-i18n="error.title"]')?.attributes[0].value, "error.title");
    assert.deepEqual(
      parseHookSelector("[data-detail-drawer][data-state=\"open\"]")?.dataAttributes,
      ["data-detail-drawer", "data-state"],
    );

    // Class, id and combinator forms do not parse at all: the grammar has no way to express them.
    for (const bad of [
      ".td-card",
      "div.p-4[data-card]",
      "#board",
      "[data-card] .child",
      "[data-card] > [data-label]",
      "section.td-col[data-column]",
      "",
      null,
      undefined,
    ]) {
      assert.equal(parseHookSelector(bad), null, `${String(bad)} must not parse as a hook selector`);
      assert.equal(isHookSelector(bad), false, `${String(bad)} must not be a hook selector`);
    }

    // Attribute-only compounds parse, but a selector without a `data-*` name is not a hook:
    // ARIA and HTML attributes are real, they are just never the contract's anchor.
    for (const notAHook of ["[aria-label]", "[hidden]", "[role=\"dialog\"]", "[draggable=\"true\"]"]) {
      assert.ok(parseHookSelector(notAHook), `${notAHook} is a legal attribute selector`);
      assert.equal(isHookSelector(notAHook), false, `${notAHook} is not a data-* hook`);
    }
  });

  it("declares nothing but data-* hooks — no Tailwind class, no id, no descendant combinator", () => {
    const forbidden = /(^|[^"'])\.|(^|[^"'])#|[\s>+~]/;
    for (const { at, selector } of declaredSelectors()) {
      const withoutQuotedValues = selector.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
      assert.ok(
        !forbidden.test(withoutQuotedValues),
        `${at}: ${selector} carries a class/id/combinator token — the contract is hooks only`,
      );
      assert.ok(isHookSelector(selector), `${at}: ${selector} is not a data-* hook`);
    }
  });

  it("never relies on a Tailwind utility class by name", () => {
    const raw = JSON.stringify(ALL_CONTRACT_ITEMS);
    // A handful of utility prefixes would be unmistakable if they ever leaked in as selectors.
    for (const utility of ["p-4", "flex ", "text-sm", "grid-cols-", "min-w-", "rounded-", "bg-", "gap-"]) {
      assert.ok(!raw.includes(`"${utility}`), `contract text must not contain a Tailwind utility (${utility})`);
    }
  });
});

describe("web/blocks.contract — counts and orders live only in rules", () => {
  it("carries no numeric value outside `rules`", () => {
    for (const item of ALL_CONTRACT_ITEMS) {
      for (const [key, value] of Object.entries(item)) {
        if (key === "rules") continue;
        assert.notEqual(typeof value, "number", `${item.id}.${key} must not be a magic number — state it as a rule`);
      }
    }
  });

  it("states no count in a title (titles name the block, they do not quantify it)", () => {
    for (const item of ALL_CONTRACT_ITEMS) {
      assert.doesNotMatch(item.title, /\d/, `${item.id} title quotes a number: ${item.title}`);
    }
  });

  it("expresses every count/order assertion as a typed rule", () => {
    const counted = [];
    for (const item of ALL_CONTRACT_ITEMS) {
      for (const rule of item.rules) {
        assert.ok(Object.keys(RULE_KINDS).includes(rule.kind), `${item.id}: unknown kind ${rule.kind}`);
        if (rule.kind === "count" || rule.kind === "order" || rule.kind === "sequence") counted.push(rule);
      }
    }
    assert.ok(counted.length > 0, "the contract must actually assert multiplicities somewhere");
  });

  it("passes its own schema validation", () => {
    assert.deepEqual(validateContract(), []);
  });

  it("keeps the plan's three named kinds in service", () => {
    const kindsUsed = new Set(ALL_CONTRACT_ITEMS.flatMap((item) => item.rules.map((rule) => rule.kind)));
    for (const kind of PLAN_KINDS) {
      assert.ok(kindsUsed.has(kind), `${kind} is named by the plan and must be used`);
    }
    for (const kind of Object.keys(RULE_KINDS)) {
      assert.ok(kindsUsed.has(kind), `rule kind ${kind} is declared but unused (dead vocabulary)`);
    }
  });

  it("validates each rule kind's payload shape", () => {
    for (const { block, rule } of BROWSER_LAYER_RULES) {
      if (rule.kind === "count") {
        const bounds = ["equals", "min", "max"].filter((key) => rule[key] !== undefined);
        assert.ok(bounds.length >= 1, `${block} count needs a bound`);
        for (const key of bounds) assert.ok(Number.isInteger(rule[key]), `${block} count.${key}`);
      }
      if (rule.kind === "domain") {
        const values = rule.subset ?? rule.equals;
        assert.ok(Array.isArray(values) && values.length > 0, `${block} domain needs values`);
        assert.ok(Object.values(DOMAINS).includes(values), `${block}: enumerations must come from DOMAINS`);
      }
      if (rule.kind === "order") {
        assert.ok(Object.values(DOMAINS).includes(rule.equals), `${block}: ordered enumerations must come from DOMAINS`);
      }
      if (rule.kind === "identical-hookset" || rule.kind === "absent" || rule.kind === "count") {
        if (rule.within !== undefined) {
          assert.ok(isHookSelector(rule.within), `${block}: within must be a hook selector`);
        }
      }
      if (rule.when !== undefined) {
        assert.equal(typeof rule.when, "string", `${block}: when must be a string precondition`);
      }
    }
  });
});

describe("web/blocks.contract — the browser layer is a separate export", () => {
  it("splits every rule into exactly one layer", () => {
    const total = ALL_CONTRACT_ITEMS.reduce((sum, item) => sum + item.rules.length, 0);
    assert.equal(BROWSER_LAYER_RULES.length + SOURCE_LAYER_RULES.length + MANUAL_RULES.length, total);
  });

  it("tags each rule with its declared kind's layer", () => {
    for (const { block, rule } of [...BROWSER_LAYER_RULES, ...SOURCE_LAYER_RULES, ...MANUAL_RULES]) {
      const layer = RULE_KINDS[rule.kind].layer;
      assert.ok(["dom", "source", "manual"].includes(layer), `${block}: ${rule.kind} has layer ${layer}`);
    }
    assert.ok(BROWSER_LAYER_RULES.every(({ rule }) => RULE_KINDS[rule.kind].layer === "dom"));
    assert.ok(SOURCE_LAYER_RULES.every(({ rule }) => RULE_KINDS[rule.kind].layer === "source"));
    assert.ok(MANUAL_RULES.every(({ rule }) => RULE_KINDS[rule.kind].layer === "manual"));
  });

  it("keeps something checkable on each side of the browser boundary", () => {
    assert.ok(BROWSER_LAYER_RULES.length > 0, "DOM rules are the browser layer's job");
    assert.ok(SOURCE_LAYER_RULES.length > 0, "browser-free rules must exist so the container suite can act");
    assert.ok(MANUAL_RULES.length > 0, "some invariants are honestly review-only");
  });

  it("references only registered source checks, and names the one the suite derives instead", () => {
    const referenced = new Set(SOURCE_LAYER_RULES.map(({ rule }) => rule.check));
    for (const check of referenced) {
      assert.ok(Object.prototype.hasOwnProperty.call(SOURCE_CHECKS, check), `${check} is not registered`);
    }
    const registered = Object.keys(SOURCE_CHECKS);
    const unused = registered.filter((check) => !referenced.has(check));
    // `selector-literal-present` is not a per-block rule: the L1 suite derives it from
    // `allSelectors()` (every declared hook, once), so it is deliberately unreferenced here.
    assert.deepEqual(unused, ["selector-literal-present"]);
  });

  it("gives every manual rule a note and no selector-shaped claim", () => {
    for (const { block, rule } of MANUAL_RULES) {
      assert.equal(typeof rule.note, "string", `${block}: manual rule needs a note`);
      assert.ok(rule.note.length > 20, `${block}: a manual note must say something checkable by a human`);
      assert.equal(rule.selector, undefined, `${block}: a manual rule must not pretend to be a selector rule`);
    }
  });

  it("keeps the browser-free exports stable across calls", () => {
    // `allSelectors()` is pure and returns a fresh frozen list, so stability means equal
    // contents, not a shared reference.
    assert.deepEqual(allSelectors(), allSelectors());
    assert.deepEqual(validateContract(), validateContract());
  });
});

describe("web/blocks.contract — the stale prose counts never became assertions", () => {
  it("documents the discrepancy rather than repeating it", () => {
    assert.ok(STALE_PROSE_COUNTS.length >= 2);
    for (const entry of STALE_PROSE_COUNTS) {
      assert.equal(typeof entry.claim, "string");
      assert.equal(typeof entry.measured, "number");
      assert.ok(["stale", "confirmed-but-unasserted"].includes(entry.verdict), entry.claim);
    }
    const stale = STALE_PROSE_COUNTS.filter((entry) => entry.verdict === "stale");
    assert.ok(stale.length >= 2, "the i18n and catalogue counts are both stale");
    assert.deepEqual(
      stale.map((entry) => entry.measured),
      [606, 214],
      "the measured values are the ones in the module header",
    );
  });

  it("does not quote a stale number in any rule", () => {
    const staleNumbers = STALE_PROSE_COUNTS.filter((entry) => entry.verdict === "stale").map((entry) => entry.measured);
    for (const item of ALL_CONTRACT_ITEMS) {
      for (const rule of item.rules) {
        for (const value of Object.values(rule)) {
          if (typeof value === "number") {
            assert.ok(!staleNumbers.includes(value), `${item.id}: rule quotes the stale count ${value}`);
          }
        }
      }
    }
    // …and the smallest structural count is nowhere near them, so the check is not vacuous.
    const numbers = ALL_CONTRACT_ITEMS.flatMap((item) =>
      item.rules.flatMap((rule) => Object.values(rule).filter((value) => typeof value === "number")),
    );
    assert.ok(Math.max(...numbers) < Math.min(...staleNumbers), "no structural bound may reach the stale range");
  });
});

describe("web/blocks.contract — the derived selector surface", () => {
  it("collects every declared selector once, sorted", () => {
    const selectors = allSelectors();
    assert.equal(new Set(selectors).size, selectors.length, "allSelectors must deduplicate");
    assert.deepEqual([...selectors], [...selectors].sort(), "allSelectors must be sorted");
    for (const { at, selector } of declaredSelectors()) {
      assert.ok(selectors.includes(selector), `${at}: ${selector} is missing from allSelectors()`);
    }
  });

  it("exposes the surface the browser-free literal scan needs", () => {
    // The L1 bundle check greps for these as literals; a few representative ones must be present.
    for (const selector of ["[data-app-shell]", "[data-card]", "[data-detail-drawer]", "[data-create-task]", "[data-label-option]"]) {
      assert.ok(allSelectors().includes(selector), `${selector} must be part of the declared surface`);
    }
  });

  it("keeps the retired hooks out of the required surface but inside the absence assertions", () => {
    const selectors = new Set(allSelectors());
    for (const retired of ["[data-theme-modal]", "[data-lang-modal]", "[data-theme-toggle]", "[data-lang-toggle]"]) {
      assert.ok(selectors.has(retired), `${retired} must stay declared so its absence is asserted`);
      for (const item of ALL_CONTRACT_ITEMS) {
        assert.ok(!item.required.includes(retired), `${item.id} must not require the retired ${retired}`);
      }
    }
  });

  it("names the module's whole public surface (nothing accidental escapes)", () => {
    assert.deepEqual(
      Object.keys(contract).sort(),
      [
        "ALL_CONTRACT_ITEMS",
        "AUXILIARY_HOOKS",
        "BLOCK_CONTRACT",
        "BROWSER_LAYER_RULES",
        "CONSISTENCY_CONTRACT",
        "CONTRACT_SOURCE",
        "DOMAINS",
        "MANUAL_RULES",
        "RULE_KINDS",
        "SCOPES",
        "SOURCE_CHECKS",
        "SOURCE_LAYER_RULES",
        "STALE_PROSE_COUNTS",
        "allSelectors",
        "isHookSelector",
        "parseHookSelector",
        "validateContract",
      ],
    );
  });
});
