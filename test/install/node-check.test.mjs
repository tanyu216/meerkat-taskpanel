/**
 * `require_node` boundary, exercised through the real dispatcher.
 *
 * `install.sh` checks the runtime *before* dispatching any host installer (the
 * per-host runs then inherit `TASKPANEL_SKIP_NODE_CHECK=1`, so the one check that
 * matters is the dispatcher's own). The check lives in
 * `scripts/install/_common.sh` and uses only shell builtins plus `command`, so the
 * honest way to test it is a fake `node` on an isolated `PATH` — a real child,
 * a fake external binary, never a mocked internal function.
 *
 * The fake `PATH` still carries symlinks to the few standard tools the installer
 * needs around the check (`bash`, `dirname`, `tr`, `sed`), so an exit-0 dry run
 * can reach the summary the same way a real install would.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL = join(ROOT, "install.sh");
const HOST_INSTALLER = join(ROOT, "scripts/install/claude.sh");

/** Standard tools the installer needs on PATH besides `node` (POSIX utilities). */
const TOOLS = ["bash", "dirname", "tr", "sed"];

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Resolve a command's real path from this process's own PATH. */
function realTool(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find ${name} on PATH — needed to build the isolated fake bin`);
}

const REAL = Object.fromEntries(TOOLS.map((name) => [name, realTool(name)]));

/**
 * Build an isolated bin dir. `nodeVersion` is the exact stdout a fake `node -v`
 * should print, or `null` to leave `node` off the PATH entirely.
 */
function makeFakeBin(nodeVersion) {
  const dir = makeTempDir("taskpanel-fakebin-");
  for (const name of TOOLS) symlinkSync(REAL[name], join(dir, name));
  if (nodeVersion !== null) {
    // Absolute shebang: the isolated PATH has no `env`, so the shim must name
    // its interpreter directly. `node -v` output is printed verbatim.
    writeFileSync(join(dir, "node"), `#!${REAL.bash}\nprintf '%s\\n' '${nodeVersion}'\n`);
    chmodSync(join(dir, "node"), 0o755);
  }
  return dir;
}

function runInstall(fakeBin, { args = ["--target", "all", "--dry-run"], env = {} } = {}) {
  const home = makeTempDir("taskpanel-install-home-");
  return spawnSync(REAL.bash, [INSTALL, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: fakeBin,
      HOME: home,
      TASKPANEL_TARGET_HOME: home,
      ...env,
    },
  });
}

/**
 * Run a per-host installer *directly* (not through `install.sh`). The host
 * script sources `_common.sh` and `install_skill` calls `require_node` on its
 * own, so this is the path a bare `bash scripts/install/claude.sh` takes. A dry
 * run never reaches the `node apply.mjs` helpers, so the fake `node` (which only
 * answers `-v`) is enough for both the refuse and the accept case.
 */
function runHost(fakeBin, { env = {} } = {}) {
  const home = makeTempDir("taskpanel-host-home-");
  return spawnSync(REAL.bash, [HOST_INSTALLER], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: fakeBin,
      HOME: home,
      TASKPANEL_TARGET_HOME: home,
      TASKPANEL_DRY_RUN: "1",
      ...env,
    },
  });
}

describe("require_node — the dispatcher's runtime check", () => {
  it("refuses a PATH with no node (exit 2)", () => {
    const run = runInstall(makeFakeBin(null));
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /no 'node' on PATH/);
  });

  it("refuses a node below the floor (v20.0.0)", () => {
    const run = runInstall(makeFakeBin("v20.0.0"));
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /too old/);
  });

  it("refuses a node below the floor (v21.99.9)", () => {
    const run = runInstall(makeFakeBin("v21.99.9"));
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /too old/);
  });

  it("accepts a node at the floor (v22.0.0) and completes the dry run", () => {
    const run = runInstall(makeFakeBin("v22.0.0"));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== install summary ==/);
  });

  it("rejects a non-numeric TASKPANEL_MIN_NODE instead of failing open (D1a)", () => {
    const run = runInstall(makeFakeBin("v20.0.0"), { env: { TASKPANEL_MIN_NODE: "abc" } });
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /TASKPANEL_MIN_NODE/);
  });

  it("rejects an overflowing TASKPANEL_MIN_NODE instead of failing open (D1a-残)", () => {
    const run = runInstall(makeFakeBin("v20.0.0"), { env: { TASKPANEL_MIN_NODE: "999999999999999999999" } });
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /TASKPANEL_MIN_NODE/);
  });

  it("rejects TASKPANEL_MIN_NODE just past INT64_MAX (2^63)", () => {
    const run = runInstall(makeFakeBin("v20.0.0"), { env: { TASKPANEL_MIN_NODE: "9223372036854775808" } });
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /TASKPANEL_MIN_NODE/);
  });

  it("still compares correctly when TASKPANEL_MIN_NODE is exactly INT64_MAX", () => {
    const run = runInstall(makeFakeBin("v20.0.0"), { env: { TASKPANEL_MIN_NODE: "9223372036854775807" } });
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /too old/);
  });

  it("rejects a huge node -v instead of failing open (D1a second face)", () => {
    const run = runInstall(makeFakeBin("v999999999999999999999"));
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, /could not read the version/);
  });

  it("rejects an unparseable node -v (could not read the version)", () => {
    for (const bad of ["not-a-version", ""]) {
      const run = runInstall(makeFakeBin(bad));
      assert.equal(run.status, 2, run.stdout);
      assert.match(run.stderr, /could not read the version/);
    }
  });

  it("honours a custom TASKPANEL_MIN_NODE=24 at the installer layer (D-R2)", () => {
    const refused = runInstall(makeFakeBin("v23.0.0"), { env: { TASKPANEL_MIN_NODE: "24" } });
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /too old/);
    const accepted = runInstall(makeFakeBin("v24.0.0"), { env: { TASKPANEL_MIN_NODE: "24" } });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /== install summary ==/);
  });

  it("treats an empty TASKPANEL_MIN_NODE as the default floor (D-R1)", () => {
    const run = runInstall(makeFakeBin("v22.0.0"), { env: { TASKPANEL_MIN_NODE: "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== install summary ==/);
  });

  it("parses a node -v padded with leading whitespace (D1b)", () => {
    const run = runInstall(makeFakeBin("  v22.0.0"));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== install summary ==/);
  });

  it("--skip-node-check bypasses the check even with no node", () => {
    const run = runInstall(makeFakeBin(null), { args: ["--target", "all", "--dry-run", "--skip-node-check"] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== install summary ==/);
  });

  it("TASKPANEL_SKIP_NODE_CHECK=1 bypasses the check even with no node", () => {
    const run = runInstall(makeFakeBin(null), { env: { TASKPANEL_SKIP_NODE_CHECK: "1" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /== install summary ==/);
  });
});

describe("require_node — a direct per-host installer run is guarded too", () => {
  it("refuses a below-floor node on a direct run (exit 1)", () => {
    const run = runHost(makeFakeBin("v20.0.0"));
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /too old/);
  });

  it("accepts an at-floor node and completes the dry run", () => {
    const run = runHost(makeFakeBin("v22.0.0"));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /would copy/);
  });
});
