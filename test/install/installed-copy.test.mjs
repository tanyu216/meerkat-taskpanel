/**
 * The board skill, deployed **on its own** — the mode `install.sh` actually ships.
 *
 * The skill is distributed as a *copy*: `install_skill` runs `cp -R skills/<skill> <dest>`,
 * which lands `SKILL.md`, `references/` and `scripts/` in an agent's skill directory and
 * nothing else. In particular the taskpanel checkout is **not** beside it, so anything the
 * skill tells a user to run has to work without one.
 *
 * That is the mode this suite covers, and the mode nothing covered before it: the
 * container's profile check (`scripts/verify/profiles.mjs`) installs with
 * `MEERKAT_TASKPANEL_LINK=1`, i.e. a *symlink*, which puts the checkout back next to the
 * wrapper and hides exactly the defect this file exists for. A copied install used to die
 * inside Node with `Cannot find module '<home>/<agent-dir>/src/cli/index.mjs'`
 * (T-20261014-214002) — a path the user never had, reported as a crash rather than as a
 * condition of the deployment.
 *
 * Per agent kind (all four the board goes to — see `KINDS` below), against a real
 * copy-mode install into a throwaway prefix, this asserts the wrapper:
 *
 *   1. with no CLI reachable refuses **controllably** — non-zero, an actionable remedy on
 *      stderr, and no module-not-found stack;
 *   2. uses a `taskctl` on `PATH`, and propagates its exit code;
 *   3. runs the CLI of a checkout named by `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`.
 *
 * Plus the properties shared by all of them: the checkout rung is unchanged (which is what a
 * stale or misspelt root must fall through *to*), and an explicit root outranks `PATH`.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

import { VERSION } from "../../src/foundation/constants.mjs";

const { makeTempDir, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-installed-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE = process.execPath;
/** The skill under test, and the wrapper inside it. */
const SKILL = "meerkat-taskpanel";
const WRAPPER = join("scripts", "run.mjs");

/**
 * The four agent kinds the board skill is distributed to, and the dot-directory each one's skill
 * lands in. These are `docker/profiles/<agent-dir>.yml`'s `target_dir`s — the same destinations
 * `scripts/verify/profiles.mjs` asserts — restated here because this file drives the
 * installs itself.
 */
const KINDS = Object.freeze([
  { kind: "claude", dir: ".claude" },
  { kind: "codex", dir: ".codex" },
  { kind: "openclaw", dir: ".openclaw" },
  { kind: "pi", dir: ".agents" },
]);

after(cleanup);

/** The throwaway `$HOME` the agent kinds are installed into, and the `bin` holding the fake CLI. */
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
    env: {
      ...process.env,
      MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
      MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1",
    },
  });
  assert.equal(install.status, 0, install.stderr);
  assert.ok(
    existsSync(join(home, ".meerkat-taskpanel", "src", "cli", "index.mjs")),
    "--target all is the full install: the server tree comes with the agent skills",
  );

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

/** The installed skill directory for one agent kind's dot-directory. */
function installedDir(dir) {
  return join(home, dir, "skills", SKILL);
}

/** Run an installed wrapper with a controlled environment. */
function runWrapper(dir, args, env) {
  return spawnSync(NODE, [join(installedDir(dir), WRAPPER), ...args], { encoding: "utf8", env });
}

/** Run the wrapper of a bare copy, i.e. with no `<agent-dir>/bin/taskctl` beside it. */
function runBare(dir, args, env) {
  return spawnSync(NODE, [join(bareCopy(dir), WRAPPER), ...args], { encoding: "utf8", env });
}

/**
 * A `PATH` that can actually run the installed shim: the fake `taskctl` first, then a
 * `node` and a `bash`.
 *
 * The fake alone stopped being enough when the shim became reachable by path. The shim is
 * `#!/usr/bin/env bash` and ends in `exec node "<checkout>/src/cli/index.mjs"`, so it needs
 * **both** on `PATH` — with either missing, the shim becomes the rung that fails, which
 * reads exactly like "the shim is not preferred" when it is.
 *
 * The standard directories go **after** the fake, so a `taskctl` a developer happens to
 * have installed (typically `~/.local/bin`, which is deliberately not on this list) cannot
 * answer for it.
 */
const PATH_WITH_FAKE = [fakeBin, dirname(NODE), "/bin", "/usr/bin"].join(delimiter);

/** A wrapper failure never looks like this — that is half of what this file asserts. */
const CRASH = /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND|\n\s+at /;

