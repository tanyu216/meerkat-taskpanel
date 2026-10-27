/**
 * Tests for `scripts/release/release-notes.mjs` — the GitHub Release body.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ROOT, releaseNotes } from "../../scripts/release/release-notes.mjs";

const SCRIPT = join(ROOT, "scripts", "release", "release-notes.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-notes-"));
  tempDirs.push(dir);
  return dir;
}

const GOOD = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.1.0] - 2026-10-10",
  "",
  "### Fixed",
  "",
  "- A real fix.",
  "",
  "## [1.0.0] - 2026-09-01",
  "",
  "- Old.",
  "",
].join("\n");

describe("release-notes — extraction", () => {
  it("returns the filled body without the heading or the older section", () => {
    const result = releaseNotes(GOOD, "1.1.0");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.notes, "### Fixed\n\n- A real fix.");
    assert.doesNotMatch(result.notes, /## \[1\.1\.0\]/);
    assert.doesNotMatch(result.notes, /Old\./);
  });

  it("rejects a missing, undated, empty or scaffold section", () => {
    const cases = [
      ["# Changelog\n", "9.9.9", "missing"],
      ["# Changelog\n\n## [1.1.0]\n\n- A fix.\n", "1.1.0", "undated"],
      ["# Changelog\n\n## [1.1.0] - 2026-10-10\n", "1.1.0", "empty"],
      ["# Changelog\n\n## [1.1.0] - 2026-10-10\n\n- _Nothing yet._\n", "1.1.0", "placeholder"],
    ];
    for (const [body, version, code] of cases) {
      const result = releaseNotes(body, version);
      assert.equal(result.ok, false, `${code} should fail`);
      assert.equal(result.code, code);
    }
  });
});

describe("release-notes — the CLI", () => {
  it("prints the notes for a good file and exits 1 for a scaffold", async () => {
    const dir = await makeTree();
    const good = join(dir, "CHANGELOG.md");
    await writeFile(good, GOOD, "utf8");

    const pass = spawnSync(process.execPath, [SCRIPT, "v1.1.0", "--file", good], { encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /### Fixed\n\n- A real fix\./);

    const bad = join(dir, "bad.md");
    await writeFile(bad, "# Changelog\n\n## [1.1.0] - 2026-10-10\n\n- _Nothing yet._\n", "utf8");
    const fail = spawnSync(process.execPath, [SCRIPT, "v1.1.0", "--file", bad], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /scaffold/);
  });
});
