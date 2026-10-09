/**
 * The Node runtime floor, unit-tested at the pure-function boundary.
 *
 * `src/shared/node-version.mjs` is the single place both client entries
 * (`src/cli`, `src/mcp`) consult before doing anything else, and it must agree
 * with the installer's `require_node` (`scripts/install/_common.sh`) on which
 * version strings are accepted. This file pins every branch of that contract,
 * plus the `MIN_NODE_MAJOR ↔ package.json#engines.node` lock that keeps the
 * "22" in three places from drifting.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  MIN_NODE_MAJOR,
  isSupportedNode,
  nodeMajor,
  unsupportedNodeMessage,
} from "../../src/shared/node-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("nodeMajor — major extraction", () => {
  it("reads a dotted version, with or without the leading v", () => {
    assert.equal(nodeMajor("22.0.0"), 22);
    assert.equal(nodeMajor("v22.11.0"), 22);
    assert.equal(nodeMajor("21.99.9"), 21);
  });

  it("accepts a bare major, with or without the leading v (installer parity)", () => {
    assert.equal(nodeMajor("22"), 22);
    assert.equal(nodeMajor("v22"), 22);
  });

  it("returns null for a non-version string", () => {
    assert.equal(nodeMajor(""), null);
    assert.equal(nodeMajor("abc"), null);
    assert.equal(nodeMajor("garbage"), null);
    assert.equal(nodeMajor("22garbage"), null);
  });
});

describe("isSupportedNode — the runtime floor", () => {
  it("accepts a version at or above the minimum", () => {
    assert.equal(isSupportedNode("22.0.0"), true);
    assert.equal(isSupportedNode("v22.0.0"), true);
    assert.equal(isSupportedNode("22"), true);
  });

  it("rejects a version below the minimum or unparseable", () => {
    assert.equal(isSupportedNode("21.99.9"), false);
    assert.equal(isSupportedNode("garbage"), false);
    assert.equal(isSupportedNode(""), false);
  });

  it("honours a custom minimum major", () => {
    assert.equal(isSupportedNode("21.99.9", 21), true);
    assert.equal(isSupportedNode("21.99.9", 22), false);
    assert.equal(isSupportedNode("v20.0.0", 20), true);
  });
});

describe("unsupportedNodeMessage — the one message every entry prints", () => {
  it("names the bin, the requirement and the found version", () => {
    const message = unsupportedNodeMessage("21.9.9", { bin: "taskctl" });
    assert.match(message, /taskctl: Node 22 or newer is required/);
    assert.match(message, /found 21\.9\.9/);
  });

  it("shows 'no version' for an empty version", () => {
    assert.match(unsupportedNodeMessage(""), /found no version/);
  });

  it("honours a custom minimum and defaults the bin to task-panel", () => {
    assert.match(unsupportedNodeMessage("21.9.9"), /task-panel: Node 22 or newer is required/);
    assert.match(unsupportedNodeMessage("21.9.9", { min: 24 }), /Node 24 or newer is required/);
  });
});

describe("MIN_NODE_MAJOR — the drift lock", () => {
  it("stays in lockstep with package.json#engines.node", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const engines = String(pkg.engines?.node ?? "");
    const match = /\d+/.exec(engines);
    assert.ok(match !== null, `package.json#engines.node is not a version: ${JSON.stringify(engines)}`);
    assert.equal(
      Number.parseInt(match[0], 10),
      MIN_NODE_MAJOR,
      "MIN_NODE_MAJOR and package.json#engines.node must move together",
    );
  });
});

test("nodeMajor reads its argument defensively", () => {
  // nodeMajor is called with process.versions.node, which is always a string,
  // but the pure function must not throw when handed a non-string.
  assert.equal(nodeMajor(null), null);
  assert.equal(nodeMajor(undefined), null);
});
