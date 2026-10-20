/**
 * The session-start check shared by the plugin routes (pi, opencode).
 *
 * The instruction text is authored once, in the board skill. These are the two
 * helpers every in-process host route needs: read it from the package, and
 * recognise it in a host's message shapes so a session never gets two copies.
 *
 * Run with: `node --test`
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { CHECK_MARKER, hasCheck, readIssueTrackerCheck } from "../src/foundation/session-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-session-check-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("session check — reading the shared instruction", () => {
  it("reads the instruction from the package's board skill", () => {
    const text = readIssueTrackerCheck(ROOT);
    assert.ok(text.startsWith(CHECK_MARKER), "the marker must lead");
    assert.match(text, /docs\/agents\/issue-tracker\.md/);
    assert.match(text, /\/setup-matt-pocock-skills/);
  });

  it("returns an empty string when the package has no copy", () => {
    assert.equal(readIssueTrackerCheck(tempDir()), "");
  });
});

describe("session check — recognising an existing copy", () => {
  it("finds the marker in a list of message strings", () => {
    assert.equal(hasCheck(["hello", `${CHECK_MARKER}\nbody`]), true);
    assert.equal(hasCheck(["hello", "world"]), false);
    assert.equal(hasCheck([]), false);
    assert.equal(hasCheck([null, undefined, 42]), false);
  });
});
