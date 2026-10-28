/**
 * The drawer's Acceptance tab renders two different things, and the split is
 * the bug this suite pins:
 *
 *   1. the card's **acceptance criteria** — `task.acceptance`, the frozen
 *      baseline every card carries from creation;
 *   2. the delivery report's **verdicts** — `report.acceptance[]`, one
 *      `{text, status, note}` row per answered criterion, present only after a
 *      delivery.
 *
 * The tab used to render only the second, so a `todo` card's tab was always
 * empty and said "No acceptance criteria yet." even when it had four. The
 * projection below is pure (no Vue, no DOM), so the ordering, the pairing and
 * the empty case are asserted without a browser; the rendered hooks are the
 * browser leg's job (`web/scripts/dom-smoke.mjs`, run by
 * `test/web/blocks.dom.test.mjs`).
 *
 * The matching rule is the core's own: **normalised text** (NFKC, whitespace
 * folded, case-folded), because neither the baseline nor a report carries a
 * stable criterion id (`src/core/domain/acceptance.mjs`). The frontend keeps a
 * copy rather than importing `src/` — the board and the engine are separate
 * trees — so this suite is where the copy is held to that rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { acceptanceKey, acceptanceRowsFor, PENDING_STATUS } from "../../web/src/lib/acceptance.js";
import { EXTRA } from "../../web/src/i18n/extra.mjs";

const report = (text, status, note = "") => ({ text, status, note });

describe("web/acceptance — the card's criteria and the report's verdicts", () => {
  it("lists the card's own criteria as pending when no report exists", () => {
    const rows = acceptanceRowsFor(["A todo card lists its criteria", "The empty state says so"], []);
    assert.deepEqual(
      rows.map((row) => [row.text, row.status, row.paired]),
      [
        ["A todo card lists its criteria", PENDING_STATUS, false],
        ["The empty state says so", PENDING_STATUS, false],
      ],
    );
    assert.equal(PENDING_STATUS, "pending");
  });

  it("pairs each criterion with its verdict by normalised text, keeping the card's spelling", () => {
    const rows = acceptanceRowsFor(
      ["Tab reaches every column", "Esc cancels the move"],
      [report("tab   REACHES every column", "met", "evidence[1]"), report("Esc cancels the move", "not_met")],
    );
    assert.deepEqual(
      rows.map((row) => [row.text, row.status, row.note, row.paired]),
      [
        ["Tab reaches every column", "met", "evidence[1]", true],
        ["Esc cancels the move", "not_met", "", true],
      ],
    );
  });

  it("keeps a report row that answers no criterion, after the criteria", () => {
    const rows = acceptanceRowsFor(["One criterion"], [report("Something else", "partial", "half done")]);
    assert.deepEqual(
      rows.map((row) => [row.text, row.status, row.note, row.extra]),
      [
        ["One criterion", PENDING_STATUS, "", false],
        ["Something else", "partial", "half done", true],
      ],
    );
  });

  it("merges duplicate report rows by key, keeping the worst status", () => {
    const rows = acceptanceRowsFor(
      ["One criterion"],
      [report("One criterion", "met", "first"), report("one criterion", "partial", "second")],
    );
    assert.deepEqual(
      rows.map((row) => [row.status, row.note]),
      [["partial", "first"]],
      "the worst status wins; the first spelling of the text and the first note stay",
    );
  });

  it("is empty only when there are neither criteria nor verdicts", () => {
    assert.deepEqual(acceptanceRowsFor([], []), []);
    assert.equal(acceptanceRowsFor([], [report("An orphan verdict", "met")]).length, 1);
    assert.equal(acceptanceRowsFor(["A criterion"], []).length, 1);
  });

  it("folds text the way the core's acceptanceKey does", () => {
    assert.equal(acceptanceKey("  ＣＬＩ\tworks\n"), "cli works");
    assert.equal(acceptanceKey("A  b"), acceptanceKey("a b"));
    assert.equal(acceptanceKey(42), "");
  });
});

describe("web/acceptance — the tab's copy says what is missing", () => {
  it("no longer claims the card has no acceptance criteria, in either language", () => {
    const en = EXTRA.en["drawer.acceptance.empty"];
    const zh = EXTRA.zh["drawer.acceptance.empty"];
    assert.match(en, /verdict/i, "the English copy names the missing thing: the verdict");
    assert.match(zh, /验收结论/, "the Chinese copy names the missing thing: the verdict");
    // The defect's own clause, asserted directly: before a delivery the card
    // still *has* criteria, so the copy must not say otherwise. Only the
    // verdict is missing, and only the verdict may be reported missing.
    assert.doesNotMatch(en, /criteria/i, "the copy claims the card has no acceptance criteria");
    assert.doesNotMatch(zh, /验收项/, "the copy claims the card has no acceptance items");
  });

  it("names the pending face of a criterion in both languages", () => {
    assert.ok(EXTRA.en["drawer.acceptance.pending"]);
    assert.ok(EXTRA.zh["drawer.acceptance.pending"]);
  });
});
