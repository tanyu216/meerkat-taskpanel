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
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// cases are about the host's *loop* units (which are written, never loaded — the rule
// the guard is the one exception to). `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` is the
// contract's test-only bypass; the guard's own cases live in `taskd-guard.test.mjs`.

function isExecutable(path) {
  return (statSync(path).mode & 0o111) !== 0;
}

/** Every scheduling artefact the installer is expected to drop for a host. */
function scheduledPaths(home, hostDir, host) {
  const base = join(home, hostDir);
  return {
    pingPlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.ping.plist"),
    continuePlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.continue.plist"),
    subscribePlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.subscribe.plist"),
    pingService: join(base, "scheduling", "systemd", "meerkat-taskpanel-ping.service"),
    pingTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-ping.timer"),
    continueService: join(base, "scheduling", "systemd", "meerkat-taskpanel-continue.service"),
    continueTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-continue.timer"),
    subscribeService: join(base, "scheduling", "systemd", "meerkat-taskpanel-subscribe.service"),
    cron: join(base, "scheduling", "cron", "meerkat-taskpanel.cron"),
    wake: join(base, "bin", `wake-${host}.sh`),
  };
}

/**
 * The scheduling *units* proper — the files a user loads into launchd / systemd /
 * crontab. The wake glue is deliberately excluded: the supervisor runs it, not the
 * scheduler, and it is not part of "the unit names no checkout path".
 */
function unitPaths(home, hostDir, host) {
  const all = scheduledPaths(home, hostDir, host);
  delete all.wake;
  return all;
}

/**
 * The loop execution body `install.sh` copies into the host, as repo-relative paths.
 *
 * Read from the loop skill's **generated** `manifest.txt` rather than restated here:
 * the manifest *is* the closure (computed from the body's imports by `scripts/sync-loop.mjs`
 * and guarded by `sync-skills --check`), so a member the installer copies but this test
 * does not know about — or the reverse — is impossible.
 */
