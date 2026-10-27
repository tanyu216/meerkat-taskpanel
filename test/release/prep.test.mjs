/**
 * Tests for `scripts/release/prep.mjs` — the tree half of a release.
 *
 * Each case builds a real temporary git repository (a tagged 0.1.0, then commits)
 * and calls the real `prepareRelease`; the bytes on disk are the property, so
 * nothing is mocked. The CLI case spawns the script.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ROOT, prepareRelease } from "../../scripts/release/prep.mjs";

const SCRIPT = join(ROOT, "scripts", "release", "prep.mjs");
const tempDirs = [];

/**
 * The verification image is the *runtime* image and ships no git, so a real-
 * repository case cannot run there. These cases run in `npm run check` and in
 * CI's `check` job (both on a machine with git) and skip inside
 * `npm run verify:docker` — the same documented exception as the browser legs,
 * which the image cannot run either. `prep.mjs` is still imported by the suite
 * that runs everywhere; only the git-backed assertions are gated.
 */
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const gitDescribe = hasGit ? describe : describe.skip;

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function carriers(version) {
  return {
    "package.json": `{\n  "name": "meerkat-taskpanel",\n  "version": "${version}"\n}\n`,
    ".claude-plugin/plugin.json": `{\n  "name": "meerkat-taskpanel",\n  "version": "${version}"\n}\n`,
    ".claude-plugin/marketplace.json": `{\n  "name": "m",\n  "metadata": {\n    "version": "${version}"\n  },\n  "plugins": []\n}\n`,
    "src/foundation/constants.mjs": `export const VERSION = "${version}";\n`,
  };
}

const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n### Added\n\n- The first release.\n`;

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-prep-"));
  tempDirs.push(dir);
  for (const [path, body] of Object.entries(carriers("0.1.0"))) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body, "utf8");
  }
  await writeFile(join(dir, "CHANGELOG.md"), CHANGELOG, "utf8");
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: initial"]);
  git(dir, ["tag", "-a", "v0.1.0", "-m", "v0.1.0"]);
  return dir;
}

/** Append to a tracked file and commit it. */
async function commit(dir, subject, file = "notes.txt", body = "x") {
  await writeFile(join(dir, file), `${body}\n`, { flag: "a" });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", subject]);
}

gitDescribe("prep — the happy path", () => {
  it("bumps the carriers and fills the scaffold from the log", async () => {
    const dir = await makeRepo();
    await commit(dir, "feat(install): ship the board");
    await commit(dir, "fix: keep the port free");

    const result = await prepareRelease({ version: "0.1.1", base: dir, date: "2026-10-20" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.previous, "0.1.0");
    assert.equal(result.from, "v0.1.0");
    assert.equal(result.entryCount, 2);
    assert.equal(result.resume, false);

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, "0.1.1");

    const changelog = await readFile(join(dir, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /## \[0\.1\.1\] - 2026-10-20/);
    assert.match(changelog, /### Added\n\n- \*\*install:\*\* ship the board/);
    assert.match(changelog, /### Fixed\n\n- keep the port free/);
    assert.doesNotMatch(changelog, /_Nothing yet\._/);
    assert.match(changelog, /## \[0\.1\.0\] - 2026-10-01/, "the previous release survives");
  });

  it("writes nothing on a dry run", async () => {
    const dir = await makeRepo();
    await commit(dir, "feat: a change");
    const before = await readFile(join(dir, "package.json"), "utf8");
    const changelogBefore = await readFile(join(dir, "CHANGELOG.md"), "utf8");

    const result = await prepareRelease({ version: "0.1.1", base: dir, dryRun: true });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.dryRun, true);
    assert.equal(await readFile(join(dir, "package.json"), "utf8"), before);
    assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), changelogBefore, "the changelog is untouched too");
  });
});

gitDescribe("prep — refusals", () => {
  it("refuses a dirty tree", async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, "stray.txt"), "x", "utf8");
    const result = await prepareRelease({ version: "0.1.1", base: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "dirty-tree");
  });

  it("refuses a version that already has a tag", async () => {
    const dir = await makeRepo();
    const result = await prepareRelease({ version: "0.1.0", base: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "tag-exists");
  });

  it("refuses a dev that does not contain origin/main", async () => {
    const dir = await makeRepo();
    await commit(dir, "feat: on the release branch");
    // A commit reachable only from origin/main is not an ancestor of HEAD.
    git(dir, ["checkout", "-q", "-b", "other", "v0.1.0"]);
    await writeFile(join(dir, "other.txt"), "y\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "fix: on main"]);
    const other = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", other]);
    git(dir, ["checkout", "-q", "-"]);

    const result = await prepareRelease({ version: "0.1.1", base: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "main-not-merged");
  });

  it("refuses a range with no releasable commits, before writing anything", async () => {
    const dir = await makeRepo();
    await commit(dir, "docs: internal only");
    const before = await readFile(join(dir, "package.json"), "utf8");

    const result = await prepareRelease({ version: "0.1.1", base: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "empty-changelog");
    assert.equal(await readFile(join(dir, "package.json"), "utf8"), before, "no carrier was bumped");
  });
});

gitDescribe("prep — a re-run", () => {
  it("resumes at the target version and preserves a human-edited section", async () => {
    const dir = await makeRepo();
    await commit(dir, "feat: a change");
    const first = await prepareRelease({ version: "0.1.1", base: dir, date: "2026-10-20" });
    assert.equal(first.ok, true, first.error);

    // A human rewrites the section; a re-run must not overwrite it.
    const edited = (await readFile(join(dir, "CHANGELOG.md"), "utf8")).replace(
      "- a change",
      "- the release note a human wrote",
    );
    await writeFile(join(dir, "CHANGELOG.md"), edited, "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "docs: word the release note"]);

    const again = await prepareRelease({ version: "0.1.1", base: dir });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.resume, true);
    assert.equal(again.changelog.filled, false);
    assert.match(await readFile(join(dir, "CHANGELOG.md"), "utf8"), /the release note a human wrote/);
  });
});

gitDescribe("prep — the CLI", () => {
  it("prints JSON metadata with --json", async () => {
    const dir = await makeRepo();
    await commit(dir, "feat: a change");

    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--version", "0.1.1", "--base", dir, "--date", "2026-10-20", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const meta = JSON.parse(result.stdout);
    assert.equal(meta.version, "0.1.1");
    assert.equal(meta.previous, "0.1.0");
    assert.equal(meta.changelog.filled, true);
  });

  it("exits 2 without --version", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--version/);
  });
});
