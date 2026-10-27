/**
 * Tests for `scripts/verify/tag-version.mjs` — the tag ↔ carrier equality gate.
 *
 * A tag names a release; the checked-out tree declares one. They must agree, or a
 * `v9.9.9` tag can ship a `0.1.0` tarball. The script reads the same four carriers
 * `version.mjs` owns, so this test builds a real tree and exercises the real module.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ROOT } from "../../scripts/verify/version.mjs";
import { checkTagVersion } from "../../scripts/verify/tag-version.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "tag-version.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-tag-version-"));
  tempDirs.push(dir);
  return dir;
}

function manifests(version) {
  return {
    "package.json": { name: "meerkat-taskpanel", version, private: true },
    ".claude-plugin/plugin.json": { name: "meerkat-taskpanel", version },
    ".claude-plugin/marketplace.json": { name: "meerkat-taskpanel-marketplace", metadata: { version } },
    "src/foundation/constants.mjs": `export const CLI_NAME = "taskctl";\nexport const VERSION = "${version}";\n`,
  };
}

async function writeTree(dir, files) {
  for (const [rel, value] of Object.entries(files)) {
    if (value === undefined) continue;
    const file = join(dir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("tag-version.mjs — checkTagVersion", () => {
  it("accepts a tag that names the tree's version, with or without the v", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));

    for (const tag of ["v1.2.3", "1.2.3"]) {
      const result = await checkTagVersion({ tag, base: dir });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.version, "1.2.3");
      assert.equal(result.expected, "1.2.3");
    }
  });

  it("skips a non-version tag instead of failing", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));

    const result = await checkTagVersion({ tag: "docs/experiment", base: dir });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });

  it("rejects a tag that disagrees with the canonical version", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));

    const result = await checkTagVersion({ tag: "v1.2.4", base: dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, "mismatch");
    assert.equal(result.version, "1.2.4");
    assert.equal(result.expected, "1.2.3");
    assert.match(result.error, /1\.2\.4/);
    assert.match(result.error, /1\.2\.3/);
  });

  it("reports an unreadable or drifted tree, not a mismatch", async () => {
    const missing = await makeTree();
    const files = manifests("1.2.3");
    delete files["package.json"];
    await writeTree(missing, files);

    const unreadable = await checkTagVersion({ tag: "v1.2.3", base: missing });
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.code, "unreadable");

    const drifted = await makeTree();
    await writeTree(drifted, { ...manifests("1.2.3"), ".claude-plugin/plugin.json": { name: "x", version: "1.2.2" } });
    const drift = await checkTagVersion({ tag: "v1.2.3", base: drifted });
    assert.equal(drift.ok, false);
    assert.equal(drift.code, "unreadable");
    assert.match(drift.error, /drift/i);
  });
});

describe("tag-version.mjs — the CLI", () => {
  it("exits 0 for a matching tag", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));
    const run = runCli(["v1.2.3", "--base", dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /tag-version: OK/);
  });

  it("exits 0 (skip) for a non-version tag", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));
    const run = runCli(["release-candidate", "--base", dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /SKIP/);
  });

  it("exits 1 on a mismatch and 2 on an unreadable tree", async () => {
    const dir = await makeTree();
    await writeTree(dir, manifests("1.2.3"));
    const mismatch = runCli(["v9.9.9", "--base", dir]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /FAILED/);

    const empty = await makeTree();
    const unreadable = runCli(["v1.2.3", "--base", empty]);
    assert.equal(unreadable.status, 2);
  });
});
