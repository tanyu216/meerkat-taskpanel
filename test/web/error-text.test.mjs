/**
 * A refusal is rendered from its **code**, in the reader's language
 * (T-20261014-152924 ④).
 *
 * The bug this file pins down: the board used to print the server's own
 * `message`, which for a refused write is the storage engine talking —
 * `CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'` is what a
 * drag of a claimed card back to Backlog produced. Nothing a reader can act on
 * lives in that string, and it is not translatable.
 *
 * So there are four properties to hold, and they are asserted over the whole
 * vocabulary rather than on one code:
 *
 *   1. **Every mapped key resolves in both languages.** A code with a sentence
 *      in `en` and none in `zh` would fall back to `en` silently — the parity
 *      contract `i18n.parity.test.mjs` states for the table, restated for *this*
 *      consumer (a mapping entry may name a key that does not exist at all).
 *   2. **A code without a sentence falls back to `error.generic`** — including
 *      the internal codes (`EXECUTION_STATE_CORRUPT`, `VALIDATION_FAILED`,
 *      `SQLITE_UNAVAILABLE`) and any code a newer server invents. A code the
 *      board does not know must still say something readable.
 *   3. **No rendered sentence ever contains engine text**, in either language,
 *      for any of the message shapes the mapper can produce.
 *   4. **A code covering more than one refusal shape answers from the shape**
 *      (T-20261015-175921) — `RELATION_CYCLE`'s ancestor join is not a loop and
 *      may not read as one. Asserted against the domain's own refusal, so the
 *      literal the rule keys on is the producer's, not a restatement of it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBlockEdgeAllowed } from "../../src/core/domain/relation.mjs";
import { CATALOGUE, DEFAULT_LANGUAGE, LANGUAGES, hasKey } from "../../web/src/i18n/catalogue.mjs";
import { EXTRA } from "../../web/src/i18n/extra.mjs";
import {
  ERROR_TEXT_KEYS,
  ERROR_VOCABULARY_KEYS,
  GENERIC_ERROR_KEY,
  SHAPE_TEXT_KEYS,
  errorText,
  errorTextKey,
  resolveText,
} from "../../web/src/i18n/messages.mjs";

/** The acceptance-③/④ predicate: text that belongs to the storage engine. */
const ENGINE_TEXT = /constraint failed|SQLITE|SqliteError|NOT NULL constraint|UNIQUE constraint/;

/** Does `key` resolve in `language` — in the catalogue or in the extra table? */
function resolves(language, key) {
  return hasKey(language, key) || Object.prototype.hasOwnProperty.call(EXTRA[language] ?? {}, key);
}

/** Every key this vocabulary can render through — both tables and the fallback. */
const KEYS = [...new Set(ERROR_VOCABULARY_KEYS.concat([GENERIC_ERROR_KEY]))];

describe("web/i18n — the error vocabulary is complete in both languages", () => {
  it("resolves every mapped key, in every language the app ships", () => {
    const dangling = [];
    for (const key of KEYS) {
      for (const language of LANGUAGES) {
        if (!resolves(language, key)) dangling.push(`${key} (${language})`);
        else if (resolveText(language, key).trim() === "") dangling.push(`${key} (${language}) is empty`);
      }
    }
    assert.deepEqual(dangling, [], `keys with no sentence: ${dangling.join(", ")}`);
    assert.ok(KEYS.length > 1, "the generic fallback is not the whole vocabulary");
  });

  it("reads the same in en and zh — the two halves of every sentence exist", () => {
    // Same shape, different words: a translated string may not be the English
    // one left in place, and neither may be missing (the fallback would hide it).
    assert.notDeepEqual(
      LANGUAGES.map((language) => resolveText(language, GENERIC_ERROR_KEY)),
      [resolveText(DEFAULT_LANGUAGE, GENERIC_ERROR_KEY), resolveText(DEFAULT_LANGUAGE, GENERIC_ERROR_KEY)],
      "error.generic is not actually translated",
    );
    for (const key of KEYS) {
      const en = resolveText("en", key);
      const zh = resolveText("zh", key);
      assert.equal(en === zh, false, `${key} is identical in both languages: ${en}`);
      // A placeholder is part of the sentence's shape: a translation that drops
      // one silently loses the card's ref.
      assert.equal(
        [...en.matchAll(/%s/g)].length,
        [...zh.matchAll(/%s/g)].length,
        `${key}: the %s count differs between en and zh`,
      );
    }
  });

  it("keeps the vocabulary out of the frozen catalogue (extra is only for new states)", () => {
    for (const key of KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(CATALOGUE.en, key),
        false,
        `error vocabulary redefines the prototype catalogue key ${key}`,
      );
    }
  });
});

