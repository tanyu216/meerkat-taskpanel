/**
 * Resolve a card's **review requirement** at creation.
 *
 * The project's `review_policy` is a default, not the decision:
 *
 *   * `required` — an ordinary card is born requiring an independent review;
 *     a creator cannot opt out;
 *   * `off` — an ordinary card is born not requiring one; a creator cannot opt
 *     in (the project said review is off);
 *   * `optional` — the creator decides. An **agent** (any non-human caller) must
 *     state the decision; a human/UI caller may omit it and gets "no review".
 *
 * A **review card** is always `0`: a review is flow B and can never be dispatched
 * for another review.
 *
 * 0038 replaced this axis with `domain/acceptance-mode.mjs`; the wrapper and the
 * `review_required` column survive one release, and every new write derives one
 * from the other. The legacy result is a snapshot: a later project change does
 * not rewrite cards already in flight.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../foundation/errors.mjs";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICIES,
} from "./enums.mjs";

/**
 * Normalize a policy spelling. Returns `null` for anything outside the
 * vocabulary; the caller decides whether that is an error or a default.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeReviewPolicy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return REVIEW_POLICIES.includes(text) ? text : null;
}

/**
 * Validate a policy spelling, raising the one shape every project write uses.
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertReviewPolicy(value, field = "review_policy") {
  const policy = normalizeReviewPolicy(value);
  if (policy === null) {
    throw new DomainError("VALIDATION_FAILED", {
      message:
        `review policy must be one of ${REVIEW_POLICIES.join(" | ")} ` +
        `(got ${JSON.stringify(value)})`,
      details: { field, received: value, allowed: [...REVIEW_POLICIES] },
    });
  }
  return policy;
}

/**
 * Normalize a project's reviewer override. `null`/absent/blank all mean "use
 * the deployment reviewer"; a non-blank name is trimmed and stored verbatim
 * (the board does not model an agent dictionary it could validate against).
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string|null}
 */
export function normalizeReviewer(value, field = "reviewer") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `reviewer must be a string (got ${JSON.stringify(value)})`,
      details: { field, received: value },
    });
  }
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * Read a stored/requested boolean without trusting a stray `"true"`.
 * The wire declares a boolean; `undefined` means "the creator did not say".
 *
 * @param {unknown} value
 * @param {string} [field]
 * @returns {boolean|undefined}
 */
function resolveRequested(value, field = "review_required") {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === false) return value;
  throw new DomainError("VALIDATION_FAILED", {
    message: `review_required must be a boolean (got ${JSON.stringify(value)})`,
    details: { field, received: value },
  });
}

/**
 * Is this task DTO/row marked as requiring review? Accepts the integer the DB
 * stores and the boolean the wire carries.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function reviewRequiredOf(value) {
  return value === true || Number(value) === 1;
}

/**
 * Resolve the `review_required` snapshot for a new card.
 *
 * @param {{
 *   policy?: unknown,
 *   requested?: unknown,
 *   reviewCard?: boolean,
 *   kind?: string,
 *   requireDecision?: boolean,
 * }} [input]
 * @returns {0|1}
 */
export function resolveReviewRequired(input = {}) {
  const requested = resolveRequested(input.requested);
  const reviewCard = input.reviewCard === true;

  // A review card is never a review target, whatever the project says.
  if (reviewCard) {
    if (requested === true) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "a review card can never require its own review",
        details: { field: "review_required", received: true, reviewCard: true },
        hint: { fix: "create the review card without --review, or omit review_required" },
      });
    }
    return 0;
  }

  const policy = normalizeReviewPolicy(input.policy) ?? DEFAULT_REVIEW_POLICY;
  switch (policy) {
    case "required":
      if (requested === false) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "this project requires review; a card cannot opt out at creation",
          details: { field: "review_required", received: false, policy },
          hint: { fix: "pass --acceptance-mode agent|human instead of opting out" },
        });
      }
      return 1;

    case "off":
      if (requested === true) {
        throw new DomainError("VALIDATION_FAILED", {
          message: "this project has review off; a card cannot opt in at creation",
          details: { field: "review_required", received: true, policy },
          hint: { fix: "pass --acceptance-mode instead; the vocabulary is off|agent|human" },
        });
      }
      return 0;

    case "optional":
    default:
      if (requested === true) return 1;
      if (requested === false) return 0;
      // An agent must make the call in an optional project. The UI (and a human
      // caller) may omit it and gets the documented default: no review.
      if (input.requireDecision === true) {
        throw new DomainError("VALIDATION_FAILED", {
          message:
            "this project's review policy is optional; an agent must state whether the card " +
            "needs an independent review",
          details: { field: "review_required", policy },
          hint: { fix: "pass --acceptance-mode off|agent|human" },
        });
      }
      return 0;
  }
}
