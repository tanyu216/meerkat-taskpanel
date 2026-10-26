/**
 * Scheduling units the installer drops (T-20261010-013000).
 *
 * The loop is external to the board, so each bundle agent kind gets a scheduling unit
 * (launchd / systemd / cron), all merge-style and idempotent under an isolated
 * `--prefix` home. The units are *installed*, but a unit only starts when the user
 * loads it, so the installer prints the exact load command instead of running
 * `launchctl` / `systemctl` / `crontab`.
 *
 * The unit names `taskctl loop …` — the loop ships with the toolkit. What used to be
 * an agent-local copy of the execution body is gone (and a re-run removes one left by
 * an older install).
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-sched-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, `#!/usr/bin/env bash\nexit 0\n`, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

function installEnv(home, bin) {
  return { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: home, PATH: `${bin}:${process.env.PATH}` };
}

// The taskd keepalive guard is skipped: it loads a real OS unit on install, and these
// cases are about the agent kind's *loop* units (which are written, never loaded — the rule
// the guard is the one exception to). `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` is the
// contract's test-only bypass; the guard's own cases live in `taskd-guard.test.mjs`.

/** Every scheduling artefact the installer is expected to drop for an agent kind. */
function scheduledPaths(home, agentDir, kind) {
  const base = join(home, agentDir);
  return {
    pingPlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.ping.plist"),
    continuePlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.continue.plist"),
    subscribePlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.subscribe.plist"),
    sessionPlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.session.plist"),
    pingService: join(base, "scheduling", "systemd", "meerkat-taskpanel-ping.service"),
    pingTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-ping.timer"),
    continueService: join(base, "scheduling", "systemd", "meerkat-taskpanel-continue.service"),
    continueTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-continue.timer"),
    subscribeService: join(base, "scheduling", "systemd", "meerkat-taskpanel-subscribe.service"),
    sessionService: join(base, "scheduling", "systemd", "meerkat-taskpanel-session.service"),
    cron: join(base, "scheduling", "cron", "meerkat-taskpanel.cron"),
  };
}

