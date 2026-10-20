/**
 * The dropdown placement arithmetic (`web/src/lib/anchored-menu.js#placeMenu`).
 *
 * The installer needs a browser (`web/scripts/dom-smoke.mjs` drives it), but the
 * decision it makes — below or above, and how far it may slide sideways — is
 * pure, so it is pinned here without one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeMenu } from "../../web/src/lib/anchored-menu.js";

const viewport = { width: 1000, height: 800 };

describe("placeMenu", () => {
  it("sits 4px below the anchor when there is room", () => {
    const anchor = { top: 76, bottom: 108, left: 272, width: 120 };
    assert.deepEqual(placeMenu(anchor, { width: 180, height: 126 }, viewport), { top: 112, left: 272, upward: false });
  });

  it("flips above when the bottom would overflow and there is room above", () => {
    const anchor = { top: 700, bottom: 732, left: 100, width: 120 };
    assert.deepEqual(placeMenu(anchor, { width: 180, height: 200 }, viewport), { top: 496, left: 100, upward: true });
  });

  it("clamps to the edges when neither side fits", () => {
    const anchor = { top: 300, bottom: 332, left: 100, width: 120 };
    const placed = placeMenu(anchor, { width: 180, height: 900 }, viewport);
    assert.equal(placed.upward, false);
    assert.equal(placed.top, 8, "a menu taller than the viewport pins to the top margin");
  });

  it("keeps the panel inside the horizontal viewport", () => {
    assert.equal(placeMenu({ top: 10, bottom: 42, left: 950, width: 120 }, { width: 180, height: 100 }, viewport).left, 812);
    assert.equal(placeMenu({ top: 10, bottom: 42, left: -20, width: 120 }, { width: 180, height: 100 }, viewport).left, 8);
  });

  it("shrinks the usable width to the viewport before clamping", () => {
    const placed = placeMenu({ top: 10, bottom: 42, left: 100, width: 120 }, { width: 2000, height: 100 }, viewport);
    assert.equal(placed.left, 8);
  });
});
