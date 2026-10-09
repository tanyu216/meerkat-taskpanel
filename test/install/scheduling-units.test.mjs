/**
 * Scheduling units the installer drops (T-20261010-013000).
 *
 * The supervisor is host-external, so each bundle host gets a scheduling unit
 * (launchd / systemd / cron) plus a wake-glue script, all merge-style and
 * idempotent under an isolated `--prefix` home. The units are *installed*, but
 * a unit only starts when the user loads it, so the installer prints the exact
 * load command instead of running `launchctl` / `systemctl` / `crontab`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];
function makeTempDir(prefix = "taskpanel-sched-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, `#!/usr/bin/env bash\nexit 0\n`, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

function installEnv(home, bin) {
  return { ...process.env, TASKPANEL_TARGET_HOME: home, PATH: `${bin}:${process.env.PATH}` };
}

function runInstall(args, env = {}) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function isExecutable(path) {
  return (statSync(path).mode & 0o111) !== 0;
}

/** Every scheduling artefact the installer is expected to drop for a host. */
function scheduledPaths(home, hostDir, host) {
  const base = join(home, hostDir);
  return {
    pollPlist: join(base, "scheduling", "launchd", "com.taskpanel.poll.plist"),
    patrolPlist: join(base, "scheduling", "launchd", "com.taskpanel.patrol.plist"),
    pollService: join(base, "scheduling", "systemd", "taskpanel-poll.service"),
    pollTimer: join(base, "scheduling", "systemd", "taskpanel-poll.timer"),
    patrolService: join(base, "scheduling", "systemd", "taskpanel-patrol.service"),
    patrolTimer: join(base, "scheduling", "systemd", "taskpanel-patrol.timer"),
    cron: join(base, "scheduling", "cron", "taskpanel.cron"),
    wake: join(base, "bin", `wake-${host}.sh`),
  };
}

describe("install.sh: scheduling units", () => {
  it("--dry-run previews the destinations and writes nothing", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--dry-run"],
      { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /scheduling[\\/]launchd[\\/]com\.taskpanel\.poll\.plist/);
    assert.equal(existsSync(join(home, ".claude")), false, "dry run must not write");
  });

  it("installs launchd + systemd + cron + wake glue for claude", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const paths = scheduledPaths(home, ".claude", "claude");
    for (const [name, path] of Object.entries(paths)) {
      assert.ok(existsSync(path), `${name} missing at ${path}`);
    }

    const logPath = join(home, ".claude", "task-panel", "supervisor.log");
    const supervisorPath = join(ROOT, "scripts", "supervisor.mjs");

    // launchd — poll every 60s, patrol every 300s, both pointing at the supervisor.
    const pollPlist = readFileSync(paths.pollPlist, "utf8");
    assert.match(pollPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.ok(pollPlist.includes("--once"), "the poll unit runs a single tick");
    assert.ok(pollPlist.includes(supervisorPath), "the poll unit names the supervisor");
    assert.ok(pollPlist.includes(logPath), "the fixed log path must be rendered in");

    const patrolPlist = readFileSync(paths.patrolPlist, "utf8");
    assert.match(patrolPlist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    assert.ok(patrolPlist.includes("--patrol-only"), "the patrol unit runs the patrol pass only");

    // systemd — a oneshot service driven by a timer.
    assert.match(readFileSync(paths.pollTimer, "utf8"), /OnUnitActiveSec=60s/);
    assert.match(readFileSync(paths.patrolTimer, "utf8"), /OnUnitActiveSec=300s/);
    assert.match(readFileSync(paths.pollService, "utf8"), /Type=oneshot/);
    assert.ok(readFileSync(paths.patrolService, "utf8").includes("--patrol-only"));

    // cron — a 1-minute poll line and a 5-minute patrol line.
    const cron = readFileSync(paths.cron, "utf8");
    assert.match(cron, /^\* \* \* \* \*/m);
    assert.match(cron, /^\*\/5 \* \* \* \*/m);
    assert.ok(cron.includes(supervisorPath));

    // wake glue — headless claude with resume support.
    assert.ok(isExecutable(paths.wake), "wake glue must be executable");
    const wake = readFileSync(paths.wake, "utf8");
    assert.ok(wake.includes("claude -p"), "wake-claude must drive headless claude");
    assert.ok(wake.includes("--resume"), "wake-claude must support --resume <sid>");
    assert.ok(!wake.includes("{{"), "templates must be rendered");

    // The exact load command is printed, not run.
    assert.match(run.stdout + run.stderr, /launchctl|systemctl|crontab/);
  });

  it("installs codex wake glue driving `codex exec`", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(["--target", "codex", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const wake = scheduledPaths(home, ".codex", "codex").wake;
    assert.ok(existsSync(wake), "wake-codex.sh missing");
    assert.ok(readFileSync(wake, "utf8").includes("codex exec"));
  });

  it("installs pi wake glue and units", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "pi", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);

    const paths = scheduledPaths(home, ".agents", "pi");
    assert.ok(existsSync(paths.wake), "wake-pi.sh missing");
    assert.ok(existsSync(paths.pollPlist), "pi scheduling units missing");
    assert.ok(existsSync(join(home, ".agents", "task-panel.env")), "pi config missing");
  });

  it("--no-automation skips every codex automation artefact", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(
      ["--target", "codex", "--agent-name", "alice", "--no-automation"],
      installEnv(home, bin),
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".codex", "scheduling")), false);
    assert.equal(existsSync(join(home, ".codex", "task-panel-claim.sh")), false);
    // The skill, AGENTS.md and shim are unaffected.
    assert.ok(existsSync(join(home, ".codex", "skills", "task-panel", "SKILL.md")));
    assert.ok(existsSync(join(home, ".codex", "AGENTS.md")));
  });

  it("is idempotent: a re-run changes no scheduling file", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], env).status, 0);

    const paths = scheduledPaths(home, ".claude", "claude");
    const before = readFileSync(paths.pollPlist, "utf8");
    const again = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(paths.pollPlist, "utf8"), before);
  });
});
