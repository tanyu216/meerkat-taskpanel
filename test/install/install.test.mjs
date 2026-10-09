/**
 * install.sh dispatch behaviour and the supplementary host-CLI probe runner.
 *
 * `install.sh` is verified in more depth in `test/scaffold.test.mjs`; this file covers
 * the M4 additions — comma-separated targets, the per-host summary, and the exit code —
 * plus the "skip cleanly when the host CLI is absent" contract of
 * `scripts/verify/host-cli.mjs` (so it can be run anywhere, including CI, without ever
 * reaching the network).
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = process.execPath;

const tempDirs = [];
function makeTempDir(prefix = "taskpanel-install-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runInstall(args, env = {}) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("install.sh: targets", () => {
  it("accepts a comma-separated --target list", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude,codex", "--prefix", home]);

    assert.equal(run.status, 0, run.stderr);
    for (const hostDir of [".claude", ".codex"]) {
      assert.ok(existsSync(join(home, hostDir, "skills", "task-panel", "SKILL.md")), `${hostDir} install missing`);
    }
    for (const hostDir of [".openclaw", ".agents"]) {
      assert.equal(existsSync(join(home, hostDir)), false, `${hostDir} must not be installed`);
    }
  });

  it("prints a per-host summary and exits non-zero when a host fails", () => {
    // A target home whose parent is a regular file makes the skill copy fail with
    // ENOTDIR — the honest "host failed" path: exit 1 and a FAIL summary line.
    const block = join(makeTempDir(), "block");
    writeFileSync(block, "not a directory", "utf8");
    const home = join(block, "home");
    const run = runInstall(["--target", "claude", "--prefix", home]);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /== install summary ==/);
    assert.match(run.stdout, /FAIL claude/);
  });

  it("re-running a completed install is idempotent, not a failure", () => {
    const home = makeTempDir();
    assert.equal(runInstall(["--target", "claude", "--prefix", home]).status, 0);

    const again = runInstall(["--target", "claude", "--prefix", home]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /== install summary ==/);
    assert.match(again.stdout, /OK   claude/);
    assert.match(again.stdout, /already installed/);
  });

  it("rejects an unknown --target with a usage error (exit 2)", () => {
    const run = runInstall(["--target", "emacs"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /invalid --target: emacs/);
  });
});

describe("host-cli: absent CLIs are skipped, never failed", () => {
  it("SKIPs every host when PATH has no host CLI and exits 0", () => {
    // An empty bin dir on PATH means the host CLIs cannot be found — the probe must
    // report SKIP for all of them rather than fail or reach for the network.
    const empty = makeTempDir();
    const run = spawnSync(NODE, [join(ROOT, "scripts/verify/host-cli.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: empty },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.equal((run.stdout.match(/^SKIP /gm) ?? []).length, 4, run.stdout);
    assert.match(run.stdout, /0 passed, 0 failed, 4 skipped/);
  });
});
