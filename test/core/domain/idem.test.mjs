/**
 * The idempotency-key vocabulary (T-20261009-175500-idem-meerkat-taskpanel).
 *
 * Pure functions only — no board, no clock, no Node builtins. The *shape* of the
 * key is a contract between this project and the md base (both must derive the
 * same string for the same card), so the separator and the field order are
 * pinned literally here rather than described.
 *
 * L1 reading: `PROTOCOL §㉙` + `guides/task-interface §14`.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  hasIdemDiscriminator,
  idemKey,
  idemSource,
  isIdemActive,
  normalizeIdem,
} from "../../../src/core/domain/idem.mjs";

describe("domain/idem — the mechanical key", () => {
  it("joins kind | assignee | source | target with a single padded pipe", () => {
    assert.equal(
      idemKey({ kind: "task", assignee: "alice", source: "REV-1", target: "PROJ-1" }),
      "task | alice | REV-1 | PROJ-1",
    );
    // Empty fields keep their slots — a missing assignee must not shift `target`
    // into the `source` column.
    assert.equal(idemKey({ kind: "task", target: "PROJ-9" }), "task |  |  | PROJ-9");
    assert.equal(idemKey(), "task |  |  | ");
  });

  it("trims each field, and defaults `kind` to task", () => {
    assert.equal(idemKey({ kind: " epic ", assignee: "  bob  " }), "epic | bob |  | ");
    assert.equal(idemKey({ kind: "", assignee: "alice" }), " | alice |  | ");
  });

  it("derives source as review_of ‖ parent ‖ empty, in that order", () => {
    assert.equal(idemSource({ reviewOf: "REV-1", parent: "PARENT-1" }), "REV-1");
    assert.equal(idemSource({ parent: "PARENT-1" }), "PARENT-1");
    assert.equal(idemSource({ reviewOf: "   ", parent: "PARENT-1" }), "PARENT-1");
    assert.equal(idemSource({}), "");
    assert.equal(idemSource(), "");
    assert.equal(idemSource({ reviewOf: null, parent: undefined }), "");
  });

  it("normalizeIdem: blank means no key, otherwise the trimmed string", () => {
    assert.equal(normalizeIdem(null), null);
    assert.equal(normalizeIdem(undefined), null);
    assert.equal(normalizeIdem(""), null);
    assert.equal(normalizeIdem("   "), null);
    assert.equal(normalizeIdem("  k-1  "), "k-1");
    assert.equal(normalizeIdem(42), "42");
  });

  it("isIdemActive is the inverse of terminality", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked"]) {
      assert.equal(isIdemActive(status), true, `${status} is active`);
    }
    for (const status of ["done", "canceled"]) {
      assert.equal(isIdemActive(status), false, `${status} releases the key`);
    }
    assert.equal(isIdemActive("nonsense"), true, "an unknown status is not terminal");
  });

  it("hasIdemDiscriminator gates the guard on a non-degenerate key", () => {
    assert.equal(hasIdemDiscriminator({}), false);
    assert.equal(hasIdemDiscriminator({ assignee: "  ", source: " ", target: "" }), false);
    assert.equal(hasIdemDiscriminator({ assignee: "alice" }), true);
    assert.equal(hasIdemDiscriminator({ source: "REV-1" }), true);
    assert.equal(hasIdemDiscriminator({ target: "PROJ-1" }), true);
  });
});
