/**
 * Tests for `scripts/verify/version.mjs` — the two independent version groups.
 *
 * Every case builds a real tree on disk (a temp dir) and calls the real
 * `validateVersions(base, sources)`; the CLI cases spawn the real script. Nothing is
 * mocked: the thing under test is precisely "does it read these files
 * correctly", so a stub would test nothing.
 *
 * The board group (6 manifests, root `package.json` canonical) and the loop group (2
 * manifests, its own plugin manifest canonical) are **not** compared with each other:
 * the two components version independently (O4), and a loop-only bump must stay green.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import {
  DEFAULT_GROUP,
  LOOP_VERSION_SOURCES,
  ROOT,
  VERSION_GROUPS,
  VERSION_SOURCES,
  currentVersion,
  validateVersionGroups,
  validateVersions,
} from "../../scripts/verify/version.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "version.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-version-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A JSON body per manifest path, parameterised by version so a case can make
 * exactly one of them disagree (or drop/blank the field entirely).
 *
 * The loop manifests take their own version (defaulting to the board's), so a case can
 * build the tree a *loop-only* bump leaves behind — which must stay green.
 *
 * @param {string} version
 * @param {string} [loopVersion]
 * @returns {Record<string, object>}
 */
function manifests(version, loopVersion = version) {
  return {
    "package.json": { name: "meerkat-taskpanel", version, private: true },
    ".claude-plugin/plugin.json": { name: "meerkat-taskpanel", version },
    ".cursor-plugin/plugin.json": { name: "meerkat-taskpanel", version },
    "plugins/openclaw/openclaw.plugin.json": { id: "meerkat-taskpanel", version },
    ".claude-plugin/marketplace.json": { name: "meerkat-taskpanel-marketplace", metadata: { version } },
    "plugins/loop/.claude-plugin/plugin.json": { name: "meerkat-loop", version: loopVersion },
    "plugins/loop/package.json": { name: "meerkat-loop-pi", version: loopVersion },
  };
}

/**
 * Write a tree from a `path → value` map. A value of `undefined` omits the file
 * entirely (to exercise the missing-file branch); a string is written verbatim
 * (to exercise the malformed-JSON branch).
 *
 * @param {string} dir
 * @param {Record<string, unknown>} files
 */
