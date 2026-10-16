/**
 * Tests for `scripts/verify/version.mjs` — the board version group.
 *
 * Every case builds a real tree on disk (a temp dir) and calls the real
 * `validateVersions(base, sources)`; the CLI cases spawn the real script. Nothing is
 * mocked: the thing under test is precisely "does it read these files
 * correctly", so a stub would test nothing.
 *
 * There is one group (4 manifests, root `package.json` canonical). The loop used to be a
 * second one, versioned independently (O4); it stopped being a carrier when its only two
 * manifests — the `plugins/loop` bundle — were removed, and the group seam is kept so a
 * second component can be added back.
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
 * @param {string} version
 * @returns {Record<string, object>}
 */
function manifests(version) {
  return {
    "package.json": { name: "meerkat-taskpanel", version, private: true },
    ".claude-plugin/plugin.json": { name: "meerkat-taskpanel", version },
    ".cursor-plugin/plugin.json": { name: "meerkat-taskpanel", version },
    ".claude-plugin/marketplace.json": { name: "meerkat-taskpanel-marketplace", metadata: { version } },
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
  it("declares the board's four sources, exactly one canonical, in one group", () => {
    assert.equal(VERSION_SOURCES.length, 4);
    assert.equal(VERSION_SOURCES[0].path, "package.json", "package.json is the board's canonical source");
    assert.equal(VERSION_SOURCES.filter((s) => s.canonical === true).length, 1, "exactly one source is canonical");

    // The loop is not a version carrier: its only two carriers were the `plugins/loop`
    // manifests, and nothing consumes a loop version (board-check enforces the *board's*
    // interface floor). A group for it could not be checked against anything.
    assert.deepEqual(
      VERSION_GROUPS.map((group) => group.name),
      ["board"],
    );
    assert.equal(DEFAULT_GROUP, "board", "a bare invocation keeps reading the board's version");
  });

  it("agrees across this checkout", async () => {
    const declared = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

    const board = await validateVersions(ROOT);
    assert.equal(board.ok, true, board.error);
    assert.equal(board.version, declared);
    assert.equal(board.sources.length, 4);
    assert.ok(board.sources.every((entry) => entry.version === declared));
    assert.equal(await currentVersion(ROOT), declared);

    const groups = await validateVersionGroups(ROOT);
    assert.equal(groups.ok, true);
    assert.deepEqual(
      groups.results.map((entry) => entry.name),
      ["board"],
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
    assert.equal(result.sources.length, 4);
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
    assert.equal(result.sources.length, 4, "every source is still listed so the diff is legible");
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
    files[".cursor-plugin/plugin.json"] = "{ not json";
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /\.cursor-plugin\/plugin\.json: not valid JSON/);
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
    assert.match(result.stdout, /all 4 board manifests agree on 2\.0\.0/);
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

  it("--group board narrows to the one group, and --print reads its canonical entry", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("2.0.0"));

    const boardOnly = runCli(["--base", dir, "--group", "board"]);
    assert.equal(boardOnly.status, 0, boardOnly.stderr);
    assert.match(boardOnly.stdout, /all 4 board manifests agree on 2\.0\.0/);

    const boardPrint = runCli(["--base", dir, "--print"]);
    assert.equal(boardPrint.stdout.trim(), "2.0.0");
  });

  it("rejects the retired loop group rather than silently checking nothing", async () => {
    // `--group loop` used to be valid. Now that the loop carries no version, asking for it
    // must be an error — a group that resolves to an empty source list would report success
    // for a tree it never read.
    const result = runCli(["--group", "loop"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --group 'loop'/);
  });

  it("exits 2 on an unknown --group", async () => {
    const result = runCli(["--group", "nope"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --group 'nope'/);
  });
});