/**
 * An environment with no CLI on `PATH`.
 *
 * Deliberately *not* frozen. `spawnSync` writes to the env object it is handed — under
 * `--experimental-test-coverage` the runner adds `NODE_V8_COVERAGE` to it so spawned
 * children are instrumented — and a non-extensible object makes that a `TypeError`
 * before any child is spawned. Freezing bought nothing here: nothing in this file
 * mutates the object, and the injected variable changes no assertion (T-20261015-051046).
 *
 * **An empty `PATH` is no longer "no CLI reachable".** `install.sh` writes a `taskctl`
 * shim at `<agent-dir>/bin/taskctl`, and the wrapper prefers it (it is the one `taskctl` that
 * carries the caller's identity) — a rung found by *path*, not by `PATH`. So the legs that
 * want nothing reachable, and the leg that wants a `PATH` CLI to answer, run a **bare
 * copy** instead: see `bareCopy`.
 */
const NO_CLI = { PATH: "" };

/**
 * A copy of one installed skill with **no `bin/` beside it** — the state a skill is in when
 * it has been copied somewhere on its own, which is the deployment this whole file is
 * about. It is what the refusal legs need now that the installed tree has a reachable shim.
 *
 * The walk is the wrapper's own (`here/../../..` lands on the agent directory), so a copy
 * under a fresh temp dir has no sibling shim to find.
 */
const bareCopies = new Map();
function bareCopy(dir) {
  const cached = bareCopies.get(dir);
  if (cached !== undefined) return cached;
  const dest = join(makeTempDir("meerkat-taskpanel-bare-"), "skills", SKILL);
  cpSync(installedDir(dir), dest, { recursive: true });
  bareCopies.set(dir, dest);
  return dest;
}

describe("the installed skill is a copy, not a link", () => {
  it("install.sh --target all lands every agent kind, each as a real directory", () => {
    for (const { kind, dir } of KINDS) {
      const dest = installedDir(dir);
      assert.ok(existsSync(join(dest, "SKILL.md")), `${kind}: SKILL.md must be installed at ${dest}`);
      assert.ok(existsSync(join(dest, WRAPPER)), `${kind}: the wrapper must be installed`);
      // The precondition of the whole file: a copy. A symlink here would put the checkout
      // back beside the wrapper, and the tests below would prove nothing.
      assert.equal(lstatSync(dest).isSymbolicLink(), false, `${kind}: ${dest} must be a copy, not a symlink`);
    }
  });

  it("writes a taskctl shim for every agent kind — the rung that carries the identity", () => {
    // The shim is what pins `--agent <name> --actor-kind <kind>` on every call, and an agent kind
    // without one records its writes with no kind — which the board reads as a person's.
    // `docs/install.md` promises it for every agent kind, not only the two bundle agent kinds.
    for (const { kind, dir } of KINDS) {
      const shim = join(home, dir, "bin", "taskctl");
      assert.ok(existsSync(shim), `${kind}: the shim must be installed at ${shim}`);
      assert.equal(lstatSync(shim).isSymbolicLink(), false, `${kind}: the shim must be a real file`);
      const text = readFileSync(shim, "utf8");
      assert.match(text, /--actor-kind/, `${kind}: the shim must inject the kind`);
      // ...and this agent kind's own name at each place the shim defaults it: the flag on the
      // command line, and the variable it exports for anything else the session runs.
      assert.ok(text.includes(`--actor-kind "${kind}"`) || text.includes(`:-${kind}}`), `${kind}: the shim must name this agent kind`);
    }
  });

  it("carries no src/ — the checkout is genuinely absent from the install", () => {
    for (const { kind, dir } of KINDS) {
      assert.equal(existsSync(join(installedDir(dir), "src")), false, `${kind}: an installed skill must not carry src/`);
    }
  });
});