async function writeTree(dir, files) {
  for (const [rel, value] of Object.entries(files)) {
    if (value === undefined) continue;
    const file = join(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

/** Run the CLI with a `--base` and return {status, stdout, stderr}. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("version.mjs — the shipped manifests", () => {
  it("declares the board's five sources and the loop's two, one canonical each", () => {
    assert.equal(VERSION_SOURCES.length, 5);
    assert.equal(VERSION_SOURCES[0].path, "package.json", "package.json is the board's canonical source");
    assert.equal(VERSION_SOURCES.filter((s) => s.canonical === true).length, 1, "exactly one source is canonical");

    assert.equal(LOOP_VERSION_SOURCES.length, 2);
    assert.equal(
      LOOP_VERSION_SOURCES[0].path,
      "plugins/loop/.claude-plugin/plugin.json",
      "the loop's Claude-format plugin manifest is its canonical source",
    );
    assert.equal(LOOP_VERSION_SOURCES.filter((s) => s.canonical === true).length, 1);

    assert.deepEqual(
      VERSION_GROUPS.map((group) => group.name),
      ["board", "loop"],
    );
    assert.equal(DEFAULT_GROUP, "board", "a bare invocation keeps reading the board's version");
  });

  it("agrees across this checkout, per group", async () => {
    const declared = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

    const board = await validateVersions(ROOT);
    assert.equal(board.ok, true, board.error);
    assert.equal(board.version, declared);
    assert.equal(board.sources.length, 5);
    assert.ok(board.sources.every((entry) => entry.version === declared));
    assert.equal(await currentVersion(ROOT), declared);

    const loop = await validateVersions(ROOT, LOOP_VERSION_SOURCES);
    assert.equal(loop.ok, true, loop.error);
    assert.equal(loop.sources.length, 2);

    const groups = await validateVersionGroups(ROOT);
    assert.equal(groups.ok, true);
    assert.deepEqual(
      groups.results.map((entry) => entry.name),
      ["board", "loop"],
    );
  });
});

describe("version.mjs — validateVersions(base)", () => {
  it("passes when a tree is consistent", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("9.9.9"));
    const result = await validateVersions(dir);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, "9.9.9");
    assert.equal(result.sources.length, 5);
  });

  it("fails, naming the file, when one manifest drifts", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/marketplace.json"] = { name: "meerkat-taskpanel-marketplace", metadata: { version: "0.9.9" } };
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "drift");
    assert.equal(result.version, "1.0.0", "the canonical version is still reported");
    assert.match(result.error, /\.claude-plugin\/marketplace\.json/);
    assert.match(result.error, /0\.9\.9/);
    assert.equal(result.sources.length, 5, "every source is still listed so the diff is legible");
  });

  it("fails when a nested field is missing (marketplace metadata.version)", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/marketplace.json"] = { name: "meerkat-taskpanel-marketplace", metadata: {} };
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /marketplace\.json/);
    assert.match(result.error, /metadata\.version/);
  });

  it("fails when a top-level version is missing", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/plugin.json"] = { name: "meerkat-taskpanel" };
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /\.claude-plugin\/plugin\.json/);
    assert.match(result.error, /`version`/);
  });

  it("fails when a manifest is absent", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/plugin.json"] = undefined;
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /\.claude-plugin\/plugin\.json: file not found/);
  });

  it("fails when a manifest is not valid JSON", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files["plugins/openclaw/openclaw.plugin.json"] = "{ not json";
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /plugins\/openclaw\/openclaw\.plugin\.json: not valid JSON/);
  });
});

describe("version.mjs — the CLI", () => {
  it("exits 0 and prints the version for --print", async () => {
    const declared = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
    const result = runCli(["--print"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), declared);
  });

  it("exits 0 on a consistent tree", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("2.0.0"));
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all 5 board manifests agree on 2\.0\.0/);
    assert.match(result.stdout, /all 2 loop manifests agree on 2\.0\.0/);
  });

  it("exits 1 and prints the drift on a drifted tree", async () => {
    const dir = await makeTree();
    const files = manifests("2.0.0");
    files[".claude-plugin/plugin.json"] = { name: "meerkat-taskpanel", version: "1.0.0" };
    await writeTree(dir, files);
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version drift/);
    assert.match(result.stderr, /\.claude-plugin\/plugin\.json/);
  });

  it("exits 2 when the tree itself is broken", async () => {
    const dir = await makeTree();
    const files = manifests("2.0.0");
    files["package.json"] = undefined;
    await writeTree(dir, files);
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /file not found/);
  });

  it("exits 1 when only the loop group drifts, and names that group", async () => {
    const dir = await makeTree();
    const files = manifests("2.0.0");
    files["plugins/loop/package.json"] = { name: "meerkat-loop-pi", version: "0.9.0" };
    await writeTree(dir, files);

    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version: FAILED \(loop\)/);
    assert.match(result.stderr, /plugins\/loop\/package\.json/);
    // The board group is reported clean in the same run — one drifted group must not
    // condemn the other.
    assert.match(result.stdout, /all 5 board manifests agree on 2\.0\.0/);
  });

  it("stays green when the loop carries a version of its own", async () => {
    // The state a loop-only bump leaves behind: two groups, two versions, no drift
    // (O4 — they are released independently).
    const dir = await makeTree();
    await writeTree(dir, manifests("2.0.0", "2.1.0"));

    const result = runCli(["--base", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /all 5 board manifests agree on 2\.0\.0/);
    assert.match(result.stdout, /all 2 loop manifests agree on 2\.1\.0/);
  });

  it("--group narrows the check and --print reads that group's canonical entry", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("2.0.0", "2.1.0"));

    const boardOnly = runCli(["--base", dir, "--group", "board"]);
    assert.equal(boardOnly.status, 0, boardOnly.stderr);
    assert.equal(boardOnly.stdout.includes("loop manifests agree"), false);

    const loopPrint = runCli(["--base", dir, "--group", "loop", "--print"]);
    assert.equal(loopPrint.status, 0, loopPrint.stderr);
    assert.equal(loopPrint.stdout.trim(), "2.1.0");

    const boardPrint = runCli(["--base", dir, "--print"]);
    assert.equal(boardPrint.stdout.trim(), "2.0.0");
  });

  it("exits 2 on an unknown --group", async () => {
    const result = runCli(["--group", "nope"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --group 'nope'/);
  });
});