describe("web/i18n — a code becomes a sentence", () => {
  it("maps each known code to its own key", () => {
    for (const [code, key] of Object.entries(ERROR_TEXT_KEYS)) {
      assert.equal(errorTextKey({ code }), key, code);
    }
  });

  it("falls back to error.generic for everything without a sentence", () => {
    const unmapped = [
      // Internal states: a reader can do nothing with any of them.
      { code: "EXECUTION_STATE_CORRUPT" },
      { code: "VALIDATION_FAILED" },
      { code: "SQLITE_UNAVAILABLE" },
      { code: "MIGRATION_CHECKSUM_MISMATCH" },
      // A code from a newer server than this bundle.
      { code: "SOME_FUTURE_CODE" },
      // Not an error at all.
      { message: "boom" },
      null,
      undefined,
      "nope",
    ];
    for (const err of unmapped) {
      assert.equal(errorTextKey(err), GENERIC_ERROR_KEY, JSON.stringify(err));
      assert.equal(errorText("en", err), resolveText("en", GENERIC_ERROR_KEY));
      assert.equal(errorText("zh", err), resolveText("zh", GENERIC_ERROR_KEY));
    }
  });

  it("names the card when the sentence has room for it, and never leaves a %s", () => {
    assert.equal(errorText("en", { code: "NOT_FOUND" }, ["TD-1"]), resolveText("en", "error.notFound", ["TD-1"]));
    assert.match(errorText("en", { code: "NOT_FOUND" }, ["TD-1"]), /TD-1/);
    // The generic sentence carries no placeholder, so a ref passed anyway is
    // dropped rather than printed.
    assert.equal(errorText("en", { code: "SOME_FUTURE_CODE" }, ["TD-1"]).includes("%s"), false);
    assert.equal(errorText("en", { code: "SOME_FUTURE_CODE" }, ["TD-1"]).includes("TD-1"), false);
  });
});

/**
 * The fourth property, and the reason `errorTextKey` reads `details` at all
 * (T-20261015-175921, from R-4 of T-20261015-132952).
 *
 * `RELATION_CYCLE` is one code over three refusals: a `blocks` loop, a
 * parent-chain cycle, and an edge joining an **ancestor and a descendant** of
 * the parent chain. Only the first two are loops; for the third the board used
 * to say "a card cannot wait on itself", which is not what happened to that
 * graph. The wire already tells the shape apart — `domain/relation.mjs` sets
 * `details.chain = "ancestor"`, and `test/contract/invariants.test.mjs` asserts
 * that reason is "distinguishable from a loop" — so the mapper reads it.
 */
