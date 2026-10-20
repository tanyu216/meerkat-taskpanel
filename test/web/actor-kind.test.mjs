/**
 * Reading an actor's platform (`web/src/lib/actor-kind.js`).
 *
 * Two rules are worth pinning here, because both are new with the nine-platform
 * roster and both are easy to get subtly wrong:
 *
 *   * a platform **kind** is an agent, and `platformOfKind` returns it;
 *   * a **name** that happens to be a platform slug is an agent's platform only
 *     when the actor is an agent — a human called `cursor` must not wear a
 *     platform badge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESIGN_PLATFORMS,
  isAgentKind,
  kindLabel,
  platformForActor,
  platformOfKind,
} from "../../web/src/lib/actor-kind.js";

const NINE = ["claude", "codex", "cursor", "opencode", "pi", "openclaw", "grok", "hermes", "gemini"];

describe("DESIGN_PLATFORMS", () => {
  it("names the nine platforms the board gives a badge and a colour to", () => {
    assert.deepEqual([...DESIGN_PLATFORMS], NINE);
  });
});

describe("platformOfKind", () => {
  it("returns every platform, and nothing for the generic kinds", () => {
    for (const platform of NINE) {
      assert.equal(platformOfKind(platform), platform);
      assert.equal(kindLabel(platform), "agent");
      assert.equal(isAgentKind(platform), true);
    }
    for (const kind of ["agent", "human", "unknown", "", null, undefined]) assert.equal(platformOfKind(kind), null);
  });
});

describe("platformForActor", () => {
  it("prefers the kind when it names a platform", () => {
    assert.equal(platformForActor("linus", "claude"), "claude");
    assert.equal(platformForActor("gemini", "codex"), "codex");
  });

  it("falls back to a platform-shaped name for an agent-kind actor", () => {
    assert.equal(platformForActor("Gemini", "agent"), "gemini");
    assert.equal(platformForActor(" cursor ", "agent"), "cursor");
    assert.equal(platformForActor("linus", "agent"), null);
  });

  it("never gives a human a platform, even one named after a platform", () => {
    assert.equal(platformForActor("cursor", "human"), null);
    assert.equal(platformForActor("linus", ""), null);
  });
});
