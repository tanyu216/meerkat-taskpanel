/**
 * The per-card review decision (0031).
 *
 * The project's `review_policy` is a default; the card's `review_required` is a
 * snapshot. This file pins the resolution matrix — especially the two places the
 * default is overridden: a review card is always 0, and a deploy card is always
 * 1.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertReviewPolicy,
  normalizeReviewer,
  normalizeReviewPolicy,
  resolveReviewRequired,
  reviewRequiredOf,
} from "../../../src/core/domain/review-policy.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => err?.code === code);

describe("domain/review-policy — vocabulary", () => {
  it("normalizes the three policies and refuses anything else", () => {
    assert.equal(normalizeReviewPolicy(" REQUIRED "), "required");
    assert.equal(normalizeReviewPolicy("off"), "off");
    assert.equal(normalizeReviewPolicy("optional"), "optional");
    assert.equal(normalizeReviewPolicy("sometimes"), null);
    assert.equal(normalizeReviewPolicy(undefined), null);
    throwsCode(() => assertReviewPolicy("sometimes"), "VALIDATION_FAILED");
    assert.equal(assertReviewPolicy("required"), "required");
  });

  it("normalizes a blank reviewer to null", () => {
    assert.equal(normalizeReviewer(undefined), null);
    assert.equal(normalizeReviewer("  "), null);
    assert.equal(normalizeReviewer(" jobs "), "jobs");
    throwsCode(() => normalizeReviewer(42), "VALIDATION_FAILED");
  });

  it("reads the integer column and the boolean wire alike", () => {
    assert.equal(reviewRequiredOf(1), true);
    assert.equal(reviewRequiredOf(true), true);
    assert.equal(reviewRequiredOf(0), false);
    assert.equal(reviewRequiredOf(false), false);
    assert.equal(reviewRequiredOf(undefined), false);
  });
});

describe("domain/review-policy — resolveReviewRequired", () => {
  it("forces a review card to 0, and refuses an opt-in", () => {
    assert.equal(resolveReviewRequired({ policy: "required", reviewCard: true }), 0);
    assert.equal(resolveReviewRequired({ policy: "off", reviewCard: true }), 0);
    throwsCode(
      () => resolveReviewRequired({ policy: "required", reviewCard: true, requested: true }),
      "VALIDATION_FAILED",
    );
  });

  it("leaves an epic to the policy like any other card (0037 retired deploy)", () => {
    assert.equal(resolveReviewRequired({ policy: "off", kind: "epic" }), 0);
    assert.equal(resolveReviewRequired({ policy: "required", kind: "epic" }), 1);
  });

  it("required decides for the card, and refuses an opt-out", () => {
    assert.equal(resolveReviewRequired({ policy: "required" }), 1);
    assert.equal(resolveReviewRequired({ policy: "required", requested: true }), 1);
    throwsCode(
      () => resolveReviewRequired({ policy: "required", requested: false }),
      "VALIDATION_FAILED",
    );
  });

  it("off decides for the card, and refuses an opt-in", () => {
    assert.equal(resolveReviewRequired({ policy: "off" }), 0);
    assert.equal(resolveReviewRequired({ policy: "off", requested: false }), 0);
    throwsCode(
      () => resolveReviewRequired({ policy: "off", requested: true }),
      "VALIDATION_FAILED",
    );
  });

  it("optional lets the creator decide; an agent must say so", () => {
    assert.equal(resolveReviewRequired({ policy: "optional", requested: true }), 1);
    assert.equal(resolveReviewRequired({ policy: "optional", requested: false }), 0);
    // A human/UI caller may omit it and gets the documented default.
    assert.equal(resolveReviewRequired({ policy: "optional" }), 0);
    // A non-human caller must state it.
    throwsCode(
      () => resolveReviewRequired({ policy: "optional", requireDecision: true }),
      "VALIDATION_FAILED",
    );
  });

  it("falls back to optional for an unknown/absent project policy", () => {
    assert.equal(resolveReviewRequired({ policy: undefined, requested: true }), 1);
    assert.equal(resolveReviewRequired({ policy: "garbage" }), 0);
  });
});
