/**
 * Step 2 side quest: the shared helpers the domain needs but cannot host
 * (`node:crypto` ids) and the gate's repair hint.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { deliverCommandHint } from "../../src/foundation/deliver-hint.mjs";
import {
  contentHash,
  formatIdentifier,
  identifierPrefix,
  isValidIdentifier,
  newId,
  sessionId,
  sha256Hex,
  stableStringify,
  uuidv5,
} from "../../src/foundation/ids.mjs";
import { SESSION_ID_NAMESPACE } from "../../src/foundation/constants.mjs";

describe("shared/ids", () => {
  it("newId is a v4 UUID, twice-distinct", () => {
    const a = newId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, newId());
  });

  it("uuidv5 matches the published RFC 4122 test vector", () => {
    // DNS namespace + "www.example.com" → known v5 value.
    assert.equal(
      uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    assert.equal(uuidv5("x"), uuidv5("x"), "deterministic");
    assert.notEqual(uuidv5("x"), uuidv5("y"));
    assert.match(uuidv5("x", SESSION_ID_NAMESPACE), /^[0-9a-f-]{36}$/);
    assert.throws(() => uuidv5("x", "not-a-uuid"), TypeError);
  });

  it("sessionId is deterministic on (task, owner, seg) and separates all three", () => {
    const id = sessionId("task-1", "linus", "seg2");
    assert.equal(id, sessionId("task-1", "linus", "seg2"));
    assert.notEqual(id, sessionId("task-2", "linus", "seg2"));
    assert.notEqual(id, sessionId("task-1", "elon", "seg2"));
    assert.notEqual(id, sessionId("task-1", "linus", "seg3"));
  });

  it("formats and validates identifiers", () => {
    assert.equal(identifierPrefix("meerkat-taskpanel"), "MEERKAT-TASKPANEL");
    assert.equal(identifierPrefix("demo_x"), "DEMO-X");
    assert.equal(identifierPrefix("  --w_ --"), "W");
    assert.equal(formatIdentifier("meerkat-taskpanel", 7), "MEERKAT-TASKPANEL-0007");
    assert.equal(formatIdentifier("demo", 12345), "DEMO-12345");
    assert.throws(() => formatIdentifier("demo", 0), TypeError);
    assert.throws(() => formatIdentifier("demo", 1.5), TypeError);

    for (const good of ["MEERKAT-TASKPANEL-0007", "T-20261008-230500-meerkat-taskpanel-m1", "a", "A.b_c-d"]) {
      assert.equal(isValidIdentifier(good), true, good);
    }
    for (const bad of ["", " has space", "with/slash", "-leading-dash", null, 7, "x".repeat(200)]) {
      assert.equal(isValidIdentifier(bad), false, String(bad));
    }
  });

  it("hashes stably regardless of key order", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(contentHash({ a: 1, b: [2, 3] }), contentHash({ b: [2, 3], a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
    assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => stableStringify(cyclic), TypeError);
  });
});

describe("shared/deliver-hint", () => {
  it("interpolates the identifier into the single repair command", () => {
    const hint = deliverCommandHint("MEERKAT-TASKPANEL-0007");
    assert.equal(hint.command, "taskctl issue deliver MEERKAT-TASKPANEL-0007 --report-file -");
    assert.match(hint.note, /transaction/);
  });
});
