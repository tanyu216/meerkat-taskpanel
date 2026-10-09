/**
 * The combobox matching + roster rules (B22/B24/B25), browser-free.
 *
 * These are the behaviours the contract calls out: prefix → contains →
 * subsequence ranking, the `· new` row offered only for a free-text control, and
 * a roster that keeps the first spelling while treating `bug` / `Bug` / `bug ` as
 * one entry (C10's "the label control is the roster control").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { comboOptions, createRoster, matchEntries, rosterKey, subsequence } from "../../web/src/lib/combo.js";

describe("web/combo — matching", () => {
  it("ranks prefix before contains before subsequence", () => {
    const entries = [{ name: "alina" }, { name: "linus" }, { name: "lion" }];
    // "li": prefix (linus, lion) beats contains (alina has "li" not at 0? a-l-i…) — assert order within buckets.
    assert.deepEqual(matchEntries(entries, "li").map((e) => e.name), ["linus", "lion", "alina"]);
  });

  it("only consults the fuzzy bucket after every real prefix/contains hit", () => {
    const entries = [{ name: "linus" }, { name: "lns-match" }];
    // "lns" is a *subsequence* of "linus" but a *prefix* of "lns-match", so the
    // prefix row must rank first — nothing fuzzy outranks a real hit.
    assert.deepEqual(matchEntries(entries, "lns").map((e) => e.name), ["lns-match", "linus"]);
  });

  it("is case-insensitive and returns the whole roster for an empty query", () => {
    const entries = [{ name: "Terry" }, { name: "elon" }];
    assert.deepEqual(matchEntries(entries, "").map((e) => e.name), ["Terry", "elon"]);
    assert.deepEqual(matchEntries(entries, "TER").map((e) => e.name), ["Terry"]);
  });

  it("matches on any supplied key (id or title for a task row)", () => {
    const rows = [{ name: "TD-1", keys: ["TD-1", "Wire the board"] }];
    assert.equal(matchEntries(rows, "board").length, 1);
    assert.equal(matchEntries(rows, "TD-1").length, 1);
  });

  it("treats the needle as a subsequence, not a substring", () => {
    assert.equal(subsequence("lns", "linus"), true);
    assert.equal(subsequence("sul", "linus"), false);
    assert.equal(subsequence("", "anything"), true);
  });
});

describe("web/combo — rosters keep the first spelling", () => {
  it("normalises case and whitespace to one key", () => {
    assert.equal(rosterKey("  Bug "), "bug");
    const roster = createRoster(["Bug"]);
    assert.equal(roster.get("bug").name, "Bug");
    assert.equal(roster.get("  BUG ").name, "Bug");
  });

  it("upsert keeps the existing spelling and ignores blanks", () => {
    const roster = createRoster(["bug"]);
    assert.equal(roster.upsert("Bug").name, "bug");
    assert.equal(roster.upsert("   "), null);
    assert.deepEqual(roster.all().map((e) => e.name), ["bug"]);
  });

  it("grows only by use", () => {
    const roster = createRoster([]);
    roster.upsert("docs");
    assert.deepEqual(roster.all().map((e) => e.name), ["docs"]);
  });
});

describe("web/combo — the `· new` row", () => {
  it("is offered for a free-text control when the typed name is unknown", () => {
    const roster = createRoster(["bug"]);
    const { isNew } = comboOptions({ roster, query: "perf", freeText: true });
    assert.equal(isNew, true);
  });

  it("is not offered when the name already exists or the control is not free-text", () => {
    const roster = createRoster(["bug"]);
    assert.equal(comboOptions({ roster, query: "bug", freeText: true }).isNew, false);
    assert.equal(comboOptions({ roster, query: "perf", freeText: false }).isNew, false);
    assert.equal(comboOptions({ roster, query: "", freeText: true }).isNew, false);
  });

  it("drops what is already chosen from a multi control", () => {
    const roster = createRoster(["bug", "docs"]);
    const { entries } = comboOptions({ roster, query: "", freeText: true, chosen: ["bug"] });
    assert.deepEqual(entries.map((e) => e.name), ["docs"]);
  });
});
