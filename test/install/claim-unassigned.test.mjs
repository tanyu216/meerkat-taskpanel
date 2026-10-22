/**
 * The "allow claiming unassigned tasks?" wizard and its persisted agent config
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
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-claim-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

/** An executable fake host CLI that does nothing and exits 0. */
function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, `#!/usr/bin/env bash\nexit 0\n`, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

/** An environment that sees fake host CLIs and installs into an isolated home. */
function installEnv(home, bin) {
  return {
    ...process.env,
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    // The taskd guard loads a real OS unit on install; its own cases live in
    // `taskd-guard.test.mjs`. This is the contract's test-only bypass.
    MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
    PATH: `${bin}:${process.env.PATH}`,
  };
}

function configOf(home, agentDir) {
  const path = join(home, agentDir, "meerkat-taskpanel.env");
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

    for (const agentDir of [".claude", ".codex"]) {
      const text = configOf(home, agentDir);
      assert.ok(text !== null, `${agentDir}/meerkat-taskpanel.env must exist`);
      assert.match(text, /^MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes$/m, `${agentDir} default must be yes`);
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

describe("install.sh: the workflow config", () => {
  it("persists the defaults: workflow on, auto-accept on, no reviewer", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".claude");
    assert.match(text, /^MEERKAT_TASKPANEL_WORKFLOW=yes$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=yes$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=$/m, "empty is 'not configured', deliberately");
    assert.match(text, /^MEERKAT_TASKPANEL_RECOVER_STALE=yes$/m);
  });

  it("persists --reviewer / --workflow=no / --auto-accept-reviews=no", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(
      [
        "--target", "codex", "--agent-name", "alice", "--reviewer", "jobs",
        "--workflow=no", "--auto-accept-reviews=no", "--recover-stale=no",
      ],
      installEnv(home, bin),
    );
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".codex");
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=jobs$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_WORKFLOW=no$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=no$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_RECOVER_STALE=no$/m);
  });

  it("takes the values from the environment when no flag is given", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], {
      ...installEnv(home, bin),
      MEERKAT_TASKPANEL_WORKFLOW: "no",
      MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS: "no",
      MEERKAT_TASKPANEL_REVIEWER: "jobs",
    });
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".claude");
    assert.match(text, /^MEERKAT_TASKPANEL_WORKFLOW=no$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=no$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=jobs$/m);
  });

  it("rejects an invalid yes/no before installing anything", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    for (const flag of ["--workflow=maybe", "--auto-accept-reviews=perhaps", "--recover-stale=sometimes"]) {
      const run = runInstall(["--target", "claude", "--prefix", home, flag], {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      });
      assert.equal(run.status, 2, `${flag} must be a usage error`);
      assert.match(run.stderr, flag.startsWith("--workflow") ? /--workflow/ : flag.startsWith("--recover") ? /--recover-stale/ : /--auto-accept-reviews/);
      assert.equal(existsSync(join(home, ".claude")), false);
    }
  });

  it("upgrades an older config by adding only the missing keys", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice", "--claim-unassigned=no"], env).status, 0);

    // Rewrite the file as a pre-workflow install: the two keys it always had, and a
    // deliberate auto-accept choice the upgrade must not touch.
    const path = join(home, ".claude", "meerkat-taskpanel.env");
    writeFileSync(
      path,
      "MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no\nMEERKAT_TASKPANEL_REPO=/old/checkout\nMEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=no\n",
      "utf8",
    );

    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice", "--reviewer", "jobs"], env).status, 0);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=no$/m, "the existing choice is kept");
    assert.match(text, /^MEERKAT_TASKPANEL_WORKFLOW=yes$/m, "the missing key is added");
    assert.match(text, /^MEERKAT_TASKPANEL_RECOVER_STALE=yes$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_REVIEWER=jobs$/m);
    assert.equal(text.match(/^MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS=/gm).length, 1, "never duplicated");
  });
});

describe("install.sh: the scheduler's two clocks", () => {
  it("persists the defaults: ping 60s, continue 600s, continue on", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".claude");
    assert.match(text, /^MEERKAT_TASKPANEL_PING_INTERVAL=60$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=600$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE=yes$/m);
  });

  it("persists --ping-interval / --continue-interval / --continue=no", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(
      [
        "--target", "codex", "--agent-name", "alice",
        "--ping-interval", "30", "--continue-interval", "900", "--continue=no",
      ],
      installEnv(home, bin),
    );
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".codex");
    assert.match(text, /^MEERKAT_TASKPANEL_PING_INTERVAL=30$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=900$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE=no$/m);
  });

  it("takes the clocks from the environment when no flag is given", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], {
      ...installEnv(home, bin),
      MEERKAT_TASKPANEL_PING_INTERVAL: "45",
      MEERKAT_TASKPANEL_CONTINUE_INTERVAL: "120",
      MEERKAT_TASKPANEL_CONTINUE: "no",
    });
    assert.equal(run.status, 0, run.stderr);
    const text = configOf(home, ".claude");
    assert.match(text, /^MEERKAT_TASKPANEL_PING_INTERVAL=45$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=120$/m);
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE=no$/m);
  });

  it("rejects an invalid interval or continue value before installing anything", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    for (const flag of ["--ping-interval=0", "--continue-interval=abc", "--continue=maybe"]) {
      const run = runInstall(["--target", "claude", "--prefix", home, flag], {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
      });
      assert.equal(run.status, 2, `${flag} must be a usage error`);
      assert.equal(existsSync(join(home, ".claude")), false);
    }
  });

  it("adds the clock keys to an older agent config without touching existing values", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], env).status, 0);

    const path = join(home, ".claude", "meerkat-taskpanel.env");
    writeFileSync(path, "MEERKAT_TASKPANEL_CONTINUE=no\n", "utf8");
    const again = runInstall(["--target", "claude", "--agent-name", "alice", "--continue-interval", "900"], env);
    assert.equal(again.status, 0, again.stderr);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^MEERKAT_TASKPANEL_CONTINUE=no$/m, "the existing choice is kept");
    assert.match(text, /^MEERKAT_TASKPANEL_PING_INTERVAL=60$/m, "the missing key is added");
    assert.equal(text.match(/^MEERKAT_TASKPANEL_CONTINUE_INTERVAL=/gm).length, 1, "never duplicated");
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
