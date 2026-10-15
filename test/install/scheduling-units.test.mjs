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
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-sched-") {
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
  return { ...process.env, MEERKAT_TASKPANEL_TARGET_HOME: home, PATH: `${bin}:${process.env.PATH}` };
}

// The taskd keepalive guard is skipped: it loads a real OS unit on install, and these
// cases are about the host's *loop* units (which are written, never loaded — the rule
// the guard is the one exception to). `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` is the
// contract's test-only bypass; the guard's own cases live in `taskd-guard.test.mjs`.
function runInstall(args, env = {}) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1", ...env },
  });
}

function isExecutable(path) {
  return (statSync(path).mode & 0o111) !== 0;
}

/** Every scheduling artefact the installer is expected to drop for a host. */
function scheduledPaths(home, hostDir, host) {
  const base = join(home, hostDir);
  return {
    pollPlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.poll.plist"),
    patrolPlist: join(base, "scheduling", "launchd", "com.meerkat-taskpanel.patrol.plist"),
    pollService: join(base, "scheduling", "systemd", "meerkat-taskpanel-poll.service"),
    pollTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-poll.timer"),
    patrolService: join(base, "scheduling", "systemd", "meerkat-taskpanel-patrol.service"),
    patrolTimer: join(base, "scheduling", "systemd", "meerkat-taskpanel-patrol.timer"),
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
 * Read from the loop skill's **generated** `body/manifest.txt` rather than restated here:
 * the manifest *is* the closure (computed from the body's imports by `scripts/sync-loop.mjs`
 * and guarded by `sync-skills --check`), so a member the installer copies but this test
 * does not know about — or the reverse — is impossible.
 */
const LOOP_SKILL = join(ROOT, "skills", "meerkat-loop");
const LOOP_BODY = readFileSync(join(LOOP_SKILL, "body", "manifest.txt"), "utf8")
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
    assert.match(run.stdout, /scheduling[\\/]launchd[\\/]com\.meerkat-taskpanel\.poll\.plist/);
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

    // launchd — poll every 60s, patrol every 300s, both pointing at the supervisor.
    const pollPlist = readFileSync(paths.pollPlist, "utf8");
    assert.match(pollPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.ok(pollPlist.includes("--once"), "the poll unit runs a single tick");
    assert.ok(pollPlist.includes(supervisorPath), "the poll unit names the host's supervisor copy");
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

    // No unit names the checkout. Before the host-local copy every unit carried the
    // absolute `<checkout>/scripts/supervisor.mjs`, which is exactly what made moving
    // the checkout fatal for a loaded unit — so this assertion is the red→green record
    // of the change rather than a restatement of the one above.
    for (const [name, path] of Object.entries(unitPaths(home, ".claude", "claude"))) {
      const body = readFileSync(path, "utf8");
      assert.ok(!body.includes(ROOT), `${name} must not name the checkout (${ROOT})`);
      assert.ok(!body.includes("{{"), `${name} must be fully rendered`);
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
      readFileSync(join(LOOP_SKILL, "body", "scripts", "supervisor.mjs"), "utf8"),
      "the copy must be the executor itself, not a stub",
    );

    // The module graph is closed under the copy. `supervisor.mjs` imports
    // `../src/shared/scheduling.mjs`, so the `scripts/` + `src/shared/` shape has to
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
        readFileSync(join(LOOP_SKILL, "body", rel), "utf8"),
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
    assert.equal(typeof installed.defaultRepo, "function", "the copy must expose the runner surface");

    // The board engine stays in the checkout, so the copied executor — which has no
    // `src/cli/index.mjs` beside it — reads the location the installer recorded in the
    // host config. `defaultRepo` with no second argument uses the copy's own directory,
    // so this is the question the installed unit actually asks at tick time.
    const configPath = join(home, ".claude", "meerkat-taskpanel.env");
    assert.ok(
      readFileSync(configPath, "utf8").includes(`MEERKAT_TASKPANEL_REPO=${ROOT}`),
      "the host config must record where the board engine lives",
    );
    assert.equal(installed.defaultRepo(configPath), ROOT);
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
      readFileSync(join(ROOT, "scripts", "supervisor.mjs"), "utf8"),
      "--force must refresh the loop body",
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
    assert.ok(existsSync(paths.pollPlist), "pi scheduling units missing");
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
    const before = readFileSync(paths.pollPlist, "utf8");
    const again = runInstall(["--target", "claude", "--agent-name", "alice"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(paths.pollPlist, "utf8"), before);
  });
});