describe("web/i18n — one code, more than one shape", () => {
  it("answers the ancestor join from its own sentence, not the loop's", () => {
    const ancestor = errorTextKey({ code: "RELATION_CYCLE", details: { chain: "ancestor" } });
    assert.equal(ancestor, "error.relationAncestor");
    assert.notEqual(ancestor, ERROR_TEXT_KEYS.RELATION_CYCLE);
    // The whole point: the reader is not told about a loop that is not there.
    for (const language of LANGUAGES) {
      const text = resolveText(language, ancestor);
      assert.notEqual(text, resolveText(language, ERROR_TEXT_KEYS.RELATION_CYCLE));
      assert.equal(/%s/.test(text), false, `${language}: the pair is named in words, not by a ref`);
    }
  });

  it("keeps the loop's sentence for every shape that is not that one", () => {
    // A wire from a server older than the field, a refusal with no details, and
    // the two shapes that *are* loops — all unchanged.
    const loop = ERROR_TEXT_KEYS.RELATION_CYCLE;
    const shapes = [
      { code: "RELATION_CYCLE" },
      { code: "RELATION_CYCLE", details: {} },
      { code: "RELATION_CYCLE", details: { chain: "loop" } },
      { code: "RELATION_CYCLE", details: { chain: null } },
      // The `blocks` loop and the parent-chain cycle carry no `chain` field.
      { code: "RELATION_CYCLE", details: { source: "a", target: "b", type: "blocks" } },
      // `SELF_REFERENCE` is the one-node case of the loop's own words.
      { code: "SELF_REFERENCE", details: { chain: "ancestor" } },
    ];
    for (const err of shapes) {
      assert.equal(errorTextKey(err), loop, JSON.stringify(err));
    }
  });

  it("fires only when both halves of a rule hold", () => {
    // `ancestor` on another field, or a near-miss value, is not this refusal.
    assert.equal(errorTextKey({ code: "RELATION_CYCLE", details: { chained: "ancestor" } }), ERROR_TEXT_KEYS.RELATION_CYCLE);
    assert.equal(errorTextKey({ code: "RELATION_CYCLE", details: { chain: "ancestors" } }), ERROR_TEXT_KEYS.RELATION_CYCLE);
    // The rule's own half: a *known* code, so a shape rule cannot map a code the
    // board does not otherwise speak about.
    const codes = new Set(Object.keys(ERROR_TEXT_KEYS));
    for (const rule of SHAPE_TEXT_KEYS) {
      assert.equal(codes.has(rule.code), true, `${rule.code} has no entry in the code table`);
      assert.equal(ERROR_VOCABULARY_KEYS.includes(rule.key), true, `${rule.key} is outside the vocabulary sweep`);
    }
  });

  it("renders the domain's own refusal, not a hand-built one", () => {
    // The literal the rule keys on is the domain's, so this walks the producer
    // rather than restating it: an edge joining a card to its own ancestor.
    let thrown;
    try {
      assertBlockEdgeAllowed({ source: "child", target: "parent", type: "blocks" }, {
        edges: [],
        parentEdges: [{ source: "parent", target: "child" }],
      });
      assert.fail("expected the ancestor join to be refused");
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown.code, "RELATION_CYCLE");
    assert.equal(thrown.details.chain, "ancestor");
    assert.equal(errorTextKey(thrown), "error.relationAncestor");
    assert.match(errorText("en", thrown), /ancestor and a descendant/);
  });
});

describe("web/i18n — engine text never reaches a rendered sentence", () => {
  it("renders every code against a raw SQLite message without echoing it", () => {
    const rawMessages = [
      "CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'",
      "UNIQUE constraint failed: tasks.project_id, tasks.identifier",
      "NOT NULL constraint failed: tasks.title",
      "FOREIGN KEY constraint failed",
      "SqliteError: SQLITE_MISUSE",
      "near \"x\": syntax error",
    ];
    const codes = Object.keys(ERROR_TEXT_KEYS).concat([
      "VALIDATION_FAILED",
      "INTERNAL",
      "SQLITE_UNAVAILABLE",
      "",
      "CLAIM_ON_BACKLOG",
    ]);
    for (const language of LANGUAGES) {
      for (const code of codes) {
        for (const message of rawMessages) {
          const text = errorText(language, { code, message }, ["TD-1"]);
          assert.equal(ENGINE_TEXT.test(text), false, `${language}/${code}: ${text}`);
          assert.equal(text.includes(message), false, `${language}/${code} echoed the wire's message`);
        }
      }
    }
  });

  it("is what the sweep over the whole vocabulary would find: zero hits", () => {
    // The card's scan, as an assertion: render *every* code the server can send
    // (the contract snapshot's list) against every raw message shape, in both
    // languages, and count the hits. The expected count is 0.
    const hits = [];
    for (const language of LANGUAGES) {
      for (const code of Object.keys(ERROR_TEXT_KEYS)) {
        const text = errorText(language, { code, message: "UNIQUE constraint failed: tasks.id" }, ["TD-1"]);
        if (ENGINE_TEXT.test(text)) hits.push(`${language}/${code}: ${text}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
