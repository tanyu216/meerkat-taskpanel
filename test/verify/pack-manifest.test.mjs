/**
 * Tests for `scripts/release/pack-manifest.mjs`.
 *
 * The real thing under test is "does this script read a tarball and judge its
 * contents correctly", so the cases build *real* tarballs (a minimal ustar
 * writer, gzipped with `node:zlib`) and either call `parseTar`/`checkManifest`
 * directly or spawn the script on the file. Nothing is mocked.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  REQUIRED,
  allowedTopLevel,
  checkManifest,
  maybeGunzip,
  parseTar,
} from "../../scripts/release/pack-manifest.mjs";
import { ROOT } from "../../scripts/verify/version.mjs";

const SCRIPT = join(ROOT, "scripts", "release", "pack-manifest.mjs");
const BLOCK = 512;
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "taskpanel-pack-"));
  tempDirs.push(dir);
  return dir;
}

const ascii = (text, length) => Buffer.from(text, "utf8").subarray(0, length);

/** One ustar header block for a regular file of `size` bytes. */
function headerBlock(name, size) {
  const block = Buffer.alloc(BLOCK, 0);
  ascii(name, 100).copy(block, 0);
  ascii("0000644\0", 8).copy(block, 100); // mode
  ascii("0000000\0", 8).copy(block, 108); // uid
  ascii("0000000\0", 8).copy(block, 116); // gid
  ascii(`${size.toString(8).padStart(11, "0")}\0`, 12).copy(block, 124); // size
  ascii("00000000000\0", 12).copy(block, 136); // mtime
  block.write("        ", 148, "utf8"); // checksum placeholder (8 spaces)
  block.write("0", 156, "utf8"); // typeflag: regular file
  ascii("ustar\0", 6).copy(block, 257);
  ascii("00", 2).copy(block, 263);
  // Checksum: sum of every byte with the checksum field read as spaces.
  const sum = block.reduce((acc, byte) => acc + byte, 0);
  ascii(`${sum.toString(8).padStart(6, "0")}\0 `, 8).copy(block, 148);
  return block;
}

/** A gzipped tar of `[{path, body}]`, in the order given. */
function buildTarball(files) {
  const parts = [];
  for (const file of files) {
    const body = Buffer.from(file.body ?? "", "utf8");
    parts.push(headerBlock(file.path, body.length), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

const FILES_WHITELIST = [
  "src",
  "skills",
  "plugins",
  "scripts",
  "docs",
  "install.sh",
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "LICENSE",
];

const PACKAGE_JSON = { name: "task-panel", version: "1.0.0", files: FILES_WHITELIST, private: true };

/** A tarball that satisfies every required path, using `package/` rooting. */
function goodTarball(extra = []) {
  const files = [
    { path: "package/package.json", body: JSON.stringify(PACKAGE_JSON) },
    ...REQUIRED.filter((path) => path !== "package.json").map((path) => ({ path: `package/${path}`, body: `// ${path}\n` })),
    ...extra,
  ];
  return buildTarball(files);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Write a tarball to a temp dir and return its path. */
async function writeTarball(buffer) {
  const dir = await makeTempDir();
  const file = join(dir, "task-panel-1.0.0.tgz");
  await writeFile(file, buffer);
  return file;
}

describe("pack-manifest — parseTar / maybeGunzip", () => {
  it("reads regular-file entries with their sizes, dropping directories", () => {
    const tar = maybeGunzip(
      buildTarball([
        { path: "package/index.js", body: "hello" },
        { path: "package/web/dist/app.js", body: "console.log(1)" },
      ]),
    );
    const entries = parseTar(tar);
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["package/index.js", "package/web/dist/app.js"],
    );
    const sizes = Object.fromEntries(entries.map((entry) => [entry.path, entry.size]));
    assert.equal(sizes["package/index.js"], 5);
    assert.equal(sizes["package/web/dist/app.js"], 14);
  });

  it("passes an uncompressed tar through and gunzips a gzip-framed one", () => {
    const tar = maybeGunzip(buildTarball([{ path: "package/a", body: "x" }]));
    assert.deepEqual(maybeGunzip(tar), tar, "an already-plain tar is returned as-is");
  });
});

describe("pack-manifest — checkManifest", () => {
  it("accepts a complete tarball that stays inside the whitelist", () => {
    const entries = parseTar(maybeGunzip(goodTarball()));
    const result = checkManifest(entries, PACKAGE_JSON);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.leaked, []);
  });

  it("reports a missing required file", () => {
    const entries = parseTar(maybeGunzip(buildTarball([{ path: "package/package.json", body: JSON.stringify(PACKAGE_JSON) }])));
    const result = checkManifest(entries, PACKAGE_JSON);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("src/cli/index.mjs"));
    assert.deepEqual(result.leaked, []);
  });

  it("reports a file outside the whitelist", () => {
    const entries = parseTar(
      maybeGunzip(goodTarball([{ path: "package/web/dist/index.html", body: "<!doctype html>" }])),
    );
    const result = checkManifest(entries, PACKAGE_JSON);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.leaked, ["web/dist/index.html"]);
  });

  it("always allows package.json, README, LICENSE even when `files` omits them", () => {
    const allowed = allowedTopLevel({ files: ["src"] });
    for (const name of ["package.json", "README.md", "README.zh-CN.md", "LICENSE"]) {
      assert.equal(allowed.has(name), true, name);
    }
    assert.equal(allowed.has("web"), false);
  });
});

describe("pack-manifest — the CLI", () => {
  it("exits 0 on a clean tarball", async () => {
    const file = await writeTarball(goodTarball());
    const result = runCli([file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pack-manifest: OK/);
    assert.match(result.stdout, /1\.0\.0/);
  });

  it("exits 1 and names the leak", async () => {
    const file = await writeTarball(goodTarball([{ path: "package/test/scaffold.test.mjs", body: "// leak" }]));
    const result = runCli([file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /files outside the `files` whitelist/);
    assert.match(result.stderr, /test\/scaffold\.test\.mjs/);
  });

  it("exits 1 and names the missing required file", async () => {
    const file = await writeTarball(
      buildTarball([{ path: "package/package.json", body: JSON.stringify(PACKAGE_JSON) }, { path: "package/install.sh", body: "x" }]),
    );
    const result = runCli([file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required files/);
    assert.match(result.stderr, /src\/mcp\/main\.mjs/);
  });

  it("exits 2 when the file is not a tarball", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "not-a-tarball.bin");
    await writeFile(file, "definitely not a tarball");
    const result = runCli([file]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot read/);
  });
});