const LOOP_SKILL = join(ROOT, "skills", "meerkat-loop");
const LOOP_BODY = readFileSync(join(LOOP_SKILL, "manifest.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

/** Every relative module specifier a source text imports, `import` or `export … from`. */
function relativeImports(text) {
  const out = [];
  for (const re of [/from\s+["'](\.[^"']+)["']/g, /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g]) {
    for (const match of text.matchAll(re)) out.push(match[1]);
  }
  return out;
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

    const loopDir = join(home, ".claude", "meerkat-taskpanel");
    const logPath = join(loopDir, "supervisor.log");
    // The executor a unit names is the **host's** copy, never the checkout's own file:
    // a unit the user has already loaded has to keep working after the checkout is
    // moved, renamed or removed (T-20261012-163500-loopdecouple-c).
    const supervisorPath = join(loopDir, "scripts", "supervisor.mjs");

    // launchd — ping every 60s, continue every 600s, both pointing at the supervisor.
    const pingPlist = readFileSync(paths.pingPlist, "utf8");
    assert.match(pingPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.ok(pingPlist.includes("--ping-only"), "the ping unit runs the liveness pass only");
    assert.ok(pingPlist.includes("--once"), "the ping unit runs a single pass");
    assert.ok(pingPlist.includes(supervisorPath), "the ping unit names the host's supervisor copy");
    assert.ok(pingPlist.includes(logPath), "the fixed log path must be rendered in");

    const continuePlist = readFileSync(paths.continuePlist, "utf8");
    assert.match(continuePlist, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
    assert.ok(continuePlist.includes("--continue-only"), "the continue unit runs the judgment turn only");

    // The event daemon: a long-lived unit, not an interval one.
    const subscribePlist = readFileSync(paths.subscribePlist, "utf8");
    assert.ok(subscribePlist.includes("--subscribe"), "the subscriber runs the daemon mode");
    assert.match(subscribePlist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.doesNotMatch(subscribePlist, /<key>StartInterval<\/key>/, "a daemon has no interval");

    // systemd — oneshot services driven by timers, plus the subscriber service.
    assert.match(readFileSync(paths.pingTimer, "utf8"), /OnUnitActiveSec=60s/);
    assert.match(readFileSync(paths.continueTimer, "utf8"), /OnUnitActiveSec=600s/);
    assert.match(readFileSync(paths.pingService, "utf8"), /Type=oneshot/);
    assert.ok(readFileSync(paths.continueService, "utf8").includes("--continue-only"));
    const subscribeService = readFileSync(paths.subscribeService, "utf8");
    assert.ok(subscribeService.includes("--subscribe"));
    assert.match(subscribeService, /Type=simple/);
    assert.match(subscribeService, /Restart=always/);

    // cron — a 1-minute ping line and a 10-minute continue line.
    const cron = readFileSync(paths.cron, "utf8");
    assert.match(cron, /^\* \* \* \* \* .*--ping-only --once/m);
    assert.match(cron, /^\*\/10 \* \* \* \* .*--continue-only --once/m);
    assert.ok(cron.includes(supervisorPath));
    assert.ok(!cron.includes("--patrol-only"));
    assert.doesNotMatch(
      cron,
      /supervisor\.mjs --host claude --agent alice --once --log/,
      "the bare legacy poll line must be gone",
    );

    // No unit names the checkout. Before the host-local copy every unit carried the
    // absolute `<checkout>/scripts/supervisor.mjs`, which is exactly what made moving
    // the checkout fatal for a loaded unit — so this assertion is the red→green record
    // of the change rather than a restatement of the one above.
    for (const [name, path] of Object.entries(unitPaths(home, ".claude", "claude"))) {
      const body = readFileSync(path, "utf8");
      assert.ok(!body.includes(ROOT), `${name} must not name the checkout (${ROOT})`);
      assert.ok(!body.includes("{{"), `${name} must be fully rendered`);
    }

    // The old topology is gone from a fresh install.
    for (const legacy of [
      join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.poll.plist"),
      join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.patrol.plist"),
      join(home, ".claude", "scheduling", "systemd", "meerkat-taskpanel-poll.timer"),
      join(home, ".claude", "scheduling", "systemd", "meerkat-taskpanel-patrol.timer"),
    ]) {
      assert.equal(existsSync(legacy), false, `legacy unit must not be written: ${legacy}`);
    }

    // wake glue — headless claude with resume support.
    assert.ok(isExecutable(paths.wake), "wake glue must be executable");
    const wake = readFileSync(paths.wake, "utf8");
    assert.ok(wake.includes("claude -p"), "wake-claude must drive headless claude");
    assert.ok(wake.includes("--resume"), "wake-claude must support --resume <sid>");
    assert.ok(!wake.includes("{{"), "templates must be rendered");

    // The exact load command is printed, not run.
    assert.match(run.stdout + run.stderr, /launchctl|systemctl|crontab/);
  });

  it("copies the loop body into the host, so a loaded unit outlives the checkout", async () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const loopDir = join(home, ".claude", "meerkat-taskpanel");
    const copy = join(loopDir, "scripts", "supervisor.mjs");

    // The path the unit names is inside the host and outside the checkout, and the
    // file is really there: deleting the checkout cannot take this path away.
    assert.ok(existsSync(copy), `the unit names ${copy}, which must exist`);
    assert.ok(!copy.startsWith(ROOT + sep), "the copied executor must not live in the checkout");
    assert.equal(
      readFileSync(copy, "utf8"),
      readFileSync(join(LOOP_SKILL, "scripts", "supervisor.mjs"), "utf8"),
      "the copy must be the executor itself, not a stub",
    );

    // The module graph is closed under the copy. `supervisor.mjs` imports
    // `../foundation/scheduling.mjs`, so the `scripts/` + `scripts/foundation/` shape has to
    // travel with it — one file alone would leave a dangling relative import and the
    // unit would die at load. Every relative import inside the copy resolves inside
    // the copy, so loading the body needs nothing from the checkout.
    for (const rel of LOOP_BODY) {
      assert.ok(existsSync(join(loopDir, rel)), `loop body member missing: ${rel}`);
    }
    for (const rel of LOOP_BODY) {
      for (const spec of relativeImports(readFileSync(join(loopDir, rel), "utf8"))) {
        const target = resolve(dirname(join(loopDir, rel)), spec);
        assert.ok(existsSync(target), `${rel} imports ${spec}, absent from the copy (${target})`);
      }
    }

    // The body the installer copies is the loop skill's payload, byte for byte — the
    // units run what the loop skill distributes, not a second reading of scripts/.
    for (const rel of LOOP_BODY) {
      assert.equal(
        readFileSync(join(loopDir, rel), "utf8"),
        readFileSync(join(LOOP_SKILL, rel), "utf8"),
        `${rel} must be the loop skill's copy`,
      );
    }

    // And the wake glue resolves the card's directory through the **host-local**
    // resolver, not through the checkout it was installed from: `{{LOOP}}/scripts/
    // wake-cwd.mjs`, never `{{REPO}}/scripts/wake-cwd.mjs`. Both files exist because the
    // body carries them; this asserts the glue names the one that survives a move.
    const wake = readFileSync(join(home, ".claude", "bin", "wake-claude.sh"), "utf8");
    assert.ok(
      wake.includes(join(loopDir, "scripts", "wake-cwd.mjs")),
      "the wake glue must resolve through the host-local wake-cwd.mjs",
    );

    // And it loads: importing the *host copy* resolves that whole graph for real, from
    // the copy's own location — the assertion the relative-import walk above can only
    // approximate. It also proves the executor the unit names is a working module, not
    // a file that merely exists.
    const installed = await import(pathToFileURL(copy).href);
    assert.equal(typeof installed.main, "function", "the copy must expose the executor");
    const installedOptions = await import(pathToFileURL(join(loopDir, "scripts", "loop", "options.mjs")).href);
    assert.equal(typeof installedOptions.defaultRepo, "function", "the copy must expose its option surface");

    // The board engine stays in the checkout, so the copied executor — which has no
    // `src/cli/index.mjs` beside it — reads the location the installer recorded in the
    // host config. `defaultRepo` with no second argument uses the copy's own directory,
    // so this is the question the installed unit actually asks at tick time.
    const configPath = join(home, ".claude", "meerkat-taskpanel.env");
    assert.ok(
      readFileSync(configPath, "utf8").includes(`MEERKAT_TASKPANEL_REPO=${ROOT}`),
      "the host config must record where the board engine lives",
    );
    assert.equal(installedOptions.defaultRepo(configPath), ROOT);
  });

  it("leaves a hand-edited loop body alone unless --force, and refreshes it with it", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const env = installEnv(home, bin);
    assert.equal(runInstall(["--target", "claude", "--agent-name", "alice"], env).status, 0);

    const copy = join(home, ".claude", "meerkat-taskpanel", "scripts", "supervisor.mjs");
    writeFileSync(copy, "// locally patched\n", "utf8");

    // merge-never-clobber: the differing copy is kept, and the run still succeeds.
    const again = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(copy, "utf8"), "// locally patched\n", "a re-run must not clobber it");

    // --force is the documented escape hatch, and it restores the executor.
    const forced = runInstall(["--target", "claude", "--agent-name", "alice", "--force"], env);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(
      readFileSync(copy, "utf8"),
      readFileSync(join(LOOP_SKILL, "scripts", "supervisor.mjs"), "utf8"),
      "--force must refresh the loop body from the skill's payload",
    );
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
    assert.ok(existsSync(paths.pingPlist), "pi scheduling units missing");
    assert.ok(existsSync(join(home, ".agents", "meerkat-taskpanel.env")), "pi config missing");
  });

  it("refuses to wake when the resolver succeeds with an empty directory", () => {
    // `wake-cwd.mjs`'s contract is "exit 0 means resolved, and the directory is the ONLY
    // thing on stdout" — so an empty `$cwd` with exit 0 is an illegal state that the
    // `if ! cwd=$(…)` guard cannot see, because `cd ""` succeeds in bash and would run the
    // worker in the caller's directory: the exact wrong checkout this glue exists to
    // refuse. A `TP_NODE` that prints nothing and exits 0 stands in for any resolver that
    // succeeds emptily, whatever the reason.
    const home = makeTempDir();
    const bin = makeTempDir();
    const log = join(makeTempDir(), "host-cli.log");
    const cli = join(bin, "claude");
    writeFileSync(cli, `#!/usr/bin/env bash\necho "invoked $*" >> "${log}"\nexit 0\n`, "utf8");
    chmodSync(cli, 0o755);
    const emptyResolver = join(bin, "empty-resolver.sh");
    writeFileSync(emptyResolver, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    chmodSync(emptyResolver, 0o755);

    const install = runInstall(["--target", "claude"], installEnv(home, bin));
    assert.equal(install.status, 0, install.stderr);

    const wake = join(home, ".claude", "bin", "wake-claude.sh");
    // Fixture precondition: the glue under test must be the one that calls the resolver.
    assert.ok(readFileSync(wake, "utf8").includes("wake-cwd.mjs"), "the glue must call wake-cwd.mjs");

    const run = spawnSync("bash", [wake, "do T-1"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TP_PROJECT: "TaskPanel", TP_NODE: emptyResolver },
    });

    assert.equal(
      run.status,
      3,
      `want exit 3 (a refused wake), got ${run.status}; stderr=${JSON.stringify(run.stderr)}`,
    );
    assert.match(run.stderr, /refusing to wake/);
    assert.equal(
      existsSync(log),
      false,
      `the host CLI must not have been invoked at all: ${existsSync(log) ? readFileSync(log, "utf8") : ""}`,
    );
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
    // `MEERKAT_TASKPANEL_NO_AUTOMATION=1` is documented as the other spelling of
    // `--no-automation` (docs/install.md). It travels through install.sh, so the
    // dispatcher must not overwrite the caller's value with its own empty one —
    // the failure that would make the documented form skip nothing.
    for (const env of [{ MEERKAT_TASKPANEL_NO_AUTOMATION: "1" }, { TASKPANEL_NO_AUTOMATION: "1" }]) {
      const home = makeTempDir();
      const bin = makeTempDir();
      makeFakeCli(bin, "codex");
      const run = runInstall(
        ["--target", "codex", "--agent-name", "alice"],
        { ...installEnv(home, bin), ...env },
      );
      const which = Object.keys(env)[0];

      assert.equal(run.status, 0, run.stderr);
      assert.equal(existsSync(join(home, ".codex", "scheduling")), false, `${which}: no scheduling units`);
      assert.equal(existsSync(join(home, ".codex", "meerkat-taskpanel-claim.sh")), false, `${which}: no claim trigger`);
      assert.ok(existsSync(join(home, ".codex", "skills", "meerkat-taskpanel", "SKILL.md")), `${which}: the skill is unaffected`);
    }
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
// The loop skill: installed by the three hosts that can be woken, never by OpenClaw
//
// The loop is a skill of its own (T-20261012-163500-loopdecouple-b), distributed to the
// five non-OpenClaw hosts. OpenClaw is excluded **permanently** (ruling O3): the
// openclaw-team framework already ships a per-agent poll and a `task-patrol` — the same
// design (cadence: the framework's own AUTOMATIONS.md, not a number restated here); two
// supervisors on one board would only race each other for the same cards.
// ---------------------------------------------------------------------------

/** Hosts the installer must place the loop skill in, the dot-directory, and the CLI name. */
const LOOP_HOSTS = [
  ["claude", ".claude", "claude"],
  ["codex", ".codex", "codex"],
  ["pi", ".agents", "pi"],
  ["opencode", ".config/opencode", "opencode"],
  ["cursor", ".cursor", "cursor-agent"],
];

describe("install.sh: the loop skill's distribution", () => {
  for (const [host, hostDir, cli] of LOOP_HOSTS) {
    it(`installs the meerkat-loop skill for ${host}`, () => {
      const home = makeTempDir();
      const bin = makeTempDir();
      makeFakeCli(bin, cli);
      const run = runInstall(["--target", host], installEnv(home, bin));
      assert.equal(run.status, 0, run.stderr);

      const dest = join(home, hostDir, "skills", "meerkat-loop");
      assert.ok(existsSync(join(dest, "SKILL.md")), `${host}: the loop skill's SKILL.md must land`);
      assert.ok(existsSync(join(dest, "manifest.txt")), `${host}: the loop payload must land`);
      assert.equal(
        existsSync(join(dest, "body")),
        false,
        `${host}: a fresh install must not carry the retired body/ wrapper`,
      );
      assert.equal(
        existsSync(join(dest, "src")),
        false,
        `${host}: the loop skill must not carry a src/ tree`,
      );
      assert.ok(
        existsSync(join(dest, "scripts", "foundation", "constants.mjs")),
        `${host}: foundation must land under scripts/foundation/`,
      );
      assert.ok(
        existsSync(join(dest, "templates", "scheduling", "cron", "meerkat-taskpanel.cron")),
        `${host}: the loop templates must land`,
      );

      const wake = join(home, hostDir, "bin", `wake-${host}.sh`);
      assert.ok(existsSync(wake), `${host}: the wake glue must land`);
      assert.ok(isExecutable(wake), `${host}: the wake glue must be executable`);
      assert.ok(
        readFileSync(wake, "utf8").includes("wake-cwd.mjs"),
        `${host}: the glue must resolve the card's project directory`,
      );
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
    assert.equal(existsSync(join(home, ".openclaw", "scheduling")), false);
    assert.equal(existsSync(join(home, ".openclaw", "meerkat-taskpanel")), false);
  });

  it("wires OpenCode's glue to `opencode run`, with the session form for a resume", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "opencode");
    const run = runInstall(["--target", "opencode"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const glue = readFileSync(join(home, ".config/opencode", "bin", "wake-opencode.sh"), "utf8");
    assert.match(glue, /exec opencode run "\$prompt"/);
    assert.match(glue, /exec opencode run --session "\$sid" "\$prompt"/);
  });

  it("wires Cursor's glue to `cursor-agent -p`, and labels the resume form unverified", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "cursor-agent");
    const run = runInstall(["--target", "cursor"], installEnv(home, bin));
    assert.equal(run.status, 0, run.stderr);

    const glue = readFileSync(join(home, ".cursor", "bin", "wake-cursor.sh"), "utf8");
    assert.match(glue, /exec cursor-agent -p "\$prompt"/);
    assert.match(glue, /exec cursor-agent -p --resume "\$sid" "\$prompt"/);
    assert.match(glue, /NOT verified/, "the unverified resume form must say so");
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

    // The loop must be a real directory. A symlinked body would put the checkout back
    // into the load path of the very thing the split exists to make independent of it.
    assert.ok(lstatSync(loop).isDirectory(), "--link must NOT symlink the loop skill");
    assert.equal(lstatSync(loop).isSymbolicLink(), false);
    assert.ok(existsSync(join(loop, "scripts", "supervisor.mjs")));
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
