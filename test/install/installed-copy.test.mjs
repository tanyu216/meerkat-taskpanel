/**
 * The board skill, deployed **on its own** — the mode `install.sh` actually ships.
 *
 * The skill is distributed as a *copy*: `install_skill` runs `cp -R skills/<skill> <dest>`,
 * which lands `SKILL.md`, `references/` and `scripts/` in a host's skill directory and
 * nothing else. In particular the taskpanel checkout is **not** beside it, so anything the
 * skill tells a user to run has to work without one.
 *
 * That is the mode this suite covers, and the mode nothing covered before it: the
 * container's profile check (`scripts/verify/profiles.mjs`) installs with
 * `MEERKAT_TASKPANEL_LINK=1`, i.e. a *symlink*, which puts the checkout back next to the
 * wrapper and hides exactly the defect this file exists for. A copied install used to die
 * inside Node with `Cannot find module '<home>/<host>/src/cli/index.mjs'`
 * (T-20261014-214002) — a path the user never had, reported as a crash rather than as a
 * condition of the deployment.
 *
 * Per host (claude / codex / openclaw / pi — the four the board goes to), against a real
 * copy-mode install into a throwaway prefix, this asserts the wrapper:
 *
 *   1. with no CLI reachable refuses **controllably** — non-zero, an actionable remedy on
 *      stderr, and no module-not-found stack;
 *   2. uses a `taskctl` on `PATH`, and propagates its exit code;
 *   3. runs the CLI of a checkout named by `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`.
 *
 * Plus the properties shared by all four: the checkout rung is unchanged (which is what a
 * stale or misspelt root must fall through *to*), and an explicit root outranks `PATH`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe, it } from "node:test";

import { VERSION } from "../../src/shared/constants.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = process.execPath;
/** The skill under test, and the wrapper inside it. */
const SKILL = "meerkat-taskpanel";
const WRAPPER = join("scripts", "run.mjs");

/**
 * The four hosts the board skill is distributed to, and the dot-directory each one's skill
 * lands in. These are `docker/profiles/<host>.yml`'s `target_dir`s — the same destinations
 * `scripts/verify/profiles.mjs` asserts — restated here because this file drives the
 * installs itself.
 */
const HOSTS = Object.freeze([
  { host: "claude", dir: ".claude" },
  { host: "codex", dir: ".codex" },
  { host: "openclaw", dir: ".openclaw" },
  { host: "pi", dir: ".agents" },
]);

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-installed-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The throwaway `$HOME` the four hosts are installed into, and the `bin` holding the fake CLI. */
let home;
let fakeBin;

before(() => {
  home = makeTempDir();
  fakeBin = join(makeTempDir(), "bin");
  mkdirSync(fakeBin, { recursive: true });

  // The real installer, in the real default mode: no MEERKAT_TASKPANEL_LINK, so every
  // skill lands as a copy. `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` is the contract's
  // test-only bypass for the taskd keepalive guard (see test/install/install.test.mjs).
  const install = spawnSync("bash", [join(ROOT, "install.sh"), "--target", "all", "--prefix", home], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1" },
  });
  assert.equal(install.status, 0, install.stderr);

  // A `taskctl` that records its argv and exits with whatever `FAKE_TASKCTL_EXIT` says —
  // shell builtins only, so it runs on a `PATH` that holds nothing else.
  const fake = join(fakeBin, "taskctl");
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf \'FAKE_TASKCTL argv=%s\\n\' "$*"\nexit "${FAKE_TASKCTL_EXIT:-0}"\n',
    "utf8",
  );
  chmodSync(fake, 0o755);
});

/** The installed skill directory for one host's dot-directory. */
function installedDir(dir) {
  return join(home, dir, "skills", SKILL);
}

/** Run an installed wrapper with a controlled environment. */
function runWrapper(dir, args, env) {
  return spawnSync(NODE, [join(installedDir(dir), WRAPPER), ...args], { encoding: "utf8", env });
}

/** A wrapper failure never looks like this — that is half of what this file asserts. */
const CRASH = /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND|\n\s+at /;

/** An environment with no CLI reachable at all: every rung of the ladder is dead. */
const NO_CLI = Object.freeze({ PATH: "" });

describe("the installed skill is a copy, not a link", () => {
  it("install.sh --target all lands all four hosts, each as a real directory", () => {
    for (const { host, dir } of HOSTS) {
      const dest = installedDir(dir);
      assert.ok(existsSync(join(dest, "SKILL.md")), `${host}: SKILL.md must be installed at ${dest}`);
      assert.ok(existsSync(join(dest, WRAPPER)), `${host}: the wrapper must be installed`);
      // The precondition of the whole file: a copy. A symlink here would put the checkout
      // back beside the wrapper, and the tests below would prove nothing.
      assert.equal(lstatSync(dest).isSymbolicLink(), false, `${host}: ${dest} must be a copy, not a symlink`);
    }
  });

  it("carries no src/ — the checkout is genuinely absent from the install", () => {
    for (const { host, dir } of HOSTS) {
      assert.equal(existsSync(join(installedDir(dir), "src")), false, `${host}: an installed skill must not carry src/`);
    }
  });
});

