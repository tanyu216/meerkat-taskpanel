/**
 * Tests for `scripts/verify/changelog.mjs` — the tag ↔ CHANGELOG contract.
 *
 * The rule: a version tag `vX.Y.Z` may only be cut when `CHANGELOG.md` carries a
 * `## [X.Y.Z]` section. The checker is the single implementation shared by the
 * local `pre-tag` / `pre-push` hooks and the CI `version-gate` workflow.
 *
 * The `parseVersionTag` / `findVersionEntry` cases are pure (no I/O) and run
 * against in-memory strings; the `checkChangelog` / CLI cases build a real
 * temp tree so the file read is exercised for real. Nothing is mocked.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  ROOT,
  checkChangelog,
  findVersionEntry,
  parseVersionTag,
} from "../../scripts/verify/changelog.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "changelog.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "taskpanel-changelog-"));
  tempDirs.push(dir);
  return dir;
}

/** Run the CLI and return {status, stdout, stderr}. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Something unreleased.",
  "",
  "## [2.1.0] - 2026-10-10",
  "",
  "- A released thing.",
  "",
  "## [2.0.0] - 2026-09-01",
  "",
  "- The previous one.",
  "",
  "[Unreleased]: https://example.test/compare/v2.1.0...HEAD",
  "[2.1.0]: https://example.test/releases/tag/v2.1.0",
  "[2.0.0]: https://example.test/releases/tag/v2.0.0",
  "",
].join("\n");

describe("changelog.mjs — parseVersionTag", () => {
  it("accepts the `v`-prefixed and bare semantic tags", () => {
    assert.equal(parseVersionTag("v1.2.3"), "1.2.3");
    assert.equal(parseVersionTag("1.2.3"), "1.2.3");
    assert.equal(parseVersionTag("v0.0.0"), "0.0.0");
  });

  it("accepts a pre-release / build suffix", () => {
    assert.equal(parseVersionTag("v1.2.3-rc.1"), "1.2.3-rc.1");
    assert.equal(parseVersionTag("v1.2.3+build.5"), "1.2.3+build.5");
  });

  it("rejects anything that is not a three-part version tag", () => {
    assert.equal(parseVersionTag("v1"), null);
    assert.equal(parseVersionTag("v1.2"), null);
    assert.equal(parseVersionTag("release"), null);
    assert.equal(parseVersionTag("vnext"), null);
    assert.equal(parseVersionTag(""), null);
  });
});

describe("changelog.mjs — findVersionEntry", () => {
  it("finds the `## [X.Y.Z]` heading for a released version, with its line number", () => {
    const found = findVersionEntry(SAMPLE, "2.1.0");
    assert.ok(found !== null);
    assert.equal(found.line, 9);
    assert.match(found.text, /^## \[2\.1\.0\]/);
  });

  it("does not match a link reference, a partial version, or an absent version", () => {
    assert.equal(findVersionEntry(SAMPLE, "unreleased"), null, "Unreleased is not a version");
    assert.equal(findVersionEntry(SAMPLE, "2.1"), null, "a partial version is not the heading");
    assert.equal(findVersionEntry(SAMPLE, "9.9.9"), null);
  });
});

describe("changelog.mjs — checkChangelog against this checkout", () => {
  it("passes for the version that has a CHANGELOG entry (v1.0.0)", async () => {
    const result = await checkChangelog({ tag: "v1.0.0" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, "1.0.0");
    assert.equal(typeof result.line, "number");
  });

  it("fails, naming the tag, when the version is missing from CHANGELOG.md", async () => {
    const result = await checkChangelog({ tag: "v9.9.9" });
    assert.equal(result.ok, false);
    assert.equal(result.version, "9.9.9");
    assert.match(result.error, /9\.9\.9/);
    assert.match(result.error, /CHANGELOG\.md/);
  });

  it("skips a non-version tag rather than failing", async () => {
    const result = await checkChangelog({ tag: "docs/experiment" });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });

  it("reports a missing CHANGELOG.md as an unreadable file, not a missing entry", async () => {
    const dir = await makeTree();
    const result = await checkChangelog({ tag: "v1.0.0", base: dir });
    assert.equal(result.ok, false);
    assert.match(result.error, /CHANGELOG\.md/);
    assert.equal(result.unreadable, true);
  });
});

describe("changelog.mjs — the CLI", () => {
  it("exits 0 for a tag with a CHANGELOG entry", () => {
    const result = runCli(["v1.0.0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\.0\.0/);
  });

  it("exits 1 when the tag has no CHANGELOG entry (the RED case)", () => {
    const result = runCli(["v9.9.9"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /9\.9\.9/);
  });

  it("exits 0 (skip) for a non-version tag", () => {
    const result = runCli(["not-a-version"]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("exits 2 on usage error (no tag given)", () => {
    const result = runCli([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/i);
  });

  it("exits 1 against a custom tree where the entry is absent", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [2.1.0]\n\n- x\n", "utf8");
    const pass = runCli(["v2.1.0", "--base", dir]);
    assert.equal(pass.status, 0, pass.stderr);
    const fail = runCli(["v2.2.0", "--base", dir]);
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /2\.2\.0/);
  });
});
