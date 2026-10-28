/**
 * C-PREFIX-1 M7/M8 — the create-project dialog's prefix input and its refusal copy.
 *
 * The server owns the 1-4 `[A-Z0-9]` rule (M8) and the "already taken" rule
 * (M5); this file pins the half that is a property of the **web source**, the
 * same static-text style as `side-rail-short-code.test.mjs` — no browser, no
 * build, so it runs anywhere:
 *
 *   * the prefix input keeps `maxlength="4"` and `required`, and gains the
 *     mobile/typing hints (`autocapitalize`, `spellcheck`, `autocomplete`);
 *   * the input has **no `pattern`**: `web/scripts/dom-smoke.mjs` submits `####`
 *     and expects the server's 400 to surface as a danger toast, which a native
 *     pattern would prevent (C-PREFIX-1 §7.3 deliberately has no charset pattern);
 *   * `meta.prefix` is posted **verbatim** — no client-side `.toUpperCase()` in
 *     the request body, because the browser has no second copy of the
 *     normalization rule (M1/M2; §7.3 keeps the field's `.trim()`);
 *   * `refusalText()` tells the refusals apart by their declared details, in a
 *     fixed order: taken (`conflictProjectId`) before shape/length (`max`)
 *     before the unusable fallback;
 *   * the new copy exists in both languages, and a refusal leaves the dialog up.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { EXTRA } from "../../web/src/i18n/extra.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const MODAL = resolve(ROOT, "web/src/components/create/CreateProjectModal.vue");

/** @type {string} */
const modal = readFileSync(MODAL, "utf8");

/** The one `[data-create-project-prefix]` input tag. */
const inputTag = (() => {
  const match = modal.match(/<input\b[^>]*\bdata-create-project-prefix\b[^>]*>/);
  assert.ok(match, "CreateProjectModal.vue must render one [data-create-project-prefix] input");
  return match[0];
})();

/** Does the tag carry `name="value"` (attribute order independent)? */
function attr(name, value) {
  return new RegExp(`(?:^|\\s)${name}="${value}"(?:\\s|/?>)`).test(inputTag);
}

/** The `api.createProject({...})` request body. */
const requestBody = (() => {
  const match = modal.match(/api\.createProject\(\{([\s\S]*?)\}\);/);
  assert.ok(match, "CreateProjectModal.vue must call api.createProject({...})");
  return match[1];
})();

/** The body of `refusalText(err)`. */
const refusalBody = (() => {
  const match = modal.match(/function refusalText\(err\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "CreateProjectModal.vue must define refusalText(err)");
  return match[1];
})();

describe("web · C-PREFIX-1 — the prefix input", () => {
  it("keeps the frozen shape: the hook, maxlength 4, and a required field", () => {
    assert.match(inputTag, /v-model="form\.prefix"/, "the input must still bind form.prefix");
    assert.ok(attr("maxlength", "4"), "the input must keep maxlength=\"4\"");
    assert.match(inputTag, /(?:^|\s)required(?=\s|\/?>)/, "the input must keep required");
  });

  it("gains the typing hints: autocapitalize, spellcheck, autocomplete", () => {
    assert.ok(attr("autocapitalize", "characters"), "the input must set autocapitalize=\"characters\"");
    assert.ok(attr("spellcheck", "false"), "the input must set spellcheck=\"false\"");
    assert.ok(attr("autocomplete", "off"), "the input must set autocomplete=\"off\"");
  });

  it("has no pattern attribute — the #### refusal must reach the server", () => {
    assert.doesNotMatch(
      inputTag,
      /(?:^|\s)(?::|v-bind:)?pattern\s*=/,
      "a native pattern would block the POST that dom-smoke's M7 leg needs",
    );
  });

  it("posts meta.prefix verbatim — no case transform", () => {
    assert.match(requestBody, /meta:\s*\{\s*prefix:\s*form\.prefix\b/, "the request body must still carry meta.prefix");
    assert.doesNotMatch(
      requestBody,
      /toUpperCase|toLowerCase/,
      "the browser must not re-case the prefix — that is the server's single normalization (M1/M2)",
    );
  });
});

describe("web · C-PREFIX-1 — the refusal copy", () => {
  it("branches taken → shape/length → unusable, in that order", () => {
    const taken = refusalBody.indexOf("conflictProjectId");
    const shape = refusalBody.indexOf("details.max");
    const unusable = refusalBody.indexOf("toast.projectPrefixUnusable");
    assert.ok(taken >= 0, "refusalText must branch on details.conflictProjectId");
    assert.ok(shape >= 0, "refusalText must branch on details.max");
    assert.ok(unusable >= 0, "refusalText must keep the unusable fallback");
    assert.ok(taken < shape, "the taken refusal is answered first");
    assert.ok(shape < unusable, "the shape/length refusal precedes the unusable fallback");
    assert.match(refusalBody, /details\.max\s*!==\s*undefined/, "the max branch must be an explicit presence check");
    assert.match(refusalBody, /toast\.projectPrefixTooLong/, "the shape/length branch must resolve the new copy");
    assert.match(refusalBody, /toast\.projectPrefixTaken/, "the taken branch must keep its copy");
  });

  it("has the new key in both languages, naming the 1-4 rule", () => {
    const en = EXTRA.en["toast.projectPrefixTooLong"];
    const zh = EXTRA.zh["toast.projectPrefixTooLong"];
    assert.equal(typeof en, "string", "EXTRA.en must carry toast.projectPrefixTooLong");
    assert.equal(typeof zh, "string", "EXTRA.zh must carry toast.projectPrefixTooLong");
    assert.notEqual(en.trim(), "");
    assert.notEqual(zh.trim(), "");
    assert.notEqual(en, zh, "the two languages must not share one sentence");
    for (const [lang, text] of [["en", en], ["zh", zh]]) {
      assert.match(text, /\b1\b/, `${lang} copy must name the lower bound`);
      assert.match(text, /\b4\b/, `${lang} copy must name the upper bound`);
    }
  });

  it("leaves the dialog open on a refusal — only the success path closes it", () => {
    const catchBlock = modal.match(/\}\s*catch\s*\(err\)\s*\{([\s\S]*?)\n\s*\}\n\s*\}\n<\/script>/);
    assert.ok(catchBlock, "submit() must catch its refusal");
    assert.match(catchBlock[1], /pushToast\(refusalText\(err\),\s*"danger"\)/, "the catch must raise the danger toast");
    assert.doesNotMatch(catchBlock[1], /createProjectOpen\.value\s*=\s*false/, "a refusal must not close the dialog");
  });
});