for (const { host, dir } of HOSTS) {
  describe(`${host} (${dir}) — the wrapper, installed on its own`, () => {
    it("with no CLI reachable, refuses controllably — no module-not-found crash", () => {
      const run = runWrapper(dir, ["--version"], NO_CLI);

      assert.equal(run.stdout, "", "a refusal must not write to stdout");
      assert.notEqual(run.status, 0, "an unreachable CLI is a failure, not a silent success");
      assert.equal(run.status, 1, `expected the wrapper's own exit code 1, got ${run.status}`);
      assert.doesNotMatch(run.stderr, CRASH, `the wrapper crashed instead of refusing:\n${run.stderr}`);
    });

    it("with no CLI reachable, names where it looked and what to do", () => {
      const run = runWrapper(dir, ["--version"], NO_CLI);

      assert.match(run.stderr, /cannot find the board CLI/, run.stderr);
      // The remedy must be executable advice, and cover both ways in: an installed CLI, or
      // a checkout named explicitly.
      assert.match(run.stderr, /taskctl/, "the remedy must name the CLI");
      assert.match(run.stderr, /MEERKAT_TASKPANEL_ROOT/, "the remedy must name the root override");
      assert.match(run.stderr, /install\.sh/, "the remedy must name the installer");
      // Provenance, not a crash target: the derived path is shown as somewhere it *looked*.
      assert.match(run.stderr, /looked for it at/, run.stderr);
      assert.ok(
        run.stderr.includes(join(home, dir, "src", "cli", "index.mjs")),
        `the refusal should show the path it derived from this skill's own location:\n${run.stderr}`,
      );
    });

    it("uses a taskctl on PATH, and propagates its exit code", () => {
      const args = ["issue", "list", "--json", "--limit", "1"];
      const ok = runWrapper(dir, args, { PATH: fakeBin });
      assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
      assert.match(ok.stdout, /FAKE_TASKCTL argv=issue list --json --limit 1/, "the fake must receive the caller's argv");

      // A non-zero exit from the CLI is the CLI's answer, not the wrapper's to reinterpret.
      const failed = runWrapper(dir, args, { PATH: fakeBin, FAKE_TASKCTL_EXIT: "7" });
      assert.equal(failed.status, 7, "the CLI's exit code must be propagated verbatim");
    });

    it("runs the CLI of a checkout named by MEERKAT_TASKPANEL_ROOT", () => {
      const run = runWrapper(dir, ["--version"], { PATH: "", MEERKAT_TASKPANEL_ROOT: ROOT });
      assert.equal(run.status, 0, `stderr: ${run.stderr}`);
      assert.equal(run.stdout.trim(), VERSION);
    });

    it("runs the CLI of a checkout named by MEERKAT_TASKPANEL_REPO", () => {
      // The key install.sh records in the host config, and the one the loop's
      // board-check.mjs resolves through — same vocabulary, deliberately.
      const run = runWrapper(dir, ["--version"], { PATH: "", MEERKAT_TASKPANEL_REPO: ROOT });
      assert.equal(run.status, 0, `stderr: ${run.stderr}`);
      assert.equal(run.stdout.trim(), VERSION);
    });
  });
}

describe("the resolution ladder is checked, not assumed", () => {
  /** The claude copy stands in for all four here — the ladder lives in one shared file. */
  const dir = HOSTS[0].dir;
  /** The wrapper inside the checkout: its own rung resolves, so it is the control case. */
  const checkoutWrapper = join(ROOT, "skills", SKILL, WRAPPER);

  it("still runs the checkout's own CLI — the in-checkout entry point is unchanged", () => {
    // No PATH at all: this passes on the relative rung alone, which is how the skill has
    // always worked from inside a checkout.
    const run = spawnSync(NODE, [checkoutWrapper, "--version"], { encoding: "utf8", env: NO_CLI });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
  });

  it("skips a root that does not hold a CLI instead of failing on it", () => {
    // A stale MEERKAT_TASKPANEL_ROOT — a moved or deleted checkout — must fall through to
    // the next rung rather than shadow it: that is what makes honouring the variable safe.
    const stale = makeTempDir();
    const run = runWrapper(dir, ["--version"], { PATH: fakeBin, MEERKAT_TASKPANEL_ROOT: stale });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /FAKE_TASKCTL/, "the stale root must fall through to PATH");
  });

  it("prefers an explicit root over PATH", () => {
    // Both are reachable and they disagree; the explicit one wins, and the fake (which
    // would exit 7) is never consulted.
    const run = runWrapper(dir, ["--version"], {
      PATH: fakeBin,
      FAKE_TASKCTL_EXIT: "7",
      MEERKAT_TASKPANEL_ROOT: ROOT,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
  });
});
