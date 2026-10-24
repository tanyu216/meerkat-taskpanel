/**
 * The single acceptance vocabulary (0038).
 *
 * One project-level default (`auto | off | agent | human`) and one card-level
 * snapshot (`off | agent | human`). `auto` is a delegation word, never a stored
 * card value: the creator resolves it at creation and the card keeps the
 * concrete answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CARD_ACCEPTANCE_MODES,
  PROJECT_ACCEPTANCES,
  acceptanceAllows,
  assertAcceptanceAuthority,
  assertCardAcceptance,
  normalizeCardAcceptance,
  normalizeProjectAcceptance,
  resolveCardAcceptance,
} from "../../../src/core/domain/acceptance-mode.mjs";

const throwsCode = (fn, code) => assert.throws(fn, (err) => err?.code === code);

describe("domain/acceptance-mode — vocabulary", () => {
  it("keeps auto out of the stored card vocabulary", () => {
    assert.deepEqual([...CARD_ACCEPTANCE_MODES], ["off", "agent", "human"]);
    assert.deepEqual([...PROJECT_ACCEPTANCES], ["auto", "off", "agent", "human"]);
    assert.equal(normalizeCardAcceptance(" AGENT "), "agent");
    assert.equal(normalizeCardAcceptance("auto"), null);
    assert.equal(normalizeCardAcceptance("sometimes"), null);
    assert.equal(normalizeProjectAcceptance(" AUTO "), "auto");
    assert.equal(normalizeProjectAcceptance("agent"), "agent");
    assert.equal(normalizeProjectAcceptance("sometimes"), null);
    throwsCode(() => assertCardAcceptance("auto"), "VALIDATION_FAILED");
    assert.equal(assertCardAcceptance("human"), "human");
  });
});

describe("domain/acceptance-mode — resolveCardAcceptance", () => {
  it("forces a review card to off and refuses a review of a review", () => {
    assert.equal(resolveCardAcceptance({ reviewCard: true }).mode, "off");
    assert.equal(resolveCardAcceptance({ reviewCard: true, projectAcceptance: "agent" }).mode, "off");
    throwsCode(
      () => resolveCardAcceptance({ reviewCard: true, requested: "agent" }),
      "VALIDATION_FAILED",
    );
    throwsCode(
      () => resolveCardAcceptance({ reviewCard: true, requested: "human" }),
      "VALIDATION_FAILED",
    );
  });

  it("lets an explicit card value win over the project default", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "human", requested: "off" }).mode, "off");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "off", requested: "agent" }).mode, "agent");
  });

  it("adopts a concrete project default", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "off" }).mode, "off");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "agent" }).mode, "agent");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "human" }).mode, "human");
  });

  it("resolves project auto by the creator, and falls back to human", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", requested: "agent" }).mode, "agent");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto" }).mode, "human");
    // Missing project (a direct/importer write) is the same safe fallback.
    assert.equal(resolveCardAcceptance({}).mode, "human");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto" }).source, "fallback");
  });

  it("falls an unresolved epic back to off — the board closes its rollup", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic" }).mode, "off");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic" }).source, "fallback");
    // An explicit value still wins.
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic", requested: "agent" }).mode,
      "agent",
    );
  });

  it("refuses an unknown value instead of guessing", () => {
    throwsCode(() => resolveCardAcceptance({ requested: "auto" }), "VALIDATION_FAILED");
    throwsCode(() => resolveCardAcceptance({ requested: "sometimes" }), "VALIDATION_FAILED");
    throwsCode(() => resolveCardAcceptance({ projectAcceptance: "sometimes" }), "VALIDATION_FAILED");
  });
});

describe("domain/acceptance-mode — acceptanceAllows", () => {
  it("off lets any non-blank writer close the card", () => {
    assert.equal(acceptanceAllows("human", "off"), true);
    assert.equal(acceptanceAllows("taskd", "off"), true);
    assert.equal(acceptanceAllows("claude", "off"), true);
    assert.equal(acceptanceAllows("", "off"), false);
  });

  it("agent is closed by the human or the board, never an arbitrary worker", () => {
    assert.equal(acceptanceAllows("human", "agent"), true);
    assert.equal(acceptanceAllows("taskd", "agent"), true);
    assert.equal(acceptanceAllows("claude", "agent"), false);
    assert.equal(acceptanceAllows("", "agent"), false);
  });

  it("human is closed by a human only", () => {
    assert.equal(acceptanceAllows("human", "human"), true);
    assert.equal(acceptanceAllows("taskd", "human"), false);
    assert.equal(acceptanceAllows("claude", "human"), false);
  });

  it("a review card is only closed by the human or the board, whatever its mode", () => {
    assert.equal(acceptanceAllows("human", "off", { reviewCard: true }), true);
    assert.equal(acceptanceAllows("taskd", "off", { reviewCard: true }), true);
    assert.equal(acceptanceAllows("claude", "off", { reviewCard: true }), false);
  });
});

describe("domain/acceptance-mode — assertAcceptanceAuthority", () => {
  it("names the mode and the actor kind in the refusal", () => {
    assert.throws(
      () => assertAcceptanceAuthority({ kind: "claude", id: "linus" }, { mode: "human" }),
      (err) => {
        assert.equal(err.code, "ACCEPTANCE_FORBIDDEN");
        assert.equal(err.details.mode, "human");
        assert.equal(err.details.actorKind, "claude");
        return true;
      },
    );
    assert.equal(
      assertAcceptanceAuthority({ kind: "human", id: "terry" }, { mode: "human" }),
      true,
    );
  });

  it("refuses a blank actor kind everywhere", () => {
    for (const mode of CARD_ACCEPTANCE_MODES) {
      throwsCode(() => assertAcceptanceAuthority({ kind: "" }, { mode }), "ACCEPTANCE_FORBIDDEN");
    }
  });
});
