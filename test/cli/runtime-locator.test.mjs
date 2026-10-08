/**
 * Step 2: the path resolvers live in `shared` and are re-exported by core.
 *
 * The point of the move is that `src/cli` can find the token and the runtime
 * pointer *without* importing `src/core/storage`. So this file asserts both
 * halves of the seam: the shared implementation, and that core's facade is the
 * same function (not a copy that can drift).
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  repoRoot,
  resolveDataDir,
  resolveDbPath,
  resolveRuntimePointerPath,
  tokenPath,
} from "../../src/shared/runtime-locator.mjs";
import * as paths from "../../src/core/storage/paths.mjs";

/** The real repository root, derived the same way — not assumed to be named. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("shared/runtime-locator", () => {
  it("derives the repository root from its own location", () => {
    assert.equal(repoRoot(), REPO_ROOT);
    assert.equal(resolveDataDir({ env: {} }), join(repoRoot(), ".data"));
    assert.equal(resolveDataDir({ env: { TASKD_DATA_DIR: "/tmp/x" } }), "/tmp/x");
  });

  it("resolves the database path with TASKD_DB absolute-wins semantics", () => {
    assert.equal(resolveDbPath({ env: {} }), join(repoRoot(), ".data", "board.sqlite"));
    assert.equal(resolveDbPath({ env: { TASKD_DB: "/tmp/b.sqlite" } }), "/tmp/b.sqlite");
    assert.equal(resolveDbPath({ env: { TASKD_DB: "other.sqlite" }, dataDir: "/tmp/d" }), "/tmp/d/other.sqlite");
  });

  it("places the token beside the database", () => {
    assert.equal(tokenPath("/tmp/d"), "/tmp/d/token");
  });

  it("honours TASKD_RUNTIME_POINTER over the per-user default", () => {
    assert.equal(
      resolveRuntimePointerPath({ env: { TASKD_RUNTIME_POINTER: "/tmp/rt.json" } }),
      "/tmp/rt.json",
    );
    assert.equal(
      resolveRuntimePointerPath({ platform: "darwin", home: "/home/tester", env: {} }),
      "/home/tester/Library/Application Support/TaskPanel/runtime.json",
    );
    assert.equal(
      resolveRuntimePointerPath({ platform: "linux", home: "/home/tester", env: { XDG_STATE_HOME: "/xdg" } }),
      "/xdg/task-panel/runtime.json",
    );
    assert.equal(
      resolveRuntimePointerPath({ platform: "linux", home: "/home/tester", env: {} }),
      "/home/tester/.local/state/task-panel/runtime.json",
    );
  });
});

describe("core/storage/paths — the facade", () => {
  it("re-exports the shared resolvers by identity (one implementation, not two)", () => {
    const shared = { repoRoot, resolveDataDir, resolveDbPath, resolveRuntimePointerPath, tokenPath };
    for (const [name, fn] of Object.entries(shared)) {
      assert.equal(paths[name], fn, `${name} must be re-exported, not redefined`);
    }
  });

  it("keeps the one writing helper it owns", () => {
    assert.equal(typeof paths.ensureDir, "function");
    assert.equal(typeof paths.ensureParentDir, "function");
    assert.equal(typeof paths.isMemoryPath, "function");
  });
});
