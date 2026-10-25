/**
 * A project's reviewer override.
 *
 * The board does not model an agent dictionary it could validate a name
 * against, so the one rule is the type: absent/blank means "use the deployment
 * reviewer", a non-string is refused, and a name is trimmed and stored
 * verbatim.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeReviewer } from "../../../src/core/domain/reviewer.mjs";

const throwsCode = (fn, code) => assert.throws(fn, (err) => err?.code === code);

describe("domain/reviewer — the project override", () => {
  it("normalizes a blank reviewer to null", () => {
    assert.equal(normalizeReviewer(undefined), null);
    assert.equal(normalizeReviewer(null), null);
    assert.equal(normalizeReviewer("  "), null);
    assert.equal(normalizeReviewer(" jobs "), "jobs");
    assert.equal(normalizeReviewer("Jobs"), "Jobs", "stored verbatim, not normalized");
    throwsCode(() => normalizeReviewer(42), "VALIDATION_FAILED");
  });

  it("names the field it refused", () => {
    assert.throws(
      () => normalizeReviewer(42, "patch.reviewer"),
      (err) => err.code === "VALIDATION_FAILED" && err.details.field === "patch.reviewer",
    );
  });
});
