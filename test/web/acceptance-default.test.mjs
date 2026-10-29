/**
 * The create dialog's acceptance preselect (`web/src/lib/acceptance-default.js`).
 *
 * The client's default mirrors the server's resolution (`domain/acceptance-mode.mjs`):
 * an unresolved card is `agent`, `human` is opt-in, and a project-level `human`
 * is a **top-level** default — a card being given a parent is never preselected
 * human. The modal may not import `src/`, so this is the copy held in step here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CARD_ACCEPTANCE_MODES } from "../../src/core/domain/acceptance-mode.mjs";
import {
  ACCEPTANCE_MODES,
  defaultAcceptanceMode,
} from "../../web/src/lib/acceptance-default.js";

describe("create dialog — the acceptance preselect", () => {
  it("offers exactly the card modes the domain stores", () => {
    assert.deepEqual([...ACCEPTANCE_MODES], [...CARD_ACCEPTANCE_MODES]);
  });

  it("preselects agent for the project auto default and an unknown project word", () => {
    assert.equal(defaultAcceptanceMode("auto"), "agent");
    assert.equal(defaultAcceptanceMode(undefined), "agent");
    assert.equal(defaultAcceptanceMode(""), "agent");
    assert.equal(defaultAcceptanceMode("sometimes"), "agent");
  });

  it("follows a concrete project value", () => {
    assert.equal(defaultAcceptanceMode("off"), "off");
    assert.equal(defaultAcceptanceMode("agent"), "agent");
    assert.equal(defaultAcceptanceMode("human"), "human");
  });

  it("never preselects human for a card with a parent", () => {
    assert.equal(defaultAcceptanceMode("human", { hasParent: true }), "agent");
    assert.equal(defaultAcceptanceMode("auto", { hasParent: true }), "agent");
    // Explicit modes other than human are untouched.
    assert.equal(defaultAcceptanceMode("off", { hasParent: true }), "off");
    assert.equal(defaultAcceptanceMode("agent", { hasParent: true }), "agent");
  });
});
