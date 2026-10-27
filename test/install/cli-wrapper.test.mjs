/**
 * The npm/npx installer wrapper.
 *
 * The wrapper is a translation layer: it decides the default target set and
 * points agent installs at the materialized tree. It must not grow a second
 * install implementation, so the cases here are the plan and the dry-run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import {
  buildInstallArgs,
  parse,
  planTargets,
  splitTargets,
} from "../../scripts/install/cli.mjs";

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

/** Keep an agent-only install's per-kind config out of the checkout. */
function kindConfigDirOf(argv) {
  const index = argv.indexOf("--prefix");
  return index !== -1 && typeof argv[index + 1] === "string" ? join(argv[index + 1], "kind-config") : null;
}

function run(argv, env = {}) {
  const kindDir = kindConfigDirOf(argv);
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
      MEERKAT_TASKPANEL_SKIP_NODE_CHECK: "1",
      MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1",
      ...(kindDir === null ? {} : { MEERKAT_TASKPANEL_CONFIG_DIR: kindDir }),
      ...env,
    },
  });
}

/** Like `run`, with the wizard's answers on stdin (`--interactive` reads a pipe). */
function runWithInput(argv, input, env = {}) {
  const kindDir = kindConfigDirOf(argv);
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
      MEERKAT_TASKPANEL_SKIP_NODE_CHECK: "1",
      MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1",
      ...(kindDir === null ? {} : { MEERKAT_TASKPANEL_CONFIG_DIR: kindDir }),
      ...env,
    },
  });
}

describe("cli-wrapper — target planning", () => {
  it("defaults to all agents plus the server", () => {
    // `all` carries the server, so the wrapper hands it through unchanged.
    assert.deepEqual(planTargets({}), { targets: "all", server: true });
    assert.deepEqual(planTargets({ targets: "claude,server,pi" }), {
      targets: "server,claude,pi",
      server: true,
    });
    assert.deepEqual(planTargets({ targets: "server" }), { targets: "server", server: true });
  });

  it("an explicit list is literal — an agent list does not add the server", () => {
    assert.deepEqual(planTargets({ targets: "claude,codex" }), {
      targets: "claude,codex",
      server: false,
    });
  });

  it("--no-server installs only the selected agents", () => {
    assert.deepEqual(planTargets({ noServer: true }), { targets: "all", server: false });
    assert.deepEqual(planTargets({ noServer: true, targets: "claude" }), {
      targets: "claude",
      server: false,
    });
  });

  it("refuses --no-server when it leaves nothing, and an empty selection", () => {
    assert.throws(() => planTargets({ noServer: true, targets: "server" }), /no targets/);
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

  it("defaults to the full install (server first, then every agent)", () => {
    const home = tempDir();
    const runResult = run(["--prefix", home, "--dry-run"]);
    assert.equal(runResult.status, 0, runResult.stderr);
    const serverAt = runResult.stdout.indexOf("install.sh: server");
    const claudeAt = runResult.stdout.indexOf("install.sh: claude");
    assert.ok(serverAt !== -1 && claudeAt !== -1, runResult.stdout);
    assert.ok(serverAt < claudeAt, "server must be installed before the agents");
    for (const agent of ["openclaw", "codex", "pi"]) {
      assert.ok(runResult.stdout.includes(`install.sh: ${agent}`), `${agent} must be part of the default`);
    }
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
  });

  it("a comma list selects exactly those targets", () => {
    const home = tempDir();
    const runResult = run(["--target", "claude,server,pi", "--prefix", home, "--dry-run"]);
    assert.equal(runResult.status, 0, runResult.stderr);
    for (const target of ["server", "claude", "pi"]) {
      assert.ok(runResult.stdout.includes(`install.sh: ${target}`), `${target} must be selected`);
    }
    for (const absent of ["openclaw", "codex"]) {
      assert.equal(runResult.stdout.includes(`install.sh: ${absent}`), false, `${absent} must not be selected`);
    }
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
    assert.match(help.stdout, /--interactive/);
    assert.match(help.stdout, /--non-interactive/);

    const bad = run(["frobnicate"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown command: frobnicate/);
  });
});

describe("cli-wrapper — wizard translation", () => {
  it("no options leaves target and prefix to install.sh", () => {
    const args = parse([]);
    const built = buildInstallArgs(args, planTargets(args), "/tmp/home");
    assert.equal(built.wizardMayRun, true);
    assert.deepEqual(built.argv, [join(ROOT, "install.sh")]);
    assert.equal(built.env.MEERKAT_TASKPANEL_TARGET_HOME, "/tmp/home");
    assert.equal(built.env.MEERKAT_TASKPANEL_REPO, undefined);
  });

  it("the bare install command still counts as no options", () => {
    const args = parse(["install"]);
    assert.equal(args.options, 0);
    assert.equal(buildInstallArgs(args, planTargets(args), "/tmp/home").wizardMayRun, true);
  });

  it("--interactive is forwarded without injected defaults", () => {
    const args = parse(["--interactive"]);
    const built = buildInstallArgs(args, planTargets(args), "/tmp/home");
    assert.deepEqual(built.argv, [join(ROOT, "install.sh"), "--interactive"]);
  });

  it("explicit flags prefill the wizard and stay on the argv", () => {
    const args = parse(["-i", "--target", "claude", "--prefix", "/tmp/x"]);
    const built = buildInstallArgs(args, planTargets(args), "/tmp/x");
    assert.equal(built.wizardMayRun, true);
    assert.deepEqual(built.argv, [
      join(ROOT, "install.sh"),
      "--interactive",
      "--target",
      "claude",
      "--prefix",
      "/tmp/x",
    ]);
  });

  it("--yes and --dry-run take the legacy argv", () => {
    const yes = parse(["--yes"]);
    const built = buildInstallArgs(yes, planTargets(yes), "/tmp/home");
    assert.equal(built.wizardMayRun, false);
    assert.deepEqual(built.argv, [
      join(ROOT, "install.sh"),
      "--target",
      "all",
      "--prefix",
      "/tmp/home",
      "--yes",
    ]);
    assert.equal(built.env.MEERKAT_TASKPANEL_REPO, join("/tmp/home", ".meerkat-taskpanel"));

    const dry = parse(["--dry-run"]);
    const dryBuilt = buildInstallArgs(dry, planTargets(dry), "/tmp/home");
    assert.equal(dryBuilt.wizardMayRun, false);
    assert.ok(dryBuilt.argv.includes("--dry-run"));
  });

  it("any other flag opts out of the auto wizard (strict no-arguments rule)", () => {
    const args = parse(["--no-server"]);
    const built = buildInstallArgs(args, planTargets(args), "/tmp/home");
    assert.equal(built.wizardMayRun, false);
    assert.ok(built.argv.includes("--no-server"));
  });

  it("--interactive drives the same shared wizard end to end", () => {
    const home = tempDir();
    // prefix, mode, agents, human, link, claim, recover, workflow, continue, supervisor
    const result = runWithInput(
      ["install", "--interactive", "--target", "claude", "--prefix", home, "--skip-web-build"],
      ["", "", "", "alice", "", "n", "", "", "", ""].map((line) => `${line}\n`).join(""),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /interactive setup/);
    assert.ok(existsSync(join(home, ".claude", "skills", "meerkat", "SKILL.md")));
    assert.equal(existsSync(join(home, ".meerkat-taskpanel")), false);
    const config = readFileSync(join(home, "kind-config", ".env.claude"), "utf8");
    assert.match(config, /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);
    assert.match(config, /^MEERKAT_TASKPANEL_REVIEWER=Reviewer$/m);
  });
});
