/**
 * The npm/npx installer wrapper.
 *
 * The wrapper is a translation layer: it decides the default target set and
 * points host installs at the materialized tree. It must not grow a second
 * install implementation, so the cases here are the plan and the dry-run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { planTargets, splitTargets } from "../../scripts/install/cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "scripts", "install", "cli.mjs");
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-cli-wrapper-"));
  dirs.push(dir);
  return dir;
}

function run(argv, env = {}) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
      MEERKAT_TASKPANEL_SKIP_NODE_CHECK: "1",
      MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1",
      ...env,
    },
  });
}

describe("cli-wrapper — target planning", () => {
  it("defaults to server + all hosts, server first", () => {
    assert.deepEqual(planTargets({}), { targets: "server,all", server: true });
    assert.deepEqual(planTargets({ targets: "claude,codex" }), {
      targets: "server,claude,codex",
      server: true,
    });
    assert.deepEqual(planTargets({ targets: "server" }), { targets: "server", server: true });
  });

  it("--no-server installs only the selected hosts", () => {
    assert.deepEqual(planTargets({ noServer: true }), { targets: "all", server: false });
    assert.deepEqual(planTargets({ noServer: true, targets: "claude" }), {
      targets: "claude",
      server: false,
    });
  });

  it("refuses --no-server with a server target, and an empty selection", () => {
    assert.throws(() => planTargets({ noServer: true, targets: "server" }), /--no-server/);
    assert.throws(() => planTargets({ targets: "," }), /no targets/);
  });

  it("splits a comma list and drops blanks", () => {
    assert.deepEqual(splitTargets(" claude, ,codex ,"), ["claude", "codex"]);
  });
});

describe("cli-wrapper — dry run", () => {
  it("materializes the tree path without writing", () => {
    const home = tempDir();
    const runResult = run(["install", "--prefix", home, "--target", "server", "--dry-run"]);
    assert.equal(runResult.status, 0, runResult.stderr);
    const tree = join(home, ".meerkat-taskpanel");
    assert.ok(runResult.stdout.includes(tree));
    assert.ok(runResult.stdout.includes(join(tree, "bin", "taskd")));
    assert.equal(existsSync(tree), false);
  });

  it("defaults to the full install (server first, then the hosts)", () => {
    const home = tempDir();
    const runResult = run(["--prefix", home, "--dry-run"]);
    assert.equal(runResult.status, 0, runResult.stderr);
    const serverAt = runResult.stdout.indexOf("install.sh: server");
    const claudeAt = runResult.stdout.indexOf("install.sh: claude");
    assert.ok(serverAt !== -1 && claudeAt !== -1, runResult.stdout);
    assert.ok(serverAt < claudeAt, "server must be installed before the hosts");
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
  });

  it("--no-server leaves the server out", () => {
    const home = tempDir();
    const runResult = run(["install", "--prefix", home, "--no-server", "--dry-run"]);
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.equal(runResult.stdout.includes("install.sh: server"), false);
    assert.ok(runResult.stdout.includes("install.sh: claude"));
  });

  it("--help and an unknown command", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: meerkat-taskpanel/);
    assert.match(help.stdout, /--no-server/);

    const bad = run(["frobnicate"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown command: frobnicate/);
  });
});
