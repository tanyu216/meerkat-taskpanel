/**
 * The symlink-safe entry-point guard (`src/shared/entry-guard.mjs`).
 *
 * `import.meta.url` is resolved through `realpath` by Node while `process.argv[1]` is kept as
 * invoked, so any entry-point comparison that does not canonicalise *both* sides is false
 * whenever the path carries a symlink — silently, with exit 0. This file pins the two
 * functions that fix that; the behavioural half (every real entry point, run twice through a
 * symlinked ancestor) lives in `test/install/apply-guard.test.mjs`, which owns that fixture.
 *
 * These legs are deliberately **in-process**: a child `node` run earns no coverage of
 * `src/shared/**`, which is under an 80% floor.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { canonicalPath, isEntryPoint } from "../../src/shared/entry-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUARD = join(ROOT, "src", "shared", "entry-guard.mjs");
const HERE = fileURLToPath(import.meta.url);
const SELF_URL = import.meta.url;

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-entry-guard-") {
  // realpath'd immediately: on macOS `tmpdir()` is already under the `/var` symlink, and a
  // fixture whose *own* root is symlinked would not isolate the symlink under test.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("canonicalPath", () => {
  it("resolves a symlinked path to its target", () => {
    const base = makeTempDir();
    const real = join(base, "real.txt");
    writeFileSync(real, "x", "utf8");
    const link = join(base, "link.txt");
    symlinkSync(real, link);

    assert.notEqual(realpathSync(link), link, "fixture precondition: the link must differ from its target");
    assert.equal(canonicalPath(link), real);
  });

  it("falls back to resolve() for a path that does not exist", () => {
    const missing = join(makeTempDir(), "not-there.txt");
    assert.equal(canonicalPath(missing), resolve(missing));
  });
});

describe("isEntryPoint", () => {
  it("is false for a non-string argv[1] (a stray null, or a number)", () => {
    // `undefined` deliberately is NOT used here: an explicit `undefined` triggers the default
    // parameter, so it would silently test the live `process.argv[1]` instead. The real
    // no-argv[1] case is the child leg below; this one covers the same branch and pins that a
    // stray value is refused rather than reaching `realpathSync`.
    assert.equal(isEntryPoint(SELF_URL, null), false);
  });

  it("is false when the process really has no argv[1] (node -e, a REPL)", () => {
    // The honest version of the case above: `node -e` leaves `process.argv[1]` undefined, so
    // the default parameter itself is undefined. A child is the only way to observe that.
    const script =
      `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(GUARD).href)};\n` +
      `process.stdout.write(String(isEntryPoint(import.meta.url)));\n`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "false");
  });

  it("is true for this module's own path, and for its symlinked spelling", () => {
    assert.equal(isEntryPoint(SELF_URL, HERE), true, "the canonical path must match");

    const link = join(makeTempDir(), "entry-guard-link.mjs");
    symlinkSync(HERE, link);
    assert.notEqual(realpathSync(link), link, "fixture precondition: the invoked path must carry a symlink");

    assert.equal(isEntryPoint(SELF_URL, link), true, "a symlinked invocation must still be the entry point");
  });

  it("is false for a different file", () => {
    assert.equal(isEntryPoint(SELF_URL, join(ROOT, "package.json")), false);
  });
});
