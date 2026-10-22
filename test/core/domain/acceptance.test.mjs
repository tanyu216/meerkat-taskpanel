/**
 * The acceptance baseline's pure arithmetic: normalisation, the legacy shape,
 * and the coverage gate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptanceFromJson,
  acceptanceKey,
  coverageOf,
  isBlockingStatus,
  normalizeAcceptanceList,
  normalizeAcceptanceText,
} from "../../../src/core/domain/acceptance.mjs";

describe("domain/acceptance — normalisation", () => {
  it("NFKC-folds, collapses whitespace, and trims", () => {
    assert.equal(normalizeAcceptanceText("  ｃｌｉ\tworks\n  "), "cli works");
    assert.equal(normalizeAcceptanceText("a b"), "a b");
    assert.equal(normalizeAcceptanceText(42), "");
  });

  it("keys are case-folded display text", () => {
    assert.equal(acceptanceKey("  The CLI  Works "), "the cli works");
    assert.equal(acceptanceKey("A"), acceptanceKey("a"));
  });

  it("accepts strings and legacy {text, checked}, drops empties, and de-duplicates", () => {
    assert.deepEqual(
      normalizeAcceptanceList([
        " a ",
        { text: "b", checked: true },
        "A",
        "",
        { text: "  ", checked: false },
        null,
        42,
        { text: "c" },
      ]),
      ["a", "b", "c"],
    );
  });

  it("caps the list", () => {
    const many = Array.from({ length: 70 }, (_, i) => `item ${i}`);
    assert.equal(normalizeAcceptanceList(many).length, 60);
    assert.equal(normalizeAcceptanceList(many, { maxItems: 64 }).length, 64);
  });

  it("parses a stored JSON array, and a broken value reads as empty", () => {
    assert.deepEqual(acceptanceFromJson('["a","b"]'), ["a", "b"]);
    assert.deepEqual(acceptanceFromJson("not json"), []);
    assert.deepEqual(acceptanceFromJson(null), []);
  });
});

describe("domain/acceptance — coverage", () => {
  const report = (items) => ({ reportItems: items });

  it("an empty baseline is vacuously covered", () => {
    const result = coverageOf({ baseline: [] });
    assert.equal(result.ok, true);
    assert.equal(result.vacuous, true);
  });

  it("requires every baseline item and accepts met", () => {
    const result = coverageOf({
      baseline: ["cli works", "gate visible"],
      ...report([
        { text: "CLI works", status: "met" },
        { text: "gate visible", status: "met" },
      ]),
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.blocking, []);
    assert.equal(result.ok, true);
  });

  it("reports a missing criterion", () => {
    const result = coverageOf({
      baseline: ["cli works", "gate visible"],
      ...report([{ text: "cli works", status: "met" }]),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing.map((item) => item.text), ["gate visible"]);
  });

  it("blocks partial and not_met", () => {
    const partial = coverageOf({
      baseline: ["a"],
      ...report([{ text: "a", status: "partial" }]),
    });
    assert.equal(partial.ok, false);
    assert.equal(partial.blocking[0].status, "partial");

    const notMet = coverageOf({
      baseline: ["a"],
      ...report([{ text: "a", status: "not_met" }]),
    });
    assert.equal(notMet.ok, false);
    assert.equal(notMet.blocking[0].status, "not_met");
  });

  it("accepts not_applicable only with a note", () => {
    const withNote = coverageOf({
      baseline: ["a"],
      ...report([{ text: "a", status: "not_applicable", note: "canceled by the operator" }]),
    });
    assert.equal(withNote.ok, true);

    const noNote = coverageOf({
      baseline: ["a"],
      ...report([{ text: "a", status: "not_applicable" }]),
    });
    assert.equal(noNote.ok, false);
    assert.equal(noNote.blocking[0].status, "not_applicable");
  });

  it("allows harmless extras but blocks an unfinished extra", () => {
    const harmless = coverageOf({
      baseline: ["a"],
      ...report([
        { text: "a", status: "met" },
        { text: "also checked", status: "met" },
      ]),
    });
    assert.equal(harmless.ok, true);
    assert.equal(harmless.extra.length, 1);

    const unfinished = coverageOf({
      baseline: ["a"],
      ...report([
        { text: "a", status: "met" },
        { text: "also checked", status: "partial" },
      ]),
    });
    assert.equal(unfinished.ok, false);
    assert.equal(unfinished.blocking[0].text, "also checked");
  });

  it("merges duplicate report items to the worst status", () => {
    const result = coverageOf({
      baseline: ["a"],
      ...report([
        { text: "a", status: "met" },
        { text: "A", status: "not_met" },
      ]),
    });
    assert.equal(result.ok, false);
    assert.equal(result.blocking[0].status, "not_met");
  });

  it("reads the legacy object shape as the baseline", () => {
    const result = coverageOf({
      baseline: [{ text: "a", checked: true }],
      ...report([{ text: "a", status: "met" }]),
    });
    assert.equal(result.ok, true);
  });

  it("isBlockingStatus names exactly the two open statuses", () => {
    assert.equal(isBlockingStatus("partial"), true);
    assert.equal(isBlockingStatus("not_met"), true);
    assert.equal(isBlockingStatus("met"), false);
    assert.equal(isBlockingStatus("not_applicable"), false);
  });
});
