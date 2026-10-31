/**
 * The tick clock's configuration helpers — the pure half.
 *
 * The tick itself (patrol → workflow → poll, in-process, under one lock) is
 * covered by `loop-entries.test.mjs`; this file pins the flag/env/config
 * precedence the supervisor resolves before it runs.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveContinueEnabled,
  resolveIntervalSeconds,
} from "../../src/foundation/scheduling.mjs";

describe("resolveContinueEnabled", () => {
  it("defaults to on", () => {
    assert.equal(resolveContinueEnabled({}), true);
  });

  it("takes flag > env > config > default", () => {
    assert.equal(resolveContinueEnabled({ flag: "no" }), false);
    assert.equal(resolveContinueEnabled({ flag: "yes", env: "no" }), true);
    assert.equal(
      resolveContinueEnabled({ env: "no", file: { MEERKAT_TASKPANEL_CONTINUE: "yes" } }),
      false,
    );
    assert.equal(
      resolveContinueEnabled({ file: { MEERKAT_TASKPANEL_CONTINUE: "no" } }),
      false,
    );
  });

  it("ignores an unrecognised word rather than flipping the default", () => {
    assert.equal(resolveContinueEnabled({ flag: "maybe" }), true);
    assert.equal(resolveContinueEnabled({ flag: "maybe", env: "no" }), false);
  });
});

describe("resolveIntervalSeconds", () => {
  it("takes the first positive integer and otherwise falls back", () => {
    assert.equal(resolveIntervalSeconds({ fallback: 60 }), 60);
    assert.equal(resolveIntervalSeconds({ flag: 90, fallback: 60 }), 90);
    assert.equal(resolveIntervalSeconds({ flag: "90", fallback: 60 }), 90);
    assert.equal(resolveIntervalSeconds({ flag: "nope", env: "120", fallback: 60 }), 120);
    assert.equal(resolveIntervalSeconds({ flag: "0", env: "-1", fallback: 60 }), 60);
    assert.equal(resolveIntervalSeconds({ file: "600", fallback: 60 }), 600);
    assert.equal(resolveIntervalSeconds({ file: "600", env: "120", fallback: 60 }), 120);
  });
});
