/**
 * `initialsOf` — the pure project-monogram contract (B03 rail).
 *
 * The sidebar rail (≤1023px) shows one 24×24 chip per project, and that chip's
 * text is this function's output. The rule is fixed: multi-word → the initial of
 * the first three words; single word → its first three letters; blank → empty.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialsOf } from "../../web/src/lib/monogram.js";

describe("web/lib/monogram — initialsOf", () => {
  it("takes the first three letters of a single word, uppercased", () => {
    assert.equal(initialsOf("Orchestrator"), "ORC");
    assert.equal(initialsOf("TaskPanel"), "TAS");
    assert.equal(initialsOf("taskpanel"), "TAS");
    assert.equal(initialsOf("Pi"), "PI");
  });

  it("takes the initial of each word, at most three", () => {
    assert.equal(initialsOf("Site Refresh"), "SR");
    assert.equal(initialsOf("task panel"), "TP");
    assert.equal(initialsOf("One Two Three Four"), "OTT");
  });

  it("collapses loose whitespace and casing", () => {
    assert.equal(initialsOf("  site   refresh  "), "SR");
    assert.equal(initialsOf("Mixed CASE Name"), "MCN");
  });

  it("yields the empty string for a blank or missing name", () => {
    assert.equal(initialsOf(""), "");
    assert.equal(initialsOf("   "), "");
    assert.equal(initialsOf(null), "");
    assert.equal(initialsOf(undefined), "");
  });
});
