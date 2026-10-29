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
  acceptanceAuthorityFor,
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

  it("resolves project auto by the creator, and falls back to agent", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", requested: "agent" }).mode, "agent");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto" }).mode, "agent");
    // Missing project (a direct/importer write) is the same fallback.
    assert.equal(resolveCardAcceptance({}).mode, "agent");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto" }).source, "fallback");
  });

  it("falls an unresolved epic back to agent, like every other card", () => {
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic" }).mode, "agent");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic" }).source, "fallback");
    // An explicit value still wins — including `off`, which keeps its meaning.
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic", requested: "agent" }).mode,
      "agent",
    );
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "auto", kind: "epic", requested: "off" }).mode,
      "off",
    );
  });

  it("keeps human top-level only: a card with a parent never resolves to it", () => {
    // An explicit human on a child is refused, whichever card kind it is.
    throwsCode(
      () => resolveCardAcceptance({ requested: "human", hasParent: true }),
      "VALIDATION_FAILED",
    );
    throwsCode(
      () => resolveCardAcceptance({ kind: "epic", requested: "human", hasParent: true }),
      "VALIDATION_FAILED",
    );
    // A project-level human is a top-level default: a child falls back to agent.
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "human", hasParent: true }).mode,
      "agent",
    );
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "human", kind: "epic", hasParent: true }).mode,
      "agent",
    );
    // Top-level still adopts it.
    assert.equal(resolveCardAcceptance({ projectAcceptance: "human" }).mode, "human");
    assert.equal(
      resolveCardAcceptance({ projectAcceptance: "human", kind: "epic" }).mode,
      "human",
    );
    // Explicit off/agent on a child are untouched.
    assert.equal(resolveCardAcceptance({ requested: "off", hasParent: true }).mode, "off");
    assert.equal(resolveCardAcceptance({ projectAcceptance: "off", hasParent: true }).mode, "off");
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
    assert.equal(acceptanceAllows("system", "off"), true);
    assert.equal(acceptanceAllows("claude", "off"), true);
    assert.equal(acceptanceAllows("", "off"), false);
  });

  it("agent is closed by anyone but the actor who wrote the verdict", () => {
    // The APPROVE is the authority; the kind only says which platform wrote.
    assert.equal(acceptanceAllows("human", "agent", { actorId: "r1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "agent", { actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("system", "agent", { actorId: "sys", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "agent", { actorId: "r1", verdictAuthorId: "r1" }), false);
    assert.equal(acceptanceAllows("", "agent", { actorId: "w1", verdictAuthorId: "r1" }), false);
  });

  it("human is closed by a human only", () => {
    assert.equal(acceptanceAllows("human", "human"), true);
    assert.equal(acceptanceAllows("system", "human"), false);
    assert.equal(acceptanceAllows("claude", "human"), false);
  });

  it("a review card is closed after its verdict, never by its author", () => {
    assert.equal(acceptanceAllows("human", "off", { reviewCard: true, actorId: "r1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("system", "off", { reviewCard: true, actorId: "sys", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "off", { reviewCard: true, actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "off", { reviewCard: true, actorId: "r1", verdictAuthorId: "r1" }), false);
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

describe("domain/acceptance-mode — acceptanceAuthorityFor", () => {
  it("derives review identity from the structural column", () => {
    const authority = acceptanceAuthorityFor({ acceptanceMode: "off", reviewOfId: "orig-1", meta: {} });
    assert.equal(authority.isReview, true);
    assert.equal(authority.mode, "off");
    assert.equal(
      authority.canAccept("claude", { actorId: "r1", verdictAuthorId: "r1" }),
      false,
      "the reviewer never closes its own verdict",
    );
    assert.equal(authority.canAccept("claude", { actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(authority.canAccept("human", { actorId: "h1", verdictAuthorId: "r1" }), true);
  });

  it("lets an ordinary off card's deliverer close it", () => {
    const authority = acceptanceAuthorityFor({ acceptanceMode: "off", meta: {} });
    assert.equal(authority.isReview, false);
    assert.equal(authority.canAccept("claude"), true);
  });

  it("reads a legacy meta-only review card", () => {
    const authority = acceptanceAuthorityFor({ acceptanceMode: "off", meta: { review_of: "PROJ-1" } });
    assert.equal(authority.isReview, true);
    assert.equal(authority.canAccept("claude", { actorId: "r1", verdictAuthorId: "r1" }), false);
  });

  it("reads the wire spelling", () => {
    const authority = acceptanceAuthorityFor({ acceptance_mode: "agent", review_of_id: null, meta: {} });
    assert.equal(authority.isReview, false);
    assert.equal(authority.mode, "agent");
    assert.equal(authority.canAccept("claude", { actorId: "r1", verdictAuthorId: "r1" }), false);
    assert.equal(authority.canAccept("claude", { actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(authority.canAccept("system", { actorId: "sys", verdictAuthorId: "r1" }), true);
  });
});
