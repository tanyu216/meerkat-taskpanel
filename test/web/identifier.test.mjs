/**
 * `identifierText` — the identifier's display value (R8 ③).
 *
 * The rule is fixed by `design/fidelity-r8.md` §2.3: an identifier renders at
 * most **ten characters plus `…`**, and a shorter one renders verbatim with no
 * ellipsis. Every render point uses it — the cards, the list's rows, the
 * waiting queue's rows and the create dialog's two relation fields (their option
 * rows *and* the chips they accept) — which is why it is one function rather
 * than five slices.
 *
 * The cap is **ten** since T-20261014-001418 (Terry, 2026-10-14; it was eight).
 * The widening is the point of `PROJ-0007` below: nine characters used to
 * truncate and must now come through whole, so a regression to eight fails
 * here rather than silently on the board.
 *
 * `design/fidelity-r8.md` §1 R8-2 is why the assertions are about *characters*
 * and never about a width: `.td-id`'s `max-width: 9ch` is a width, it depends on
 * the face's advance width and its `letter-spacing` (measured, it computes to
 * 65.02px), and it cannot promise a character count. `.td-id` is the single-line
 * guard; this function is the cap.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IDENTIFIER_LIMIT, identifierText } from "../../web/src/lib/identifier.js";

describe("web/lib/identifier — identifierText", () => {
  it("renders an identifier shorter than the cap verbatim, with no ellipsis", () => {
    assert.equal(identifierText("TD-1"), "TD-1");
    assert.equal(identifierText("TD-128"), "TD-128");
    assert.equal(identifierText("A"), "A");
  });

  it("leaves an identifier exactly at the cap alone", () => {
    assert.equal(identifierText("TD-12888"), "TD-12888");
    assert.equal(identifierText("1234567890"), "1234567890");
    assert.equal(identifierText("TD-1234567"), "TD-1234567");
    assert.equal(IDENTIFIER_LIMIT, 10);
  });

  it("leaves the nine-character id the old cap used to cut whole", () => {
    // The board's own longest identifier. Under the old cap this was
    // `PROJ-000…`; the widened cap must show it verbatim.
    assert.equal(identifierText("PROJ-0007"), "PROJ-0007");
    assert.equal(identifierText("PROJ-00071"), "PROJ-00071");
  });

  it("truncates the eleventh character onward and appends one ellipsis", () => {
    assert.equal(identifierText("ABCDEFGHIJK"), "ABCDEFGHIJ…");
    assert.equal(identifierText("INVENTORY-0042"), "INVENTORY-…");
    assert.equal(identifierText("TD-20261012-222353"), "TD-2026101…");
  });

  it("counts characters, not widths — the result is always at most eleven code units", () => {
    for (const value of ["TD-1", "TD-128", "1234567890", "PROJ-0007", "INVENTORY-0042", "TD-20261012-222353"]) {
      assert.ok(identifierText(value).length <= 11, `${value} rendered ${identifierText(value).length} characters`);
    }
  });

  it("is the same function for every value: the first ten characters plus the ellipsis", () => {
    // The single expression every render point relies on, stated once — a
    // special case for any particular sample would show up here.
    for (const value of ["INVENTORY-0042", "TD-20261012-222353", "ABCDEFGHIJK", "abcdefghijkl"]) {
      assert.equal(identifierText(value), `${value.slice(0, 10)}…`);
    }
  });

  it("yields the empty string for a missing identifier", () => {
    assert.equal(identifierText(""), "");
    assert.equal(identifierText(null), "");
    assert.equal(identifierText(undefined), "");
  });
});
