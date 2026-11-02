/**
 * The single acceptance vocabulary (0038/0002).
 *
 * A card stores exactly one word — `off | auto | human` — chosen by its
 * creator. There is no project default and no `agent` card word.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CARD_ACCEPTANCE_MODES,
  acceptanceAllows,
  acceptanceAuthorityFor,
  assertAcceptanceAuthority,
  assertCardAcceptance,
  cardAcceptanceOf,
  normalizeCardAcceptance,
  resolveCardAcceptance,
} from "../../../src/core/domain/acceptance-mode.mjs";

const throwsCode = (fn, code) => assert.throws(fn, (err) => err?.code === code);

describe("domain/acceptance-mode — vocabulary", () => {
  it("stores off, auto and human; agent is gone", () => {
    assert.deepEqual([...CARD_ACCEPTANCE_MODES], ["off", "auto", "human"]);
    assert.equal(normalizeCardAcceptance(" AUTO "), "auto");
    assert.equal(normalizeCardAcceptance(" human "), "human");
    assert.equal(normalizeCardAcceptance("agent"), null);
    assert.equal(normalizeCardAcceptance("sometimes"), null);
    assert.equal(assertCardAcceptance("auto"), "auto");
    assert.equal(assertCardAcceptance("human"), "human");
    throwsCode(() => assertCardAcceptance("agent"), "VALIDATION_FAILED");
  });

  it("reads an unreadable row as its default, auto", () => {
    assert.equal(cardAcceptanceOf(null), "auto");
    assert.equal(cardAcceptanceOf("agent"), "auto");
    assert.equal(cardAcceptanceOf("human"), "human");
  });
});

describe("domain/acceptance-mode — resolveCardAcceptance", () => {
  it("forces a review card to off and refuses a review of a review", () => {
    assert.equal(resolveCardAcceptance({ reviewCard: true }).mode, "off");
    assert.equal(resolveCardAcceptance({ reviewCard: true }).source, "review_card");
    throwsCode(() => resolveCardAcceptance({ reviewCard: true, requested: "auto" }), "VALIDATION_FAILED");
    throwsCode(() => resolveCardAcceptance({ reviewCard: true, requested: "human" }), "VALIDATION_FAILED");
  });

  it("lets an explicit card value win", () => {
    assert.equal(resolveCardAcceptance({ requested: "off" }).mode, "off");
    assert.equal(resolveCardAcceptance({ requested: "auto" }).mode, "auto");
    assert.equal(resolveCardAcceptance({ requested: "human" }).mode, "human");
    assert.equal(resolveCardAcceptance({ requested: "auto" }).source, "requested");
  });

  it("falls an unresolved card — task or epic — back to auto", () => {
    assert.equal(resolveCardAcceptance({}).mode, "auto");
    assert.equal(resolveCardAcceptance({}).source, "fallback");
    assert.equal(resolveCardAcceptance({ kind: "epic" }).mode, "auto");
    assert.equal(resolveCardAcceptance({ kind: "epic" }).source, "fallback");
  });

  it("refuses an unknown value instead of guessing", () => {
    throwsCode(() => resolveCardAcceptance({ requested: "agent" }), "VALIDATION_FAILED");
    throwsCode(() => resolveCardAcceptance({ requested: "sometimes" }), "VALIDATION_FAILED");
  });
});

describe("domain/acceptance-mode — acceptanceAllows", () => {
  it("off lets any non-blank writer close the card", () => {
    assert.equal(acceptanceAllows("human", "off"), true);
    assert.equal(acceptanceAllows("system", "off"), true);
    assert.equal(acceptanceAllows("claude", "off"), true);
    assert.equal(acceptanceAllows("", "off"), false);
  });

  it("auto is closed by anyone but the actor who wrote the verdict, and a human always", () => {
    // The APPROVE is the authority; the kind only says which platform wrote.
    assert.equal(acceptanceAllows("human", "auto", { actorId: "r1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "auto", { actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("system", "auto", { actorId: "sys", verdictAuthorId: "r1" }), true);
    assert.equal(acceptanceAllows("claude", "auto", { actorId: "r1", verdictAuthorId: "r1" }), false);
    assert.equal(acceptanceAllows("", "auto", { actorId: "w1", verdictAuthorId: "r1" }), false);
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

  it("refuses the reviewer that wrote an auto card's verdict", () => {
    throwsCode(
      () =>
        assertAcceptanceAuthority(
          { kind: "claude", id: "r1" },
          { mode: "auto", actorId: "r1", verdictAuthorId: "r1" },
        ),
      "ACCEPTANCE_FORBIDDEN",
    );
    assert.equal(
      assertAcceptanceAuthority(
        { kind: "claude", id: "w1" },
        { mode: "auto", actorId: "w1", verdictAuthorId: "r1" },
      ),
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
    const authority = acceptanceAuthorityFor({ acceptance_mode: "auto", review_of_id: null, meta: {} });
    assert.equal(authority.isReview, false);
    assert.equal(authority.mode, "auto");
    assert.equal(authority.canAccept("claude", { actorId: "r1", verdictAuthorId: "r1" }), false);
    assert.equal(authority.canAccept("claude", { actorId: "w1", verdictAuthorId: "r1" }), true);
    assert.equal(authority.canAccept("system", { actorId: "sys", verdictAuthorId: "r1" }), true);
  });
});
