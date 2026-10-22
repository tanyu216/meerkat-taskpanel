/**
 * The scheduling unit's PATH, and the two resolutions it fixes (T-20261014-020103-2).
 *
 * A scheduler starts a unit with a minimal PATH of its own, so a unit whose interpreter
 * is `/usr/bin/env node` exits 127 on any machine whose node lives under nvm or Homebrew
 * — and fixing only that merely moves the failure: the wake glue the tick starts runs
 * `exec claude` on the *same* inherited PATH and exits 127 in turn. Both layers are
 * fixed by one lever, and this file is the red→green record of it:
 *
 *   * `unit-path.mjs` owns the recipe (one definition, three scheduler renderings);
 *   * `_common.sh` reaches it through the CLI, so bash and JS cannot drift;
 *   * the rendered launchd/cron units name an absolute interpreter and carry the PATH;
 *   * a positive control — the rendered PATH really does resolve `node` and the host
 *     CLI under `env -i`, the same minimal environment the scheduler provides.
 *
 * The units are *rendered* here, never loaded: the loading itself is the taskd guard's
 * business, and `MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE` keeps it out of these cases.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

import { SCHEDULER_DEFAULT_PATH, unitPath } from "../../scripts/install/lib/unit-path.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-unitpath-", installDefaults: {} });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = join(ROOT, "scripts", "install", "lib", "unit-path.mjs");
/** The absolute node that rendered *this* file — what an install must name too. */
const NODE = process.execPath;
const NODE_DIR = dirname(NODE);
/** `/usr/bin/env`, the binary the units used to start node through. Always present. */
const ENV_BIN = "/usr/bin/env";

after(cleanup);

/** A fake host CLI: enough to be *found* by name on PATH, which is the whole question. */
function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, `#!/usr/bin/env bash\nexit 0\n`, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

