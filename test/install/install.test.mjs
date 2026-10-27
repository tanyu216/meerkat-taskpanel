/**
 * install.sh dispatch behaviour and the supplementary agent-CLI probe runner.
 *
 * `install.sh` is verified in more depth in `test/scaffold.test.mjs`; this file covers
 * the M4 additions — comma-separated targets, the per-agent-kind summary, and the exit code —
 * plus the "skip cleanly when the agent CLI is absent" contract of
 * `scripts/verify/kind-cli.mjs` (so it can be run anywhere, including CI, without ever
 * reaching the network).
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, kindConfigDirFor, runInstall, cleanup } = createInstallHarness({
  prefix: "meerkat-taskpanel-install-",
});

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
    for (const agentDir of [".claude", ".codex"]) {
      assert.ok(existsSync(join(home, agentDir, "skills", "meerkat", "SKILL.md")), `${agentDir} install missing`);
    }
    for (const agentDir of [".openclaw", ".agents"]) {
      assert.equal(existsSync(join(home, agentDir)), false, `${agentDir} must not be installed`);
    }
  });

  it("accepts a comma-separated --target list and installs exactly those kinds", () => {
    // The comma path is pinned for a pair that is not the default set: their skill must
    // land, and nothing else may come along.
    const home = makeTempDir();
    const run = runInstall(["--target", "pi,openclaw", "--prefix", home]);

    assert.equal(run.status, 0, run.stderr);
    for (const agentDir of [".agents", ".openclaw"]) {
      assert.ok(existsSync(join(home, agentDir, "skills", "meerkat", "SKILL.md")), `${agentDir} install missing`);
    }
    for (const agentDir of [".claude", ".codex"]) {
      assert.equal(existsSync(join(home, agentDir)), false, `${agentDir} must not be installed`);
    }
  });

  it("recommends the pi subagent extension when it is absent", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "pi", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /pi install npm:pi-subagents/);
  });

  it("stays quiet when the pi subagent extension is already installed", () => {
    const home = makeTempDir();
    mkdirSync(join(home, ".pi", "agent", "extensions", "subagent"), { recursive: true });
    const run = runInstall(["--target", "pi", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /pi install npm:pi-subagents/);
  });

  it("prints a per-agent-kind summary and exits non-zero when an agent kind fails", () => {
    // A target home whose parent is a regular file makes the skill copy fail with
    // ENOTDIR — the honest "agent-kind failed" path: exit 1 and a FAIL summary line.
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

  it("installs the runtime tree for --target server and no agent kind", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "server", "--prefix", home],
      { MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1" },
    );

    assert.equal(run.status, 0, run.stderr);
    const tree = join(home, ".meerkat-taskpanel");
    assert.ok(existsSync(join(tree, "src", "server", "main.mjs")));
    assert.ok(existsSync(join(tree, "src", "core", "storage", "migrations", "0001_init.sql")));
    assert.ok(existsSync(join(tree, "bin", "taskd")));
    assert.ok(existsSync(join(tree, "bin", "taskctl")));
    assert.ok(existsSync(join(tree, ".env")));
    assert.ok(existsSync(join(tree, ".data")));
    assert.match(run.stdout, new RegExp(`OK   server — ${tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const agentDir of [".claude", ".openclaw", ".codex", ".agents"]) {
      assert.equal(existsSync(join(home, agentDir)), false, `${agentDir} must not be installed`);
    }
  });

  it("--target server,claude is server-first and points the agent shim at the tree", () => {
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
    assert.ok(serverAt < claudeAt, "the server must be materialized before the agent kind");

    const shim = readFileSync(join(home, ".claude", "bin", "taskctl"), "utf8");
    assert.ok(shim.includes(join(tree, "src", "cli", "index.mjs")), "the shim drives the installed tree");
    const config = readFileSync(join(kindConfigDirFor(home), ".env.claude"), "utf8");
    assert.match(config, new RegExp(`MEERKAT_TASKPANEL_REPO=${tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(
      existsSync(join(home, ".claude", "meerkat-taskpanel.env")),
      false,
      "the legacy per-agent path must not be written",
    );
  });

  it("--target all installs every agent and the server tree", () => {
    const home = makeTempDir();
    const run = runInstall(
      ["--target", "all", "--prefix", home],
      { MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1" },
    );
    assert.equal(run.status, 0, run.stderr);
    const tree = join(home, ".meerkat-taskpanel");
    assert.ok(existsSync(join(tree, "src", "server", "main.mjs")), "all includes the server");
    for (const agentDir of [".claude", ".openclaw", ".codex", ".agents"]) {
      assert.ok(
        existsSync(join(home, agentDir, "skills", "meerkat", "SKILL.md")),
        `${agentDir} must be installed`,
      );
    }
  });

  it("--no-server removes the server from --target all", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "all", "--no-server", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
  });

  it("--target claude,server,pi selects exactly those three", () => {
    const run = runInstall(["--target", "claude,server,pi", "--dry-run"]);
    assert.equal(run.status, 0, run.stderr);
    for (const target of ["server", "claude", "pi"]) {
      assert.ok(run.stdout.includes(`install.sh: ${target}`), `${target} must be selected`);
    }
    for (const absent of ["openclaw", "codex"]) {
      assert.equal(run.stdout.includes(`install.sh: ${absent}`), false, `${absent} must not be selected`);
    }
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

  it("rejects --supervisor-actor-kinds server with a usage error", () => {
    const run = runInstall(["--target", "server", "--supervisor-actor-kinds", "server", "--dry-run"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--supervisor-actor-kinds server/);
  });
});

describe("kind-cli: absent CLIs are skipped, never failed", () => {
  it("SKIPs every agent kind when PATH has no agent CLI and exits 0", () => {
    // An empty bin dir on PATH means the agent CLIs cannot be found — the probe must
    // report SKIP for all of them rather than fail or reach for the network.
    const empty = makeTempDir();
    const run = spawnSync(NODE, [join(ROOT, "scripts/verify/kind-cli.mjs")], {
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

    const run = spawnSync(NODE, [join(ROOT, "scripts/verify/kind-cli.mjs")], {
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
