/**
 * Step 6: the label domain values (§4.4, rulings F2/F5/F7).
 *
 * Pure logic only: the identity key, the colour rule, the collectability
 * predicate and the row mapping. Registration and the GC are exercised against a
 * real board in `test/core/commands/labels.test.mjs`.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  LABEL_COLUMNS,
  isCollectable,
  labelDisplayName,
  labelFromRow,
  labelToRow,
  nextColor,
  normalizeLabelName,
} from "../../../src/core/domain/labels.mjs";
import { LABEL_PALETTE, LABEL_TTL_DAYS_DEFAULT } from "../../../src/shared/constants.mjs";
import { DomainError } from "../../../src/shared/errors.mjs";

describe("domain/labels — identity is `norm` (F7)", () => {
  it("folds case, NFKC and ALL whitespace into one key", () => {
    for (const raw of ["Bug", "bug", "BUG", "B u g", "  bug  ", "b\t\nu\ng", "ＢＵＧ"]) {
      assert.equal(normalizeLabelName(raw), "bug", raw);
    }
    assert.equal(normalizeLabelName("code review"), "codereview", "word-internal spaces go");
  });

  it("refuses a name that cannot identify a label", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      assert.throws(() => normalizeLabelName(bad), (err) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, "DICTIONARY_INVALID");
        assert.equal(err.http, 422);
        return true;
      });
    }
    assert.throws(() => normalizeLabelName(null), (err) => err.code === "DICTIONARY_INVALID");
    assert.throws(() => normalizeLabelName(42), (err) => err.code === "DICTIONARY_INVALID");
  });

  it("keeps word spacing in the display form (it is not the identity)", () => {
    assert.equal(labelDisplayName("  code   review "), "code review");
    assert.equal(labelDisplayName("Ｂug"), "Bug");
  });
});

describe("domain/labels — colour assignment (F2-A)", () => {
  it("takes the first palette colour the project is not already using", () => {
    assert.equal(nextColor([], LABEL_PALETTE), LABEL_PALETTE[0]);
    assert.equal(nextColor([LABEL_PALETTE[0]], LABEL_PALETTE), LABEL_PALETTE[1]);
    assert.equal(nextColor([LABEL_PALETTE[0], LABEL_PALETTE[2]], LABEL_PALETTE), LABEL_PALETTE[1]);
  });

  it("cycles to the least-used colour once the palette is exhausted, deterministically", () => {
    // Every colour used once, plus a second label on palette[3]: the least-used
    // colours all have 1, and the first of them in palette order wins.
    const used = [...LABEL_PALETTE, LABEL_PALETTE[3]];
    assert.equal(nextColor(used, LABEL_PALETTE), LABEL_PALETTE[0]);

    const skewed = [LABEL_PALETTE[0], LABEL_PALETTE[0], ...LABEL_PALETTE.slice(1)];
    assert.equal(nextColor(skewed, LABEL_PALETTE), LABEL_PALETTE[1], "ties go by palette order");
  });

  it("tolerates a ragged colour list and refuses an empty palette", () => {
    assert.throws(() => nextColor([], []), (err) => err.code === "VALIDATION_FAILED");
    assert.throws(() => nextColor([], null), (err) => err.code === "VALIDATION_FAILED");
    // A colour from another project's palette simply does not count.
    assert.equal(nextColor(["#not-in-palette"], LABEL_PALETTE), LABEL_PALETTE[0]);
  });
});

describe("domain/labels — collectability (F5-B)", () => {
  const label = (over = {}) => ({
    id: "l1",
    useCount: 0,
    archivedAt: null,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const now = "2026-03-01T00:00:00.000Z"; // 59 days after lastSeenAt

  it("needs zero uses, no archive and an expired TTL — all three", () => {
    assert.equal(isCollectable(label(), { now, ttlDays: 30 }), true);
    assert.equal(isCollectable(label(), { now, ttlDays: 90 }), false, "TTL not reached");
    assert.equal(isCollectable(label({ useCount: 1 }), { now, ttlDays: 30 }), false, "still used");
    assert.equal(
      isCollectable(label({ archivedAt: "2026-02-01T00:00:00.000Z" }), { now, ttlDays: 30 }),
      false,
      "already archived",
    );
  });

  it("defaults the TTL to 30 days", () => {
    assert.equal(LABEL_TTL_DAYS_DEFAULT, 30);
    assert.equal(isCollectable(label(), { now }), true);
  });

  it("treats a zero TTL as 'expired as soon as it is untouched'", () => {
    const at = "2026-03-01T00:00:00.000Z";
    assert.equal(isCollectable(label({ lastSeenAt: at }), { now: at, ttlDays: 0 }), true);
  });
});

describe("domain/labels — row mapping", () => {
  it("round-trips a label through a row", () => {
    const row = {
      id: "l1",
      project_id: "proj",
      norm: "bug",
      display_name: "Bug",
      color: "#e5484d",
      use_count: 2,
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-02T00:00:00.000Z",
      archived_at: null,
    };
    const mapped = labelFromRow(row);
    assert.equal(mapped.displayName, "Bug");
    assert.equal(mapped.useCount, 2);
    assert.equal(mapped.projectId, "proj");
    assert.deepEqual(labelToRow(mapped), row);
    assert.equal(labelFromRow(null), null);
    assert.deepEqual(LABEL_COLUMNS, Object.keys(row));
  });

  it("refuses an unknown field rather than dropping it", () => {
    assert.throws(() => labelToRow({ nope: 1 }, ["nope"]), (err) => err.code === "VALIDATION_FAILED");
  });
});
