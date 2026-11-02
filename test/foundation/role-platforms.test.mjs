/**
 * Role → platform resolution.
 *
 * Installation location is the routing, so these tests pin three rules:
 * the primary kind wins when it carries the role, a role installed on one kind
 * runs there, and an unavailable preferred kind falls back **only** to another
 * kind that also carries the role — otherwise `effective` is `null` and the
 * caller must not claim.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeRolePlatforms,
  platformChain,
  resolveRolePlatform,
  resolveRolePlatforms,
} from "../../src/foundation/role-platforms.mjs";

const role = (id, installedOn) => ({ id, agent: id, installedOn });

describe("platformChain", () => {
  it("puts the primary kind first, then the fixed order", () => {
    assert.deepEqual(platformChain(role("turing", ["pi", "claude"]), "codex"), ["claude", "pi"]);
    assert.deepEqual(platformChain(role("turing", ["pi", "claude"]), "pi"), ["pi", "claude"]);
    assert.deepEqual(platformChain(role("turing", ["codex"]), "claude"), ["codex"]);
  });

  it("honors the configured kind order after the primary", () => {
    // The configured order flips codex/pi relative to the old fixed order.
    assert.deepEqual(platformChain(role("turing", ["codex", "pi"]), "claude", ["pi", "codex", "claude"]), ["pi", "codex"]);
    assert.deepEqual(platformChain(role("turing", ["pi", "claude"]), "codex", ["pi", "codex", "claude"]), ["pi", "claude"]);
    // The running primary still wins when it carries the role.
    assert.deepEqual(platformChain(role("turing", ["pi", "claude"]), "claude", ["pi", "claude", "codex"]), ["claude", "pi"]);
  });

  it("appends kinds missing from the configured order", () => {
    assert.deepEqual(platformChain(role("turing", ["codex", "pi"]), "claude", ["pi"]), ["pi", "codex"]);
    assert.deepEqual(platformChain(role("turing", ["codex", "pi"]), "claude", []), ["codex", "pi"]);
  });

  it("keeps a single-kind role single and falls back to platform", () => {
    assert.deepEqual(platformChain(role("turing", ["codex"]), null), ["codex"]);
    assert.deepEqual(platformChain({ id: "x", platform: "pi" }, "claude"), ["pi"]);
  });

  it("is empty when the role carries no known kind", () => {
    assert.deepEqual(platformChain({ id: "x" }, "claude"), []);
    assert.deepEqual(platformChain(null, "claude"), []);
  });
});

describe("resolveRolePlatform", () => {
  it("runs on the primary kind when it carries the role", () => {
    const resolved = resolveRolePlatform(role("jobs", ["codex", "claude"]), {
      primaryKind: "claude",
      available: () => true,
    });
    assert.deepEqual(resolved, {
      preferred: "claude",
      effective: "claude",
      fallback: null,
      chain: ["claude", "codex"],
    });
  });

  it("runs on the only kind carrying the role", () => {
    const resolved = resolveRolePlatform(role("turing", ["codex"]), {
      primaryKind: "claude",
      available: () => true,
    });
    assert.equal(resolved.effective, "codex");
    assert.equal(resolved.fallback, null);
  });

  it("falls back to another carrying kind when the preferred one is unavailable", () => {
    const resolved = resolveRolePlatform(role("jobs", ["claude", "pi"]), {
      primaryKind: "claude",
      available: (kind) => kind !== "claude",
    });
    assert.equal(resolved.preferred, "claude");
    assert.equal(resolved.effective, "pi");
    assert.equal(resolved.fallback, "pi");
  });

  it("resolves to null when no carrying kind is available — the card is not claimed", () => {
    const resolved = resolveRolePlatform(role("turing", ["codex"]), {
      primaryKind: "claude",
      available: () => false,
    });
    assert.equal(resolved.effective, null);
    assert.equal(resolved.fallback, null);
  });

  it("treats an absent availability predicate as everything available", () => {
    assert.equal(resolveRolePlatform(role("jobs", ["claude"])).effective, "claude");
  });

  it("accepts a Set of available kinds", () => {
    const resolved = resolveRolePlatform(role("jobs", ["claude", "codex"]), {
      primaryKind: "claude",
      available: new Set(["codex"]),
    });
    assert.equal(resolved.effective, "codex");
    assert.equal(resolved.fallback, "codex");
  });
});

describe("resolveRolePlatforms / describeRolePlatforms", () => {
  const roles = [role("jobs", ["claude"]), role("turing", ["codex"])];

  it("resolves each role independently", () => {
    const map = resolveRolePlatforms(roles, {
      primaryKind: "claude",
      available: (kind) => kind === "claude",
    });
    assert.equal(map.get("jobs").effective, "claude");
    assert.equal(map.get("turing").effective, null);
  });

  it("reports install location, dispatch and fallback", () => {
    const lines = describeRolePlatforms(roles, {
      primaryKind: "claude",
      available: (kind) => kind === "codex",
    });
    assert.equal(lines[0], "role jobs: installed on claude; dispatch unavailable — its cards are not claimed");
    assert.equal(lines[1], "role turing: installed on codex; dispatch codex");
  });

  it("reports a fallback when the preferred kind is down", () => {
    const lines = describeRolePlatforms([role("jobs", ["claude", "pi"])], {
      primaryKind: "claude",
      available: (kind) => kind !== "claude",
    });
    assert.equal(lines[0], "role jobs: installed on claude,pi; dispatch fallback pi (claude unavailable)");
  });
});
