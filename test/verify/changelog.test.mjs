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
  parseVersionSection,
  parseVersionTag,
} from "../../scripts/verify/changelog.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "changelog.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-changelog-"));
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

describe("changelog.mjs — checkChangelog against a tree", () => {
  it("passes for a version that has a CHANGELOG entry", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [2.1.0]\n\n- x\n", "utf8");
    const result = await checkChangelog({ tag: "v2.1.0", base: dir });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, "2.1.0");
    assert.equal(typeof result.line, "number");
  });

  it("documents the released 0.1.0 baseline", async () => {
    const result = await checkChangelog({ tag: "v0.1.0" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, "0.1.0");
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

  it("fails a v-prefixed name that is not semver instead of skipping it", async () => {
    for (const tag of ["v1.2", "v1.2.3.4", "vnext"]) {
      const result = await checkChangelog({ tag });
      assert.equal(result.ok, false, `${tag} must not pass as a scratch tag`);
      assert.equal(result.code, "malformed", tag);
      assert.match(result.error, /vMAJOR\.MINOR\.PATCH/);
    }
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
  it("exits 0 for a tag with a CHANGELOG entry", async () => {
    const dir = await makeTree();
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [2.1.0]\n\n- x\n", "utf8");
    const result = runCli(["v2.1.0", "--base", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\.1\.0/);
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

  it("exits 1 for a malformed v* tag", () => {
    const result = runCli(["v1.2"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release tag/i);
    assert.doesNotMatch(result.stderr, /undefined/, "no section hint for a tag that is the problem");
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

describe("changelog.mjs — strict", () => {
  const GOOD = "# Changelog\n\n## [Unreleased]\n\n## [2.1.0] - 2026-10-10\n\n### Fixed\n\n- A real fix.\n";

  async function strictTree(body) {
    const dir = await makeTree();
    await writeFile(join(dir, "CHANGELOG.md"), body, "utf8");
    return dir;
  }

  it("passes a real dated section with entries and an empty Unreleased", async () => {
    const dir = await strictTree(GOOD);
    const result = await checkChangelog({ tag: "v2.1.0", base: dir, strict: true });
    assert.equal(result.ok, true, result.error);
  });

  it("rejects a missing or impossible date", async () => {
    for (const heading of ["## [2.1.0]", "## [2.1.0] - 2026-02-30"]) {
      const dir = await strictTree(`# Changelog\n\n${heading}\n\n- A real fix.\n`);
      const result = await checkChangelog({ tag: "v2.1.0", base: dir, strict: true });
      assert.equal(result.ok, false);
      assert.equal(result.code, "strict-date", heading);
    }
  });

  it("rejects the scaffold placeholder and an empty section", async () => {
    const placeholder = await strictTree(
      "# Changelog\n\n## [2.1.0] - 2026-10-10\n\n### Added\n\n- _Nothing yet._\n",
    );
    const p = await checkChangelog({ tag: "v2.1.0", base: placeholder, strict: true });
    assert.equal(p.ok, false);
    assert.equal(p.code, "strict-placeholder");

    const empty = await strictTree("# Changelog\n\n## [2.1.0] - 2026-10-10\n\n### Added\n");
    const e = await checkChangelog({ tag: "v2.1.0", base: empty, strict: true });
    assert.equal(e.ok, false);
    assert.equal(e.code, "strict-empty");
  });

  it("rejects a non-empty [Unreleased]", async () => {
    const dir = await strictTree(
      "# Changelog\n\n## [Unreleased]\n\n- Still unreleased.\n\n## [2.1.0] - 2026-10-10\n\n- A real fix.\n",
    );
    const result = await checkChangelog({ tag: "v2.1.0", base: dir, strict: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unreleased-dirty");
  });

  it("keeps the non-strict gate permissive for the scaffold", async () => {
    const dir = await strictTree("# Changelog\n\n## [2.1.0]\n\n- _Nothing yet._\n");
    const result = await checkChangelog({ tag: "v2.1.0", base: dir });
    assert.equal(result.ok, true, result.error);
  });

  it("parses the section's date and top-level bullets", async () => {
    const section = parseVersionSection(GOOD, "2.1.0");
    assert.equal(section.date, "2026-10-10");
    assert.deepEqual(section.bullets, ["- A real fix."]);
    assert.equal(parseVersionSection(GOOD, "9.9.9"), null);
  });

  it("CLI --strict exits 1 on a placeholder and 0 on a real section", async () => {
    const bad = await strictTree("# Changelog\n\n## [2.1.0] - 2026-10-10\n\n- _Nothing yet._\n");
    const fail = runCli(["v2.1.0", "--base", bad, "--strict"]);
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /scaffold|placeholder/i);

    const good = await strictTree(GOOD);
    const pass = runCli(["v2.1.0", "--base", good, "--strict"]);
    assert.equal(pass.status, 0, pass.stderr);
  });
});