// ---------------------------------------------------------------------------
// The loop skill: installed by the three hosts that can be woken, never by OpenClaw
//
// The loop is a skill of its own (T-20261012-163500-loopdecouple-b), distributed to
// claude / codex / pi. OpenClaw is excluded **permanently** (ruling O3): the
// openclaw-team framework already ships a per-agent poll and a `task-patrol` — the same
// design (cadence: the framework's own AUTOMATIONS.md, not a number restated here); two
// supervisors on one board would only race each other for the same cards.
// ---------------------------------------------------------------------------

/** Hosts the installer must place the loop skill in, and the dot-directory each uses. */
const LOOP_HOSTS = [
  ["claude", ".claude"],
  ["codex", ".codex"],
  ["pi", ".agents"],
];

describe("install.sh: the loop skill's distribution", () => {
  for (const [host, hostDir] of LOOP_HOSTS) {
    it(`installs the meerkat-loop skill for ${host}`, () => {
      const home = makeTempDir();
      const bin = makeTempDir();
      makeFakeCli(bin, host);
      const run = runInstall(["--target", host], installEnv(home, bin));
      assert.equal(run.status, 0, run.stderr);

      const dest = join(home, hostDir, "skills", "meerkat-loop");
      assert.ok(existsSync(join(dest, "SKILL.md")), `${host}: the loop skill's SKILL.md must land`);
      assert.ok(existsSync(join(dest, "body", "manifest.txt")), `${host}: the loop payload must land`);
      assert.ok(
        existsSync(join(dest, "templates", "scheduling", "cron", "meerkat-taskpanel.cron")),
        `${host}: the loop templates must land`,
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

  it("never installs the loop skill or a scheduling unit for opencode", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "opencode", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);

    // The board skill and the config that points the skill's wrapper at the checkout DO
    // land — this is an exclusion of the *loop*, not of OpenCode.
    assert.ok(
      existsSync(join(home, ".config/opencode", "skills", "meerkat-taskpanel", "SKILL.md")),
      "opencode must still get the board skill",
    );
    assert.ok(
      existsSync(join(home, ".config/opencode", "meerkat-taskpanel.env")),
      "opencode must get the host config (it is what resolves the CLI from a copied skill)",
    );

    // No loop payload, no units, no wake glue. OpenCode's skills come from the plugin and
    // its headless form is unverified, so no unattended daemon is wired to it — the same
    // shape as OpenClaw's exclusion, for a different and equally stated reason.
    assert.equal(existsSync(join(home, ".config/opencode", "skills", "meerkat-loop")), false);
    assert.equal(existsSync(join(home, ".config/opencode", "scheduling")), false);
    assert.equal(existsSync(join(home, ".config/opencode", "meerkat-taskpanel")), false);
    assert.equal(existsSync(join(home, ".config/opencode", "bin", "wake-opencode.sh")), false);
  });

  it("never installs the loop skill or a scheduling unit for cursor", () => {
    const home = makeTempDir();
    const run = runInstall(["--target", "cursor", "--prefix", home]);
    assert.equal(run.status, 0, run.stderr);

    assert.ok(
      existsSync(join(home, ".cursor", "skills", "meerkat-taskpanel", "SKILL.md")),
      "cursor must still get the board skill",
    );
    assert.ok(
      existsSync(join(home, ".cursor", "meerkat-taskpanel.env")),
      "cursor must get the host config (it is what resolves the CLI from a copied skill)",
    );

    assert.equal(existsSync(join(home, ".cursor", "skills", "meerkat-loop")), false);
    assert.equal(existsSync(join(home, ".cursor", "scheduling")), false);
    assert.equal(existsSync(join(home, ".cursor", "meerkat-taskpanel")), false);
    assert.equal(existsSync(join(home, ".cursor", "bin", "wake-cursor.sh")), false);
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
    assert.ok(existsSync(join(loop, "body", "scripts", "supervisor.mjs")));
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
