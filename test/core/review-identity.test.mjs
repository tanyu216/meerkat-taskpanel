/**
 * The one review-identity reader (`foundation/review-identity.mjs`).
 *
 * The bug this closes is not "the marker is missing" — it is that four layers
 * read the marker differently: the acceptance gate read the columns, the
 * workflow's readable key read `meta.review_of`, the SLA patrol read only the
 * meta, and the web read only the columns. A column-only card was therefore a
 * review to one reader and an ordinary card to another. These fixtures pin the
 * single answer for every stored shape.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewIdentityOf } from "../../src/foundation/review-identity.mjs";

describe("reviewIdentityOf", () => {
  it("reads the structural column first (the authoritative shape)", () => {
    const byId = new Map([["orig-1", "PROJ-0001"]]);
    const identity = reviewIdentityOf(
      {
        id: "rev-1",
        review_of_id: "orig-1",
        review_round: 2,
        delivery_round: 1,
        meta: {},
      },
      { byId },
    );
    assert.deepEqual(identity, {
      isReview: true,
      originalId: "orig-1",
      originalRef: "PROJ-0001",
      auditedRound: 2,
      ownRound: 1,
      legacy: false,
    });
  });

  it("falls back to the meta mirror for a legacy row, and flags it", () => {
    const identity = reviewIdentityOf({
      id: "rev-1",
      delivery_round: 1,
      meta: { review_of: "PROJ-0001", review_round: "2" },
    });
    assert.deepEqual(identity, {
      isReview: true,
      originalId: null,
      originalRef: "PROJ-0001",
      auditedRound: 2,
      ownRound: 1,
      legacy: true,
    });
  });

  it("lets the column win when both shapes are present", () => {
    const identity = reviewIdentityOf(
      {
        id: "rev-1",
        review_of_id: "orig-1",
        review_round: 3,
        delivery_round: 1,
        meta: { review_of: "STALE-NAME", review_round: 1 },
      },
      { byId: new Map([["orig-1", "PROJ-0001"]]) },
    );
    assert.equal(identity.originalId, "orig-1");
    assert.equal(identity.auditedRound, 3, "the column round is the structural fact");
    assert.equal(identity.originalRef, "PROJ-0001", "the column resolves the readable name too");
  });

  it("reads the repository DTO spelling too (camelCase)", () => {
    const identity = reviewIdentityOf({
      id: "rev-1",
      reviewOfId: "orig-1",
      reviewRound: 2,
      deliveryRound: 4,
      meta: {},
    });
    assert.equal(identity.isReview, true);
    assert.equal(identity.originalId, "orig-1");
    assert.equal(identity.auditedRound, 2);
    assert.equal(identity.ownRound, 4);
  });

  it("keeps a null audited round (the legacy 'covers every round' reading)", () => {
    const identity = reviewIdentityOf({
      review_of_id: "orig-1",
      delivery_round: 1,
      meta: {},
    });
    assert.equal(identity.auditedRound, null);
    assert.equal(identity.isReview, true);
  });

  it("returns an ordinary-card answer for an ordinary card", () => {
    assert.deepEqual(reviewIdentityOf({ id: "t-1", delivery_round: 3, meta: {} }), {
      isReview: false,
      originalId: null,
      originalRef: null,
      auditedRound: null,
      ownRound: 3,
      legacy: false,
    });
  });

  it("never throws on a missing card or garbage values", () => {
    assert.equal(reviewIdentityOf(null).isReview, false);
    assert.equal(reviewIdentityOf(undefined).ownRound, 0);
    assert.equal(reviewIdentityOf({ review_of_id: 42, review_round: "x", delivery_round: -1 }).auditedRound, null);
    assert.equal(reviewIdentityOf({ meta: { review_of: "  ", review_round: 0 } }).isReview, false);
  });

  it("accepts a plain object as the byId index", () => {
    const identity = reviewIdentityOf(
      { review_of_id: "orig-1", delivery_round: 1, meta: {} },
      { byId: { "orig-1": "PROJ-0001" } },
    );
    assert.equal(identity.originalRef, "PROJ-0001");
  });
});
