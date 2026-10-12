/**
 * `identifierText` — the identifier's display value (R8 ③).
 *
 * The rule is fixed by `design/fidelity-r8.md` §2.3: an identifier renders at
 * most **eight characters plus `…`**, and a shorter one renders verbatim with no
 * ellipsis. Three render points use it — the list's rows, the cards and the
 * drawer's head — which is why it is one function rather than three slices.
 *
 * The cap's *trigger* is a nine-character id (`PROJ-0007`), and this suite is the
 * only place one can be constructed: the browser harness runs against a shared
 * fixture whose ids are all short, and the contract forbids special-casing a
 * sample in the render path, so the boundary is pinned here instead.
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
    assert.equal(identifierText("12345678"), "12345678");
    assert.equal(IDENTIFIER_LIMIT, 8);
  });

  it("truncates the ninth character onward and appends one ellipsis", () => {
    assert.equal(identifierText("PROJ-0007"), "PROJ-000…");
    assert.equal(identifierText("PROJ-00071"), "PROJ-000…");
    assert.equal(identifierText("TD-20261012-222353"), "TD-20261…");
  });

  it("counts characters, not widths — the result is always at most nine code units", () => {
    for (const value of ["TD-1", "TD-128", "12345678", "PROJ-0007", "TD-20261012-222353"]) {
      assert.ok(identifierText(value).length <= 9, `${value} rendered ${identifierText(value).length} characters`);
    }
  });

  it("is the same function for every value: the first eight characters plus the ellipsis", () => {
    // The single expression the three render points rely on, stated once — a
    // special case for any particular sample would show up here.
    for (const value of ["PROJ-0007", "PROJ-00071", "ABCDEFGHI", "abcdefghijkl"]) {
      assert.equal(identifierText(value), `${value.slice(0, 8)}…`);
    }
  });

  it("yields the empty string for a missing identifier", () => {
    assert.equal(identifierText(""), "");
    assert.equal(identifierText(null), "");
    assert.equal(identifierText(undefined), "");
  });
});
