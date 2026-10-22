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
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-install-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = process.execPath;

after(cleanup);

// MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE is the contract's own test-only bypass for the
// taskd keepalive guard (`docs/scheduling.md`): an install really does load an OS unit,
// and a test must never do that. The guard has its own cases in `taskd-guard.test.mjs`,
// where the supervisor is faked on PATH.

describe("install.sh: targets", () => {
  it("accepts a comma-separated --target list", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "claude,codex", "--prefix", home]);

    assert.equal(run.status, 0, run.stderr);
    for (const hostDir of [".claude", ".codex"]) {
      assert.ok(existsSync(join(home, hostDir, "skills", "meerkat-taskpanel", "SKILL.md")), `${hostDir} install missing`);
    }
    for (const hostDir of [".openclaw", ".agents", ".config/opencode", ".cursor"]) {
      assert.equal(existsSync(join(home, hostDir)), false, `${hostDir} must not be installed`);
    }
  });

  it("accepts the later two hosts in a comma-separated --target list", () => {
    // opencode and cursor joined the target set after claude/codex/pi, so the comma path
    // is pinned for them too: their skill must land, and nothing else may come along.
    const home = makeTempDir();
    const run = runInstall(["--target", "opencode,cursor", "--prefix", home]);

    assert.equal(run.status, 0, run.stderr);
    for (const hostDir of [".config/opencode", ".cursor"]) {
      assert.ok(existsSync(join(home, hostDir, "skills", "meerkat-taskpanel", "SKILL.md")), `${hostDir} install missing`);
    }
    for (const hostDir of [".claude", ".codex", ".openclaw", ".agents"]) {
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
    assert.match(run.stderr, /server/, "the expected list names server");
  });

  it("installs the runtime tree for --target server and no host", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "server", "--prefix", home],
      { MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1" },
    );

    assert.equal(run.status, 0, run.stderr);
    const tree = join(home, ".meerkat-taskpanel");
    assert.ok(existsSync(join(tree, "src", "server", "main.mjs")));
    assert.ok(existsSync(join(tree, "src", "core", "storage", "migrations", "0001_core_tables.sql")));
    assert.ok(existsSync(join(tree, "bin", "taskd")));
    assert.ok(existsSync(join(tree, "bin", "taskctl")));
    assert.ok(existsSync(join(tree, ".env")));
    assert.ok(existsSync(join(tree, ".data")));
    assert.match(run.stdout, new RegExp(`OK   server — ${tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const hostDir of [".claude", ".openclaw", ".codex", ".agents", ".config/opencode", ".cursor"]) {
      assert.equal(existsSync(join(home, hostDir)), false, `${hostDir} must not be installed`);
    }
  });

  it("--target server,claude is server-first and points the host shim at the tree", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "server,claude", "--prefix", home],
      { MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1" },
    );
    assert.equal(run.status, 0, run.stderr);
    const tree = join(home, ".meerkat-taskpanel");

    const serverAt = run.stdout.indexOf("OK   server");
    const claudeAt = run.stdout.indexOf("OK   claude");
    assert.ok(serverAt !== -1 && claudeAt !== -1);
    assert.ok(serverAt < claudeAt, "the server must be materialized before the host");

    const shim = readFileSync(join(home, ".claude", "bin", "taskctl"), "utf8");
    assert.ok(shim.includes(join(tree, "src", "cli", "index.mjs")), "the shim drives the installed tree");
    const config = readFileSync(join(home, ".claude", "meerkat-taskpanel.env"), "utf8");
    assert.match(config, new RegExp(`MEERKAT_TASKPANEL_REPO=${tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(readFileSync(join(tree, ".env"), "utf8"), /TASKD_ACCEPTANCE_POLICY=both/);
  });

  it("--target all stays host-only and never creates the server tree", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "all", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
  });

  it("--target server --link warns and still copies a real directory", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "server", "--prefix", home, "--link"],
      { MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--link does not apply to the server target/);
    const tree = join(home, ".meerkat-taskpanel");
    assert.equal(lstatSync(tree).isSymbolicLink(), false);
  });

  it("rejects --supervisor-hosts server with a usage error", () => {
    const run = runInstall(["--target", "server", "--supervisor-hosts", "server", "--dry-run"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--supervisor-hosts server/);
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

  it("SKIPs (not FAILs) when a PATH element is a regular file (ENOTDIR)", () => {
    // A `PATH` element that is a regular file — not a directory — makes the bare-name
    // lookup die with ENOTDIR before it can report a miss. That is the same outcome as
    // ENOENT ("this CLI is not here"), so it must SKIP too: one stray file entry on PATH
    // must not fail every absent CLI's probe.
    const notADir = join(makeTempDir(), "a-file-not-a-dir");
    writeFileSync(notADir, "not a directory\n", "utf8");
    assert.equal(statSync(notADir).isDirectory(), false, "fixture precondition: this PATH entry must be a file");

    const run = spawnSync(NODE, [join(ROOT, "scripts/verify/host-cli.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: notADir },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.equal((run.stdout.match(/^FAIL /gm) ?? []).length, 0, run.stdout);
    assert.ok((run.stdout.match(/^SKIP /gm) ?? []).length >= 4, run.stdout);
    assert.match(run.stdout, /0 passed, 0 failed, \d+ skipped/);
  });
});
