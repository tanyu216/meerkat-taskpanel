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
  rollupGapOf,
  unsupportedClaimsOf,
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

describe("domain/acceptance — the rollup gap (0033)", () => {
  const children = [
    { identifier: "P-1", status: "done" },
    { identifier: "P-2", status: "canceled" },
  ];
  const items = [
    { text: "P-1 done", status: "met", ref: "P-1" },
    { text: "P-2 dropped", status: "not_applicable", note: "scope withdrawn", ref: "P-2" },
  ];

  it("accepts a rollup that names every child with the right verdict", () => {
    const gap = rollupGapOf({ children, items });
    assert.equal(gap.ok, true);
    assert.equal(gap.childCount, 2);
    assert.equal(gap.done, 1);
  });

  it("joins by ref, not by prose — a renamed child is the same card", () => {
    const renamed = items.map((item) => ({ ...item, text: "a title that changed later" }));
    assert.equal(rollupGapOf({ children, items: renamed }).ok, true);
  });

  it("names a missing child, an unexpected ref, and a duplicate", () => {
    const missing = rollupGapOf({ children, items: [items[0]] });
    assert.deepEqual(missing.missingChildren, ["P-2"]);
    assert.equal(missing.ok, false);

    const unexpected = rollupGapOf({
      children,
      items: [...items, { text: "stranger", status: "met", ref: "P-9" }],
    });
    assert.deepEqual(unexpected.unexpectedChildren, ["P-9"]);

    const duplicated = rollupGapOf({
      children,
      items: [...items, { text: "again", status: "met", ref: "P-1" }],
    });
    assert.deepEqual(duplicated.duplicates, ["P-1"]);
    assert.equal(duplicated.ok, false);
  });

  it("refuses the wrong verdict for a child's state", () => {
    const notMet = rollupGapOf({
      children,
      items: [{ ...items[0], status: "not_met" }, items[1]],
    });
    assert.equal(notMet.statusMismatches[0].expected, "met");

    const noNote = rollupGapOf({
      children,
      items: [items[0], { ...items[1], note: "" }],
    });
    assert.equal(noNote.statusMismatches[0].expected, "not_applicable with a note");

    const openChild = rollupGapOf({
      children: [...children, { identifier: "P-3", status: "in_progress" }],
      items: [...items, { text: "P-3", status: "met", ref: "P-3" }],
    });
    assert.equal(openChild.statusMismatches[0].expected, "a terminal child");
  });

  it("requires at least one done child and at least one child", () => {
    assert.equal(
      rollupGapOf({
        children: [{ identifier: "P-1", status: "canceled" }],
        items: [{ text: "x", status: "not_applicable", note: "dropped", ref: "P-1" }],
      }).ok,
      false,
      "an all-canceled container delivered nothing",
    );
    assert.equal(rollupGapOf({ children: [], items: [] }).ok, false);
  });

  it("ignores items without a usable ref", () => {
    const gap = rollupGapOf({
      children: [{ identifier: "P-1", status: "done" }],
      items: [{ text: "unjoined", status: "met" }, null, "junk", { text: "x", status: "met", ref: "  " }],
    });
    assert.deepEqual(gap.missingChildren, ["P-1"]);
    assert.equal(gap.ok, false);
  });
});

describe("domain/acceptance — falsifiable claims", () => {
  const anchors = [
    { kind: "commit", sha: "abc1234" },
    { kind: "command", cmd: "node --test test/x.test.mjs", exit_code: 0 },
  ];

  it("flags a met item whose note names no anchor", () => {
    const unsupported = unsupportedClaimsOf({
      reportItems: [
        { text: "works", status: "met" },
        { text: "looks right", status: "met", note: "I checked it" },
      ],
      evidence: anchors,
    });
    assert.deepEqual(unsupported.map((item) => [item.text, item.reason]), [
      ["works", "no_anchor"],
      ["looks right", "no_anchor"],
    ]);
  });

  it("flags a reference that points outside the report's evidence", () => {
    const unsupported = unsupportedClaimsOf({
      reportItems: [{ text: "works", status: "met", note: "evidence[3] — the run" }],
      evidence: anchors,
    });
    assert.deepEqual(unsupported.map((item) => item.reason), ["dangling_anchor"]);
  });

  it("accepts one resolvable reference among several, and ignores non-met statuses", () => {
    assert.deepEqual(
      unsupportedClaimsOf({
        reportItems: [
          { text: "works", status: "met", note: "evidence[9] and evidence[2]" },
          { text: "not applicable", status: "not_applicable", note: "no browser here" },
          { text: "unfinished", status: "partial", note: "no anchor" },
        ],
        evidence: anchors,
      }),
      [],
    );
  });

  it("treats an empty evidence list as one where nothing resolves", () => {
    assert.equal(
      unsupportedClaimsOf({
        reportItems: [{ text: "works", status: "met", note: "evidence[1]" }],
        evidence: [],
      }).length,
      1,
    );
  });
});