function runHelper(args) {
  return spawnSync("node", [HELPER, ...args], { cwd: ROOT, encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// 1 — the recipe itself
// ---------------------------------------------------------------------------

describe("unit-path: the recipe", () => {
  it("prepends the host CLI's directory and node's to the scheduler's documented default", () => {
    assert.equal(
      unitPath("/opt/node/bin", { cliDir: "/opt/cli/bin", scheduler: "launchd" }),
      "/opt/cli/bin:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    assert.equal(
      unitPath("/opt/node/bin", { cliDir: "/opt/cli/bin", scheduler: "cron" }),
      "/opt/cli/bin:/opt/node/bin:/usr/bin:/bin",
    );
    assert.equal(
      unitPath("/opt/node/bin", { cliDir: "/opt/cli/bin", scheduler: "systemd" }),
      "/opt/cli/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
  });

  it("keeps each scheduler's default as a *suffix*, so nothing else about the job changes", () => {
    for (const [scheduler, defaults] of Object.entries(SCHEDULER_DEFAULT_PATH)) {
      const value = unitPath("/opt/node/bin", { cliDir: "/opt/cli/bin", scheduler });
      assert.ok(value.endsWith(`:${defaults}`), `${scheduler}: the documented default must survive verbatim`);
      // `sh`, `git`, `crontab` … all live in that suffix; narrowing it is the other bug.
      assert.ok(value.split(":").includes("/bin"), `${scheduler}: /bin must remain reachable`);
    }
  });

  it("deduplicates when the CLI and node share a directory (nvm puts its global bin there)", () => {
    assert.equal(
      unitPath("/opt/node/bin", { cliDir: "/opt/node/bin", scheduler: "launchd" }),
      "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("degrades to node's directory alone when the host CLI is not on PATH", () => {
    assert.equal(unitPath("/opt/node/bin", { scheduler: "cron" }), "/opt/node/bin:/usr/bin:/bin");
    assert.equal(unitPath("/opt/node/bin", { cliDir: "", scheduler: "cron" }), "/opt/node/bin:/usr/bin:/bin");
  });

  it("the taskd guard's call — one argument — is byte-for-byte what it always rendered", () => {
    // The guard's `{{PATH}}` is deliberately unchanged by the shared recipe: a service
    // that never derives another executable prepends node's directory and nothing else.
    assert.equal(unitPath("/opt/node/bin"), "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("refuses a scheduler it does not know, rather than guessing a default set", () => {
    assert.throws(() => unitPath("/opt/node/bin", { scheduler: "upstart" }), /unknown scheduler/);
    // …including the names every object answers for by inheritance: a bare lookup would
    // hand back `function Object() { … }` and render it as if it were a PATH.
    for (const inherited of ["constructor", "toString", "hasOwnProperty"]) {
      assert.throws(() => unitPath("/opt/node/bin", { scheduler: inherited }), /unknown scheduler/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — the CLI the installer reads it through
// ---------------------------------------------------------------------------

describe("unit-path: the CLI", () => {
  it("answers with the absolute interpreter that runs it", () => {
    const run = runHelper(["node"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), NODE);
  });

  it("answers with the recipe's value for a scheduler", () => {
    const run = runHelper(["path", "--scheduler", "launchd", "--cli-dir", "/opt/cli/bin"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), unitPath(NODE_DIR, { cliDir: "/opt/cli/bin", scheduler: "launchd" }));
  });

  it("takes --node-dir as the directory it is, not as a binary to strip", () => {
    const run = runHelper(["path", "--scheduler", "cron", "--node-dir", "/opt/node/bin", "--cli-dir", "/opt/cli/bin"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "/opt/cli/bin:/opt/node/bin:/usr/bin:/bin");
  });

  it("exits 2 — never silently — on a scheduler or option it cannot honour", () => {
    const bad = runHelper(["path", "--scheduler", "upstart"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown scheduler/);

    const missing = runHelper(["path"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /needs --scheduler/);

    const unknown = runHelper(["path", "--nope"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option/);
  });
});

// ---------------------------------------------------------------------------
// 3 — the installed units
// ---------------------------------------------------------------------------

function installEnv(home, path) {
  return {
    ...process.env,
    PATH: path,
    MEERKAT_TASKPANEL_TARGET_HOME: home,
    MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
  };
}

/** `<key>PATH</key><string>…</string>` — the plist's exported PATH. */
function plistPath(text) {
  return /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(text)?.[1];
}

describe("install.sh: the units carry their own PATH instead of borrowing the host's", () => {
  it("launchd names the absolute interpreter and exports the CLI's directory + node's", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      installEnv(home, `${bin}:${process.env.PATH}`),
    );
    assert.equal(run.status, 0, run.stderr);

    const expected = unitPath(NODE_DIR, { cliDir: bin, scheduler: "launchd" });

    for (const kind of ["ping", "continue"]) {
      const file = join(home, ".claude", "scheduling", "launchd", `com.meerkat-taskpanel.${kind}.plist`);
      const text = readFileSync(file, "utf8");
      // The defect itself: `/usr/bin/env node` is resolved against launchd's
      // `/usr/bin:/bin:/usr/sbin:/sbin`, which holds no nvm and no Homebrew directory.
      // (The file's own comment names that form, so the assertion is on the *string
      // values* — what launchd actually executes — not on the text as a whole.)
      assert.ok(!text.includes("<string>/usr/bin/env</string>"), `${kind}: the interpreter must not go through env`);
      assert.ok(!text.includes("<string>node</string>"), `${kind}: nor may it be a bare name`);
      assert.ok(!text.includes("{{"), `${kind}: every token must be rendered`);
      assert.match(text, new RegExp(`<string>${NODE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
      assert.equal(plistPath(text), expected, `${kind}: the exported PATH is the recipe's value`);

      // And the value the *JS* side would compute for the same inputs is the same string
      // — the installer reads the recipe through its CLI, so the two cannot drift.
      assert.equal(plistPath(text), unitPath(NODE_DIR, { cliDir: bin, scheduler: "launchd" }));
    }
  });

  it("cron sets PATH= on its own line and names the absolute interpreter on both jobs", () => {
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    assert.equal(
      runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, `${bin}:${process.env.PATH}`)).status,
      0,
    );

    const text = readFileSync(join(home, ".claude", "scheduling", "cron", "meerkat-taskpanel.cron"), "utf8");
    const setting = text.split("\n").find((line) => line.startsWith("PATH="));
    assert.equal(setting, `PATH=${unitPath(NODE_DIR, { cliDir: bin, scheduler: "cron" })}`);

    const jobs = text.split("\n").filter((line) => !line.startsWith("#") && /^\S+ \S+ \S+ \S+ \S+ /.test(line));
    assert.equal(jobs.length, 2, "a ping line and a continue line");
    for (const job of jobs) {
      assert.ok(!job.includes("/usr/bin/env"), "cron resolves a bare name against its own minimal PATH");
      assert.ok(job.includes(NODE), `the job must name the absolute interpreter: ${job}`);
    }
  });

  it("positive control: under a minimal PATH the rendered value resolves node AND the host CLI", () => {
    // The unit's own mechanism, reproduced: `/usr/bin/env <name>` with nothing but the
    // unit's PATH in the environment — the layer-① and layer-② failures, both fixed by
    // the one value the installer wrote.
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    assert.equal(
      runInstall(["--target", "claude", "--agent-name", "alice"], installEnv(home, `${bin}:${process.env.PATH}`)).status,
      0,
    );

    const rendered = plistPath(
      readFileSync(join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.ping.plist"), "utf8"),
    );
    const minimal = { PATH: rendered };

    // ① the interpreter: this used to be `env: node: No such file or directory` (127).
    const node = spawnSync(ENV_BIN, ["node", "--version"], { env: minimal, encoding: "utf8" });
    assert.equal(node.status, 0, `layer ① must resolve: ${node.stderr}`);
    assert.equal(node.stdout.trim(), `v${process.versions.node}`);

    // ② the glue's `exec claude`: same minimal PATH, resolved by name.
    const cli = spawnSync(ENV_BIN, ["claude"], { env: minimal, encoding: "utf8" });
    assert.equal(cli.status, 0, `layer ② must resolve: ${cli.stderr}`);

    // …and the default suffix is not narrowed: the worker's own tool tree still runs.
    const sh = spawnSync(ENV_BIN, ["sh", "-c", "exit 0"], { env: minimal, encoding: "utf8" });
    assert.equal(sh.status, 0, "sh must stay reachable through the scheduler's default suffix");
  });

  it("degrades out loud when the host CLI is not on PATH — never a silent half-fix", () => {
    // A PATH with node but no `claude`: the unit would still tick, and the wake would
    // still fail. That is a *stated* half-fix, not a hidden one.
    const home = makeTempDir();
    const bin = makeTempDir();
    symlinkSync(NODE, join(bin, "node"));
    const run = runInstall(
      ["--target", "claude", "--agent-name", "alice"],
      installEnv(home, `${bin}:/usr/bin:/bin`),
    );
    assert.equal(run.status, 0, run.stderr);

    assert.match(run.stdout, /claude is not on PATH/);
    assert.match(run.stdout, /re-run this install with --force/);

    const text = readFileSync(join(home, ".claude", "scheduling", "launchd", "com.meerkat-taskpanel.ping.plist"), "utf8");
    const rendered = plistPath(text);
    assert.ok(!rendered.split(":").includes(bin), "the unresolvable CLI directory must not be invented");
    assert.equal(rendered.split(":")[0], NODE_DIR, "node's own directory is still the head");
  });
});

// ---------------------------------------------------------------------------
// 4 — one set of lines, two readers (the rendered unit and the enable preview)
// ---------------------------------------------------------------------------

describe("install.sh: --supervisor=enable previews the lines it would install", () => {
  it("builds the dry-run preview from the same values as the rendered unit, not a second guess", () => {
    // The enable path and the manual `crontab <file>` path must never drift. In a dry run
    // *nothing* is rendered, so the preview comes from the values the installer exported
    // (`TP_NODE` / `TP_UNIT_PATH_CRON`) rather than from the file — which is exactly the
    // path that could have kept advertising `/usr/bin/env node`. Both readers are pinned
    // against the same expected lines, so they agree with the recipe rather than with
    // each other.
    const home = makeTempDir();
    const bin = makeTempDir();
    makeFakeCli(bin, "claude");
    const path = `${bin}:${process.env.PATH}`;
    const loop = join(home, ".claude", "meerkat-taskpanel");
    const expected = [
      `PATH=${unitPath(NODE_DIR, { cliDir: bin, scheduler: "cron" })}`,
      `* * * * * ${NODE} ${loop}/scripts/supervisor.mjs --actor-kind claude --agent alice --ping-only --once --log ${loop}/supervisor.log --state ${loop}/supervisor.state.json >/dev/null 2>&1`,
      `*/10 * * * * ${NODE} ${loop}/scripts/supervisor.mjs --actor-kind claude --agent alice --continue-only --once --log ${loop}/supervisor.log --state ${loop}/supervisor.state.json >/dev/null 2>&1`,
    ];

    const dry = runInstall(
      ["--target", "claude", "--agent-name", "alice", "--prefix", home, "--dry-run", "--supervisor=enable", "--scheduler=cron"],
      installEnv(home, path),
    );
    assert.equal(dry.status, 0, dry.stderr);
    // The preview is printed as `supervisor: would run:   <line>`; the marker lines are
    // dropped, leaving the block the enable would write.
    const previewed = dry.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("supervisor: would run:"))
      .map((line) => line.slice("supervisor: would run:".length).trim())
      .filter((line) => line.startsWith("PATH=") || /^\*.*\* .*supervisor\.mjs/.test(line));
    assert.deepEqual(previewed, expected, `the preview must show the setting line and both jobs:\n${dry.stdout}`);

    // The real install writes the same three lines into the unit file.
    assert.equal(
      runInstall(["--target", "claude", "--agent-name", "alice", "--prefix", home], installEnv(home, path)).status,
      0,
    );
    const written = readFileSync(join(home, ".claude", "scheduling", "cron", "meerkat-taskpanel.cron"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("PATH=") || /^\*.*\* .*supervisor\.mjs/.test(line));
    assert.deepEqual(written, expected);
  });
});