/** The scheduling *units* proper — the files a user loads into launchd / systemd / crontab. */
function unitPaths(home, agentDir, kind) {
  return scheduledPaths(home, agentDir, kind);
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
    assert.match(run.stdout, /scheduling[\\/]launchd[\\/]com\.meerkat-taskpanel\.ping\.plist/);
    assert.equal(existsSync(join(home, ".claude")), false, "dry run must not write");
  });

  it("installs launchd + systemd + cron for claude", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const paths = scheduledPaths(home, ".claude", "claude");
    for (const [name, path] of Object.entries(paths)) {
      assert.ok(existsSync(path), `${name} missing at ${path}`);
    }

    const loopDir = join(home, ".claude", "meerkat-taskpanel");
    const logPath = join(loopDir, "supervisor.log");
    // An agent-only install has no materialized runtime tree, so the unit names the
    // checkout's CLI entry. A combined install (`--target all`, npm/npx) points
    // `MEERKAT_TASKPANEL_REPO` at `~/.meerkat-taskpanel` instead — same template.
    const cliPath = join(ROOT, "src", "cli", "index.mjs");

    // launchd — ping every 60s, continue every 600s, both pointing at `taskctl loop`.
    const pingPlist = readFileSync(paths.pingPlist, "utf8");
    assert.match(pingPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.ok(pingPlist.includes(cliPath), "the ping unit names the CLI entry");
    assert.ok(pingPlist.includes("<string>loop</string>"), "the ping unit runs a loop verb");
    assert.ok(pingPlist.includes("--ping-once"), "the ping unit runs the liveness pass only");
    assert.ok(!pingPlist.includes("--once"), "the retired --once is gone");
    assert.ok(pingPlist.includes(logPath), "the fixed log path must be rendered in");
    assert.ok(pingPlist.includes("--state-dir"), "the state directory is the documented spelling");

    const continuePlist = readFileSync(paths.continuePlist, "utf8");
    assert.match(continuePlist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
    assert.ok(continuePlist.includes("--continue-once"), "the continue unit runs the judgment turn only");

    // The event daemon: a long-lived unit, not an interval one.
    const subscribePlist = readFileSync(paths.subscribePlist, "utf8");
    assert.ok(subscribePlist.includes("<string>subscribe</string>"), "the subscriber runs the daemon verb");
    assert.match(subscribePlist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.doesNotMatch(subscribePlist, /<key>StartInterval<\/key>/, "a daemon has no interval");

    // The resident session pool: another daemon, and the loop's dispatcher.
    const sessionPlist = readFileSync(paths.sessionPlist, "utf8");
    assert.ok(sessionPlist.includes("<string>session</string>"), "the pool runs the session verb");
    assert.ok(sessionPlist.includes(cliPath), "the pool names the CLI entry");
    assert.match(sessionPlist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.doesNotMatch(sessionPlist, /<key>StartInterval<\/key>/, "a daemon has no interval");
    assert.doesNotMatch(sessionPlist, /--allow-all-tools/, "full tool access is opt-in through the config");

    // systemd — oneshot services driven by timers, plus the subscriber service.
    assert.match(readFileSync(paths.pingTimer, "utf8"), /OnUnitActiveSec=60s/);
    assert.match(readFileSync(paths.continueTimer, "utf8"), /OnUnitActiveSec=600s/);
    assert.match(readFileSync(paths.pingService, "utf8"), /Type=oneshot/);
    assert.match(readFileSync(paths.pingService, "utf8"), /loop run --ping-once/);
    assert.match(readFileSync(paths.continueService, "utf8"), /loop run --continue-once/);
    const subscribeService = readFileSync(paths.subscribeService, "utf8");
    assert.match(subscribeService, /loop subscribe/);
    assert.match(subscribeService, /Type=simple/);
    assert.match(subscribeService, /Restart=always/);
    const sessionService = readFileSync(paths.sessionService, "utf8");
    assert.match(sessionService, /loop session/);
    assert.match(sessionService, /Type=simple/);
    assert.match(sessionService, /Restart=always/);
    assert.doesNotMatch(sessionService, /--allow-all-tools/);

    // cron — a 1-minute ping line and a 10-minute continue line.
    const cron = readFileSync(paths.cron, "utf8");
    assert.match(cron, /^\* \* \* \* \* .*loop run --ping-once/m);
    assert.match(cron, /^\*\/10 \* \* \* \* .*loop run --continue-once/m);
    assert.ok(cron.includes(cliPath));
    assert.ok(!cron.includes("--patrol-only"));
    assert.doesNotMatch(cron, /supervisor\.mjs/, "the retired executor must not be named");

    for (const [name, path] of Object.entries(unitPaths(home, ".claude", "claude"))) {
      const body = readFileSync(path, "utf8");
      assert.ok(!body.includes("{{"), `${name} must be fully rendered`);
      assert.ok(!body.includes("supervisor.mjs"), `${name} must not name the retired executor`);
    }

    // The loop's state directory exists even though no body is copied into it.
    assert.ok(existsSync(loopDir), "the state directory must exist after install");

    // The old topology is gone from a fresh install.
    for (const legacy of [
      join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.poll.plist"),
      join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.patrol.plist"),
      join(home, ".claude", "scheduling", "systemd", "meerkat-taskpanel-poll.timer"),
      join(home, ".claude", "scheduling", "systemd", "meerkat-taskpanel-patrol.timer"),
    ]) {
      assert.equal(existsSync(legacy), false, `legacy unit must not be written: ${legacy}`);
    }

    // The exact load command is printed, not run.
    assert.match(run.stdout + run.stderr, /launchctl|systemctl|crontab/);
  });

  it("installs codex units", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(["--target", "codex", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const paths = scheduledPaths(home, ".codex", "codex");
    assert.ok(existsSync(paths.pingPlist), "codex scheduling units missing");
  });

  it("installs pi units", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "pi", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);

    const paths = scheduledPaths(home, ".agents", "pi");
    assert.ok(existsSync(paths.pingPlist), "pi scheduling units missing");
    assert.ok(existsSync(join(home, ".agents", "meerkat-taskpanel.env")), "pi config missing");
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
    assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false);
    // The skill, AGENTS.md and shim are unaffected.
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat-taskpanel", "SKILL.md")));
    assert.ok(existsSync(join(home, ".codex", "AGENTS.md")));
  });

  it("the bypass's environment form skips exactly the same artefacts through the dispatcher", () => {
    // `MEERKAT_TASKPANEL_NO_AUTOMATION=1` is the environment spelling of
    // `--no-automation` (docs/install.md). It travels through install.sh, so the
    // dispatcher must not overwrite the caller's value with its own empty one —
    // the failure that would make the documented form skip nothing.
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "codex");
    const run = runInstall(
      ["--target", "codex", "--agent-name", "alice"],
      { ...installEnv(home, bin), MEERKAT_TASKPANEL_NO_AUTOMATION: "1" },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, ".codex", "scheduling")), false, "no scheduling units");
    assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false, "no claim trigger");
    assert.ok(existsSync(join(home, ".codex", "skills", "meerkat-taskpanel", "SKILL.md")), "the skill is unaffected");
  });

  it("is idempotent: a re-run changes no scheduling file", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], env).status, 0);

    const paths = scheduledPaths(home, ".claude", "claude");
    const before = readFileSync(paths.pingPlist, "utf8");
    const again = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(paths.pingPlist, "utf8"), before);
  });
});