for (const { kind, dir } of KINDS) {
  describe(`${kind} (${dir}) — the wrapper, installed on its own`, () => {
    it("with no CLI reachable, refuses controllably — no module-not-found crash", () => {
      const run = runBare(dir, ["--version"], NO_CLI);

      assert.equal(run.stdout, "", "a refusal must not write to stdout");
      assert.notEqual(run.status, 0, "an unreachable CLI is a failure, not a silent success");
      assert.equal(run.status, 1, `expected the wrapper's own exit code 1, got ${run.status}`);
      assert.doesNotMatch(run.stderr, CRASH, `the wrapper crashed instead of refusing:\n${run.stderr}`);
    });

    it("with no CLI reachable, names where it looked and what to do", () => {
      const run = runBare(dir, ["--version"], NO_CLI);

      assert.match(run.stderr, /cannot find the board CLI/, run.stderr);
      // The remedy must be executable advice and cover both ways in: a CLI on PATH, or a
      // checkout named explicitly.
      assert.match(run.stderr, /taskctl/, "the remedy must name the CLI");
      assert.match(run.stderr, /MEERKAT_TASKPANEL_ROOT/, "the remedy must name the root override");
      assert.match(run.stderr, /put the CLI on your PATH/, "the remedy must name the PATH route");
      // Provenance, not a crash target: the derived path is shown as somewhere it *looked*.
      assert.match(run.stderr, /looked for it at/, run.stderr);
      // The derived path is the bare copy's own (`here/../../..`), not the installed one:
      // the refusal must describe *this* invocation's rungs.
      const derived = join(resolve(bareCopy(dir), "..", ".."), "src", "cli", "index.mjs");
      assert.ok(
        run.stderr.includes(derived),
        `the refusal should show the path it derived from this skill's own location (${derived}):\n${run.stderr}`,
      );
    });

    it("uses a taskctl on PATH, and propagates its exit code", () => {
      const args = ["issue", "list", "--json", "--limit", "1"];
      const ok = runBare(dir, args, { PATH: fakeBin });
      assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
      assert.match(ok.stdout, /FAKE_TASKCTL argv=issue list --json --limit 1/, "the fake must receive the caller's argv");

      // A non-zero exit from the CLI is the CLI's answer, not the wrapper's to reinterpret.
      const failed = runBare(dir, args, { PATH: fakeBin, FAKE_TASKCTL_EXIT: "7" });
      assert.equal(failed.status, 7, "the CLI's exit code must be propagated verbatim");
    });

    it("prefers the agent's own shim over a taskctl on PATH", () => {
      // Both are reachable and they disagree: the shim is the `taskctl` that pins the
      // caller's identity, and the one on PATH is a stranger's. The fake would exit 7, so a
      // zero exit with the real version is the shim answering.
      const run = runWrapper(dir, ["--version"], { PATH: PATH_WITH_FAKE, FAKE_TASKCTL_EXIT: "7" });
      assert.equal(run.status, 0, `stderr: ${run.stderr}`);
      assert.equal(run.stdout.trim(), VERSION, "the installed shim runs this checkout's CLI");
      assert.doesNotMatch(run.stdout, /FAKE_TASKCTL/, "the PATH CLI must not be consulted");
    });

    it("runs the CLI of a checkout named by MEERKAT_TASKPANEL_ROOT", () => {
      const run = runWrapper(dir, ["--version"], { PATH: "", MEERKAT_TASKPANEL_ROOT: ROOT });
      assert.equal(run.status, 0, `stderr: ${run.stderr}`);
      assert.equal(run.stdout.trim(), VERSION);
    });

    it("runs the CLI of a checkout named by MEERKAT_TASKPANEL_REPO", () => {
      // The key install.sh records in the agent config, and the one the loop's
      // board-check.mjs resolves through — same vocabulary, deliberately.
      const run = runWrapper(dir, ["--version"], { PATH: "", MEERKAT_TASKPANEL_REPO: ROOT });
      assert.equal(run.status, 0, `stderr: ${run.stderr}`);
      assert.equal(run.stdout.trim(), VERSION);
    });
  });
}

describe("the resolution ladder is checked, not assumed", () => {
  /** The claude copy stands in for all four here — the ladder lives in one shared file. */
  const dir = KINDS[0].dir;
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
    // From the installed tree the rung after it is the agent's shim; from a bare copy it is
    // the PATH CLI. Both are asserted, because "falls through" must not depend on which
    // rung happens to be alive.
    const stale = makeTempDir();
    const installed = runWrapper(dir, ["--version"], { PATH: PATH_WITH_FAKE, MEERKAT_TASKPANEL_ROOT: stale });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim(), VERSION, "the stale root must fall through to the shim");

    const bare = runBare(dir, ["--version"], { PATH: fakeBin, MEERKAT_TASKPANEL_ROOT: stale });
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /FAKE_TASKCTL/, "and, with no shim, all the way to PATH");
  });

  it("prefers an explicit root over both PATH and the agent's shim", () => {
    // Three rungs are reachable and they disagree — the named checkout, the installed shim
    // (which runs the same checkout, so it agrees) and the fake on PATH (which would exit
    // 7). The explicit root wins, and nothing below it is consulted.
    const run = runWrapper(dir, ["--version"], {
      PATH: PATH_WITH_FAKE,
      FAKE_TASKCTL_EXIT: "7",
      MEERKAT_TASKPANEL_ROOT: ROOT,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), VERSION);
    assert.doesNotMatch(run.stdout, /FAKE_TASKCTL/);
  });
});
