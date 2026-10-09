/**
 * Tests for `scripts/verify/version.mjs` — the six-manifest version contract.
 *
 * Every case builds a real tree on disk (a temp dir) and calls the real
 * `validateVersions(base)`; the CLI cases spawn the real script. Nothing is
 * mocked: the thing under test is precisely "does it read these files
 * correctly", so a stub would test nothing.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { ROOT, VERSION_SOURCES, currentVersion, validateVersions } from "../../scripts/verify/version.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "version.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir removed after the suite. */
async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "taskpanel-version-"));
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
    "package.json": { name: "task-panel", version, private: true },
    "plugins/pi/package.json": { name: "task-panel-pi", version },
    "plugins/claude/.claude-plugin/plugin.json": { name: "task-panel", version },
    "plugins/codex/.codex-plugin/plugin.json": { name: "task-panel", version },
    "plugins/openclaw/openclaw.plugin.json": { id: "task-panel", version },
    ".claude-plugin/marketplace.json": { name: "task-panel-marketplace", metadata: { version } },
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
  it("declares all six sources", () => {
    assert.equal(VERSION_SOURCES.length, 6);
    assert.equal(VERSION_SOURCES[0].path, "package.json", "package.json is the canonical source");
    assert.equal(VERSION_SOURCES.filter((s) => s.canonical === true).length, 1, "exactly one source is canonical");
  });

  it("agrees across this checkout, at the version package.json declares", async () => {
    const declared = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
    const result = await validateVersions(ROOT);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, declared);
    assert.equal(result.sources.length, 6);
    assert.ok(result.sources.every((entry) => entry.version === declared));
    assert.equal(await currentVersion(ROOT), declared);
  });
});

describe("version.mjs — validateVersions(base)", () => {
  it("passes when a tree is consistent", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("9.9.9"));
    const result = await validateVersions(dir);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.version, "9.9.9");
    assert.equal(result.sources.length, 6);
  });

  it("fails, naming the file, when one manifest drifts", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/marketplace.json"] = { name: "task-panel-marketplace", metadata: { version: "0.9.9" } };
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "drift");
    assert.equal(result.version, "1.0.0", "the canonical version is still reported");
    assert.match(result.error, /\.claude-plugin\/marketplace\.json/);
    assert.match(result.error, /0\.9\.9/);
    assert.equal(result.sources.length, 6, "every source is still listed so the diff is legible");
  });

  it("fails when a nested field is missing (marketplace metadata.version)", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files[".claude-plugin/marketplace.json"] = { name: "task-panel-marketplace", metadata: {} };
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
    files["plugins/pi/package.json"] = { name: "task-panel-pi" };
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /plugins\/pi\/package\.json/);
    assert.match(result.error, /`version`/);
  });

  it("fails when a manifest is absent", async () => {
    const dir = await makeTree();
    const files = manifests("1.0.0");
    files["plugins/codex/.codex-plugin/plugin.json"] = undefined;
    await writeTree(dir, files);

    const result = await validateVersions(dir);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "read");
    assert.match(result.error, /plugins\/codex\/\.codex-plugin\/plugin\.json: file not found/);
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
    assert.match(result.stdout, /all 6 manifests agree on 2\.0\.0/);
  });

  it("exits 1 and prints the drift on a drifted tree", async () => {
    const dir = await makeTree();
    const files = manifests("2.0.0");
    files["plugins/pi/package.json"] = { name: "task-panel-pi", version: "1.0.0" };
    await writeTree(dir, files);
    const result = runCli(["--base", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version drift/);
    assert.match(result.stderr, /plugins\/pi\/package\.json/);
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
});