// ---------------------------------------------------------------------------
// The loop skill: installed by the three agent kinds that can be woken, never by OpenClaw
//
// The loop is a skill of its own (T-20261012-163500-loopdecouple-b), distributed to the
// three non-OpenClaw agent kinds. OpenClaw is excluded **permanently** (ruling O3): the
// openclaw-team framework already ships a per-agent poll and a `task-patrol` — the same
// design (cadence: the framework's own AUTOMATIONS.md, not a number restated here); two
// supervisors on one board would only race each other for the same cards.
//
// The skill carries decisions, not an execution body: `taskctl loop …` is the body.
// ---------------------------------------------------------------------------

/** Agent kinds the installer must place the loop skill in, the dot-directory, and the CLI name. */
const LOOP_KINDS = [
  ["claude", ".claude", "claude"],
  ["codex", ".codex", "codex"],
  ["pi", ".agents", "pi"],
];

describe("install.sh: the loop skill's distribution", () => {
  for (const [kind, agentDir, cli] of LOOP_KINDS) {
    it(`installs the meerkat-loop skill for ${kind}`, () => {
      const home = makeTempDir();
      const bin = makeTempDir();
      makeFakeCli(bin, cli);
      const run = runInstall(["--target", kind], installEnv(home, bin));
      assert.equal(run.status, 0, run.stderr);

      const dest = join(home, agentDir, "skills", "meerkat-loop");
      assert.ok(existsSync(join(dest, "SKILL.md")), `${kind}: the loop skill's SKILL.md must land`);
      assert.ok(existsSync(join(dest, "references", "operation.md")), `${kind}: its references must land`);

      // The body moved into the toolkit; neither the skill nor the agent directory
      // carries a second implementation.
      for (const retired of ["manifest.txt", "scripts", "templates", "src", "body"]) {
        assert.equal(
          existsSync(join(dest, retired)),
          false,
          `${kind}: the loop skill must not carry ${retired}`,
        );
      }
      assert.equal(
        existsSync(join(home, agentDir, "meerkat-taskpanel", "scripts")),
        false,
        `${kind}: no execution body may be copied into the agent directory`,
      );
      assert.ok(
        existsSync(join(home, agentDir, "bin", "taskctl")),
        `${kind}: the taskctl shim must land`,
      );

      // The setup command ships with the Claude bundle only; the repository bundle
      // and marketplace still carry it for the other kinds, but this installer does not.
      const setup = join(home, agentDir, "skills", "setup-meerkat");
      assert.equal(
        existsSync(setup),
        kind === "claude",
        `${kind}: setup-meerkat is copied for Claude only`,
      );
      if (kind === "claude") {
        assert.ok(existsSync(join(setup, "scripts", "detect.mjs")), "claude: the setup scripts must land");
        assert.ok(existsSync(join(setup, "assets", "team", "standard", "manifest.json")), "claude: the team template must land");
      }
    });
  }

  it("never installs the meerkat-loop skill for openclaw", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "openclaw", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);

    // The board skill does land — this is an exclusion of the *loop*, not of OpenClaw.
    assert.ok(
      existsSync(join(home, ".openclaw", "skills", "meerkat-taskpanel", "SKILL.md")),
      "openclaw must still get the board skill",
    );
    assert.equal(
      existsSync(join(home, ".openclaw", "skills", "meerkat-loop")),
      false,
      "openclaw must not receive the loop skill (O3: the framework is its supervisor)",
    );
    assert.equal(
      existsSync(join(home, ".openclaw", "skills", "setup-meerkat")),
      false,
      "setup-meerkat is Claude-only",
    );
    assert.equal(existsSync(join(home, ".openclaw", "scheduling")), false);
    assert.equal(existsSync(join(home, ".openclaw", "meerkat-taskpanel")), false);
  });

  it("copies the loop skill even under --link, which names the board skill only", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--link"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const board = join(home, ".claude", "skills", "meerkat-taskpanel");
    const loop = join(home, ".claude", "skills", "meerkat-loop");

    // The board skill is the one --link names: a symlink, because the docs recommend it
    // for a checkout (the wrapper resolves the CLI relative to itself).
    assert.ok(lstatSync(board).isSymbolicLink(), "--link must symlink the board skill");

    // The loop must be a real directory. A symlinked skill would put the checkout back
    // into the load path of the very thing the split exists to make independent of it.
    assert.ok(lstatSync(loop).isDirectory(), "--link must NOT symlink the loop skill");
    assert.equal(lstatSync(loop).isSymbolicLink(), false);
    assert.ok(existsSync(join(loop, "SKILL.md")));
  });

  it("--dry-run announces the loop skill and writes nothing", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--dry-run"],
      { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      run.stdout.includes(join(home, ".claude", "skills", "meerkat-loop")),
      "the dry run must preview the loop skill's destination",
    );
    assert.equal(existsSync(join(home, ".claude")), false, "a dry run must not write");
  });
});
