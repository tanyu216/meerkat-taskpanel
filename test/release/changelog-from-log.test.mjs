/**
 * Tests for `scripts/release/changelog-from-log.mjs` — the release-note draft.
 *
 * The pure grouping/rendering cases run against in-memory git-log records; the CLI
 * case writes a temp tree and a `--log-file`, so no git repository is needed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  ROOT,
  cleanSubject,
  fillSection,
  groupCommits,
  renderGroups,
} from "../../scripts/release/changelog-from-log.mjs";

const SCRIPT = join(ROOT, "scripts", "release", "changelog-from-log.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-from-log-"));
  tempDirs.push(dir);
  return dir;
}

const record = (subject, body = "") => `${subject}\x1f${body}\x1e`;

describe("changelog-from-log — grouping", () => {
  it("maps conventional types to Added/Changed/Removed/Fixed and drops internal ones", () => {
    const raw = [
      record("feat(install): ship the board"),
      record("fix: keep the port free"),
      record("perf: read one task per event"),
      record("refactor: rename the seam"),
      record("revert: drop the experiment"),
      record("docs: internal docs"),
      record("chore: housekeeping"),
      record("test: a test"),
      record("build: a build change"),
      record("ci: a workflow"),
      record("style: whitespace"),
    ].join("");

    const groups = groupCommits(raw);
    assert.deepEqual(groups.Added, ["**install:** ship the board"]);
    assert.deepEqual(groups.Fixed, ["keep the port free"]);
    assert.deepEqual(groups.Changed, ["read one task per event", "rename the seam"]);
    assert.deepEqual(groups.Removed, ["drop the experiment"]);
  });

  it("marks ! and BREAKING CHANGE: bullets, and leaves unknown types in Changed", () => {
    const groups = groupCommits(
      record("feat(cli)!: rename a flag") + record("misc: an untyped subject", "BREAKING CHANGE: it moves"),
    );
    assert.ok(groups.Added.includes("**BREAKING** **cli:** rename a flag"), JSON.stringify(groups));
    assert.ok(groups.Changed.includes("**BREAKING** an untyped subject"));
  });

  it("strips card ids, PR refs and commit hashes from the subject", () => {
    assert.equal(cleanSubject("ship it (T-20261010-043100)"), "ship it");
    assert.equal(cleanSubject("keep it (#12)"), "keep it");
    assert.equal(cleanSubject("keep it (abcdef1)"), "keep it");
    assert.equal(cleanSubject("T-20261010-043100 fix the thing"), "fix the thing");
  });

  it("skips merges, blanks and duplicate bullets", () => {
    const groups = groupCommits(
      record("Merge branch 'dev'") + record("feat: same") + record("feat: same") + record("   "),
    );
    assert.deepEqual(groups.Added, ["same"]);
  });

  it("returns empty groups when nothing survives", () => {
    const groups = groupCommits(record("docs: only docs"));
    assert.deepEqual(groups, { Added: [], Changed: [], Removed: [], Fixed: [] });
  });

  it("renders only non-empty groups", () => {
    const rendered = renderGroups({ Added: ["a"], Changed: [], Removed: [], Fixed: ["b"] });
    assert.equal(rendered, "### Added\n\n- a\n\n### Fixed\n\n- b");
  });
});

describe("changelog-from-log — filling a section", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [1.1.0] - 2026-10-10",
    "",
    "### Added",
    "",
    "- _Nothing yet._",
    "",
    "## [1.0.0] - 2026-09-01",
    "",
    "- Old.",
    "",
  ].join("\n");

  it("replaces the scaffold, preserves the date, and empties [Unreleased]", () => {
    const filled = fillSection(
      changelog.replace("## [Unreleased]\n", "## [Unreleased]\n\n- still here.\n"),
      "1.1.0",
      { Added: ["a real change"], Changed: [], Removed: [], Fixed: [] },
      "2026-10-20",
    );
    assert.equal(filled.ok, true, filled.error);
    assert.match(filled.changelog, /## \[1\.1\.0\] - 2026-10-10/);
    assert.match(filled.changelog, /### Added\n\n- a real change/);
    assert.doesNotMatch(filled.changelog, /_Nothing yet\._/);
    assert.doesNotMatch(filled.changelog, /still here\./);
    assert.match(filled.changelog, /## \[1\.0\.0\] - 2026-09-01\n\n- Old\./);
  });

  it("adds a date when the heading has none", () => {
    const noDate = "# Changelog\n\n## [1.1.0]\n\n- _Nothing yet._\n";
    const filled = fillSection(noDate, "1.1.0", { Added: ["x"], Changed: [], Removed: [], Fixed: [] }, "2026-10-20");
    assert.equal(filled.ok, true, filled.error);
    assert.match(filled.changelog, /## \[1\.1\.0\] - 2026-10-20/);
  });

  it("refuses a missing section or an empty release", () => {
    const missing = fillSection("# Changelog\n\n## [1.0.0]\n\n- old\n", "9.9.9", { Added: ["x"], Changed: [], Removed: [], Fixed: [] }, "2026-10-20");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "section-missing");

    const empty = fillSection(changelog, "1.1.0", { Added: [], Changed: [], Removed: [], Fixed: [] }, "2026-10-20");
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "empty-changelog");
  });
});

describe("changelog-from-log — the CLI", () => {
  it("fills the section from a --log-file without touching git", async () => {
    const dir = await makeTree();
    const file = join(dir, "CHANGELOG.md");
    await writeFile(
      file,
      "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-10-10\n\n### Added\n\n- _Nothing yet._\n",
      "utf8",
    );
    const log = join(dir, "log.txt");
    await writeFile(log, record("feat: a real change") + record("fix: a real fix"), "utf8");

    const result = spawnSync(
      process.execPath,
      [SCRIPT, "1.1.0", "--base", dir, "--log-file", log],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const written = await readFile(file, "utf8");
    assert.match(written, /### Added\n\n- a real change/);
    assert.match(written, /### Fixed\n\n- a real fix/);
    assert.doesNotMatch(written, /_Nothing yet\._/);
  });
});
