/**
 * The "allow claiming unassigned tasks?" wizard and its persisted host config
 * (T-20261010-013000).
 *
 * `install.sh` asks the question when stdin is a TTY and no flag was given,
 * defaults to **yes** everywhere else, and persists the answer as
 * `<target_home>/<host-dir>/meerkat-taskpanel.env` (`MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=…`) —
 * the file `scripts/supervisor.mjs` reads as its default. OpenClaw is the one
 * host that gets no such file, because it does not build its own supervisor
 * (it installs openclaw-team, whose poll/patrol already implement the design).
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-claim-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** An executable fake host CLI that does nothing and exits 0. */
function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, `#!/usr/bin/env bash\nexit 0\n`, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

/** An environment that sees fake host CLIs and installs into an isolated home. */
function installEnv(home, bin) {
  return { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: home, PATH: `${bin}:${process.env.PATH}` };
}

function runInstall(args, env = {}) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function configOf(home, hostDir) {
  const path = join(home, hostDir, "meerkat-taskpanel.env");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Run one line of shell that sources `_common.sh` and calls a function. */
function runCommon(snippet, { input = "" } = {}) {
  return spawnSync("bash", ["-c", `. "$1/scripts/install/_common.sh"\n${snippet}`, "_", ROOT], {
    encoding: "utf8",
    input,
  });
}

describe("install.sh: claim-unassigned flags and persisted config", () => {
  it("defaults to yes (non-interactive) and persists it for claude and codex", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    makeFakeCli(bin, "codex");

    const run = runInstall(["--target", "claude,codex", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    for (const hostDir of [".claude", ".codex"]) {
      const text = configOf(home, hostDir);
      assert.ok(text !== null, `${hostDir}/meerkat-taskpanel.env must exist`);
      assert.match(text, /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes$/m, `${hostDir} default must be yes`);
    }
  });

  it("--claim-unassigned=no persists 'no'", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--claim-unassigned=no"],
      installEnv(home, bin),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(configOf(home, ".claude"), /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);
  });

  it("--assignee-only is an alias for --claim-unassigned=no", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(["--target", "codex", "--agent-name", "alice", "--assignee-only"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);
    assert.match(configOf(home, ".codex"), /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);
  });

  it("honours the MEERKAT_TASKPANEL_CLAIM_UNASSIGNED environment when no flag is given", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      { ...installEnv(home, bin), MEERKAT_TASKPANEL_CLAIM_UNASSIGNED: "no" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(configOf(home, ".claude"), /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no$/m);
  });

  it("rejects an invalid value with a usage error and writes nothing", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--claim-unassigned=maybe"],
      { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--claim-unassigned/);
    assert.equal(existsSync(join(home, ".claude")), false, "an invalid value must not install anything");
  });

  it("--dry-run changes nothing", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--dry-run"],
      { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("is idempotent: a re-run keeps the file byte-identical", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], env).status, 0);
    const before = configOf(home, ".claude");
    const again = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(configOf(home, ".claude"), before);
  });

  it("keeps an existing choice without --force (merge, never clobber)", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice", "--claim-unassigned=no"], env).status, 0);
    // A later run that does not force must not silently flip the policy.
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice", "--claim-unassigned=yes"], env).status, 0);
    assert.match(configOf(home, ".claude"), /=no$/m);
  });

  it("gives OpenClaw no config file — it does not build a supervisor", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "openclaw", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(configOf(home, ".openclaw"), null);
  });
});

describe("_common.sh: claim_unassigned_value decision matrix", () => {
  it("returns an explicit flag verbatim", () => {
    assert.equal(runCommon('claim_unassigned_value yes ""').stdout.trim(), "yes");
    assert.equal(runCommon('claim_unassigned_value no ""').stdout.trim(), "no");
  });

  it("defaults to yes when non-interactive", () => {
    assert.equal(runCommon('claim_unassigned_value "" ""').stdout.trim(), "yes");
  });

  it("prompts when interactive: blank or y is yes, anything else is no", () => {
    assert.equal(runCommon('claim_unassigned_value "" 1', { input: "\n" }).stdout.trim(), "yes");
    assert.equal(runCommon('claim_unassigned_value "" 1', { input: "y\n" }).stdout.trim(), "yes");
    assert.equal(runCommon('claim_unassigned_value "" 1', { input: "Y\n" }).stdout.trim(), "yes");
    assert.equal(runCommon('claim_unassigned_value "" 1', { input: "n\n" }).stdout.trim(), "no");
    assert.equal(runCommon('claim_unassigned_value "" 1', { input: "no\n" }).stdout.trim(), "no");
    // The question is shown on stderr so a piped stdout stays clean.
    assert.match(runCommon('claim_unassigned_value "" 1', { input: "n\n" }).stderr, /Allow claiming unassigned tasks\?/);
  });

  it("rejects an invalid flag value", () => {
    const run = runCommon('claim_unassigned_value maybe ""');
    assert.notEqual(run.status, 0);
  });
});
