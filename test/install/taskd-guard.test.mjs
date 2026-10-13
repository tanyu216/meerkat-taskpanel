/**
 * The `taskd` keepalive guard (T-20261013-213717-3).
 *
 * `taskctl` lazy-starts `taskd` only when a CLI call needs it, so a board whose server
 * dies while nobody is calling it stays down until the next call. The guard closes that
 * gap with the OS's own supervisor: one launchd plist / systemd user unit, written to a
 * neutral `<prefix>/taskpanel/scheduling/` directory and **loaded at install time** —
 * the one explicit exception to this installer's "write the unit, never start a daemon"
 * rule (the contract is `docs/scheduling.md`, and it is the single source of truth for
 * the unit text below).
 *
 * Three things are held here:
 *
 *   1. the **unit templates** — committed under `scripts/install/templates/taskd/` — are
 *      the contract's own text, and are well-formed (plutil, where it exists);
 *   2. **rendering**: absolute `{{SERVER_ENTRY}}` / `{{LOG}}`, the log directory created,
 *      and idempotence (a re-install rewrites nothing, `--force` is the only overwrite);
 *   3. **install.sh**: the guard is written *and loaded* once per machine, the second
 *      install loads nothing a second time, and the boxed-in cases — `--dry-run`,
 *      `--no-automation`, the test-only bypass, and a supervisor that refuses — report
 *      themselves instead of failing the install.
 *
 * The service manager is **faked on PATH**, the way `scheduling-units.test.mjs` fakes a
 * host CLI: an install must never load a real unit during a test run.
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

import { TASKD_LABEL, TASKD_TEMPLATE_FILES, TASKD_UNIT, enablePlan, guardPaths, systemdUserDir } from "../../scripts/install/lib/taskd-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = join(ROOT, "scripts", "install", "templates");
const PLATFORM = process.platform;
const UID = process.getuid?.() ?? 0;

const launchdTemplate = readFileSync(join(TEMPLATES, TASKD_TEMPLATE_FILES.launchd), "utf8");
const systemdTemplate = readFileSync(join(TEMPLATES, TASKD_TEMPLATE_FILES.systemd), "utf8");

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-guard-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The fenced block an anchored section of a doc runs into — verbatim. */
function fencedBlock(doc, anchor, fence) {
  const lines = readFileSync(join(ROOT, doc), "utf8").split("\n");
  const start = lines.indexOf(anchor);
  assert.notEqual(start, -1, `${doc}: anchor "${anchor}" not found`);
  const open = lines.indexOf(fence, start);
  assert.notEqual(open, -1, `${doc}: no ${fence} block after "${anchor}"`);
  const close = lines.indexOf("```", open + 1);
  assert.notEqual(close, -1, `${doc}: unterminated ${fence} block`);
  return `${lines.slice(open + 1, close).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 1 — the unit templates are the contract's text, and they parse
// ---------------------------------------------------------------------------

describe("taskd guard: the unit templates are the contract's", () => {
  it("the launchd plist is byte-identical to the fenced block in docs/scheduling.md", () => {
    assert.equal(launchdTemplate, fencedBlock("docs/scheduling.md", "#### launchd unit (macOS)", "```xml"));
  });

  it("the systemd unit is byte-identical to the fenced block in docs/scheduling.md", () => {
    assert.equal(systemdTemplate, fencedBlock("docs/scheduling.md", "#### systemd unit (Linux)", "```ini"));
  });

  it("the plist is well-formed, and plutil agrees where it exists", () => {
    assertWellFormedPlist(launchdTemplate);

    // plutil ships with macOS; on Linux the structural check above is the equivalent
    // assertion the acceptance allows. Deliberately not a `skip`: a skipped case is a
    // case nobody reads.
    if (existsSync("/usr/bin/plutil")) {
      const file = join(makeTempDir(), `${TASKD_LABEL}.plist`);
      writeFileSync(file, launchdTemplate, "utf8");
      const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
      assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
      assert.match(lint.stdout, /OK/);
    }
  });

  it("the plist carries the keepalive shape the contract fixes", () => {
    const text = launchdTemplate;
    assert.match(text, /<key>Label<\/key>\s*<string>com\.meerkat-taskpanel\.taskd<\/string>/);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(text, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    assert.match(text, /<key>StandardOutPath<\/key>\s*<string>\{\{LOG\}\}<\/string>/);
    assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>\{\{LOG\}\}<\/string>/);
    // No scheduled tick: a long-running owner of the write lock, not an interval job.
    assert.doesNotMatch(text, /<key>(StartInterval|StartCalendarInterval)<\/key>/);

    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    assert.notEqual(args, null, "ProgramArguments must be an array");
    const argv = [...args[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    assert.deepEqual(argv, ["/usr/bin/env", "node", "{{SERVER_ENTRY}}"]);
  });

  it("the systemd unit carries the restart + back-off shape the contract fixes", () => {
    const text = systemdTemplate;
    assert.match(text, /\[Unit\]/);
    assert.match(text, /Description=Meerkat TaskPanel taskd \(board server\) guard/);
    assert.match(text, /\[Service\]/);
    assert.match(text, /Type=simple/);
    assert.match(text, /ExecStart=\/usr\/bin\/env node \{\{SERVER_ENTRY\}\}/);
    assert.match(text, /Restart=always/);
    assert.match(text, /RestartSec=5/);
    assert.match(text, /StandardOutput=append:\{\{LOG\}\}/);
    assert.match(text, /StandardError=append:\{\{LOG\}\}/);
    assert.match(text, /WantedBy=default\.target/);

    // The header comment mentions `.timer` to say there is none; the *effective* unit
    // (comments stripped) must have no timer section and name no `.timer` unit.
    const effective = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(effective, /\.timer|\[Timer\]/, "the guard is a service, never a tick");

    // The start limit belongs in [Unit]: systemd ignores it in [Service], so a unit
    // that put it there would silently lose its crash-loop protection.
    const unitSection = /\[Unit\]([\s\S]*?)\n\[/.exec(text)?.[1] ?? "";
    const serviceSection = /\[Service\]([\s\S]*?)\n\[/.exec(text)?.[1] ?? "";
    assert.match(unitSection, /StartLimitIntervalSec=60/);
    assert.match(unitSection, /StartLimitBurst=5/);
    assert.doesNotMatch(serviceSection, /StartLimit/);
  });

  it("neither unit overrides the client's autostart policy or pins an ephemeral port", () => {
    // Both are client concerns (docs/scheduling.md § Coexisting with taskctl's lazy
    // start): a long-running guard needs a *stable* port another client can find, and
    // exporting TASKD_NO_AUTOSTART from the guard would mislead any CLI that inherited it.
    for (const [name, text] of [["launchd", launchdTemplate], ["systemd", systemdTemplate]]) {
      assert.doesNotMatch(text, /TASKD_NO_AUTOSTART/, `${name} must not set TASKD_NO_AUTOSTART`);
      assert.doesNotMatch(text, /TASKD_PORT/, `${name} must not set TASKD_PORT`);
    }
  });

  it("the label and unit name carry no agent or host segment (one guard per machine)", () => {
    for (const name of [TASKD_LABEL, TASKD_UNIT]) {
      assert.doesNotMatch(name, /\{\{|AGENT|HOST/i);
    }
    assert.equal(TASKD_LABEL, "com.meerkat-taskpanel.taskd");
    assert.equal(TASKD_UNIT, "meerkat-taskpanel-taskd.service");
  });
});

/**
 * The XML subset a plist uses, checked the way `plutil -lint` would: every tag closed,
 * one `<plist>` root, no stray markup — so a dropped `</dict>` cannot pass as "the
 * template is unchanged".
 */
function assertWellFormedPlist(xml) {
  const body = xml
    .replace(/<\?xml[^>]*\?>/, "")
    .replace(/<!DOCTYPE[^>]*>/, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const allowed = new Set(["plist", "dict", "array", "key", "string", "true", "false", "integer"]);
  const stack = [];
  let roots = 0;
  let elements = 0;

  for (const match of body.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    assert.ok(allowed.has(name), `unexpected element <${name}>`);
    if (closing === "/") {
      assert.equal(stack.pop(), name, `</${name}> closes the wrong element`);
      continue;
    }
    if (selfClosing !== "/") {
      if (name === "plist") roots++;
      stack.push(name);
    }
    elements++;
  }

  assert.equal(roots, 1, "exactly one <plist> root");
  assert.equal(stack.length, 0, "every element is closed");

  // Plist's own shape: every `<key>` is immediately followed by the value for it.
  const pairs = [...body.matchAll(/<key>([^<]*)<\/key>\s*<([a-z]+)[^>]*?\/?>/g)];
  const keys = (body.match(/<key>/g) ?? []).length;
  assert.ok(elements > 0, "the document has elements");
  assert.equal(pairs.length, keys, "every <key> is followed by a value element");
  for (const [, key, kind] of pairs) {
    assert.ok(
      ["string", "array", "dict", "true", "false", "integer"].includes(kind),
      `<key>${key}</key> is followed by <${kind}>`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2 — rendering: absolute paths, the log directory, idempotence
// ---------------------------------------------------------------------------

describe("taskd guard: rendering", () => {
  it("lands in the neutral directory, never under a host's own scheduling tree", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const paths = guardPaths({ prefix, env: { TASKD_DATA_DIR: dataDir } });

    assert.equal(paths.launchdUnit, join(prefix, "taskpanel", "scheduling", "launchd", `${TASKD_LABEL}.plist`));
    assert.equal(paths.systemdUnit, join(prefix, "taskpanel", "scheduling", "systemd", TASKD_UNIT));
    assert.equal(paths.serverEntry, join(ROOT, "src", "server", "main.mjs"));
    assert.equal(paths.logFile, join(dataDir, "logs", "taskd.log"));
    for (const hostDir of [".claude", ".codex", ".openclaw", ".agents"]) {
      assert.ok(!paths.launchdUnit.includes(join(prefix, hostDir)), `never under ${hostDir}/`);
    }
  });

  it("substitutes both placeholders, and creates the log directory launchd will not", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const env = guardEnv(prefix, dataDir, fakeManagerBin());

    const first = runGuardInstall(prefix, env);
    assert.equal(first.status, 0, first.stderr);

    const paths = guardPaths({ prefix, env });
    for (const file of [paths.launchdUnit, paths.systemdUnit]) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /\{\{/, `${file} still has a template token`);
      assert.ok(text.includes(paths.serverEntry), `${file} must name the absolute server entry`);
      assert.ok(text.includes(paths.logFile), `${file} must name the absolute log file`);
    }

    // launchd will not create a missing StandardOutPath directory, so the installer
    // must — otherwise the job starts and cannot log.
    assert.ok(statSync(join(dataDir, "logs")).isDirectory(), "the log directory must exist");
  });

  it("is idempotent: a re-install rewrites nothing, and does not load a second time", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin);

    const first = runGuardInstall(prefix, env);
    assert.equal(first.status, 0, first.stderr);
    const paths = guardPaths({ prefix, env });
    const before = { plist: readFileSync(paths.launchdUnit, "utf8"), unit: readFileSync(paths.systemdUnit, "utf8") };
    const loadsBefore = countLoads(bin);

    const again = runGuardInstall(prefix, env);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /taskd guard: already loaded \(no change\)/);
    assert.equal(readFileSync(paths.launchdUnit, "utf8"), before.plist, "the plist is not rewritten");
    assert.equal(readFileSync(paths.systemdUnit, "utf8"), before.unit, "the unit is not rewritten");
    assert.equal(countLoads(bin), loadsBefore, "the guard is not loaded a second time");
  });

  it("--force is the only way to refresh a unit that drifted, and a stale unit is never loaded", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin);
    assert.equal(runGuardInstall(prefix, env).status, 0);
    const loadsAfterInstall = countLoads(bin);

    // Drift the unit *this platform loads* — the plist on macOS, the systemd unit on
    // Linux. The other one is written but never loaded, so it cannot make this case pass.
    const paths = guardPaths({ prefix, env });
    const unitPath = activeUnit(paths);
    const drift = PLATFORM === "darwin" ? "<plist/>\n" : "# drifted\n";
    const restored = PLATFORM === "darwin" ? /KeepAlive/ : /Restart=always/;
    writeFileSync(unitPath, drift, "utf8");

    // Merge, never clobber — and do *not* load what this run did not write: a stale
    // unit is typically a previous install pointing at a checkout that has moved.
    const stale = runGuardInstall(prefix, env);
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(readFileSync(unitPath, "utf8"), drift, "merge, never clobber");
    assert.match(stale.stdout, /taskd guard: not loaded — .*re-run with --force/);
    assert.equal(countLoads(bin), loadsAfterInstall, "a unit this run did not write is not loaded");

    const forced = runGuardInstall(prefix, env, ["--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(unitPath, "utf8"), restored, "--force refreshes the unit");
    // The supervisor already holds the job, so the refreshed unit is *not* re-loaded —
    // what matters is that the install is back to reporting the guard as live.
    assert.doesNotMatch(forced.stdout, /not loaded/);
    assert.match(forced.stdout, /taskd guard: (already loaded|enabled)/);
  });
});

// ---------------------------------------------------------------------------
// 3 — the enable plan, for both platforms (pure; testable on either)
// ---------------------------------------------------------------------------

describe("taskd guard: what makes the unit live", () => {
  it("launchd: bootstrap the gui domain, with `load -w` as the older fallback", () => {
    const plan = enablePlan({ platform: "darwin", uid: 501, launchdUnit: "/p/taskd.plist", systemdUnit: "/p/taskd.service" });
    assert.deepEqual(plan.commands, [{ command: "launchctl", args: ["bootstrap", "gui/501", "/p/taskd.plist"] }]);
    assert.deepEqual(plan.fallback, { command: "launchctl", args: ["load", "-w", "/p/taskd.plist"] });
    assert.deepEqual(plan.loadedProbe.args, ["print", "gui/501/com.meerkat-taskpanel.taskd"]);
    assert.deepEqual(plan.stop, ["launchctl bootout gui/501/com.meerkat-taskpanel.taskd", "rm /p/taskd.plist"]);
  });

  it("systemd: enable --now the user unit, from the directory systemd actually reads", () => {
    const plan = enablePlan({
      platform: "linux",
      uid: 501,
      home: "/home/op",
      env: {},
      launchdUnit: "/p/taskd.plist",
      systemdUnit: "/p/taskd.service",
    });
    assert.deepEqual(plan.commands, [{ command: "systemctl", args: ["--user", "enable", "--now", TASKD_UNIT] }]);
    assert.equal(plan.unitDir, "/home/op/.config/systemd/user");
    assert.deepEqual(plan.stop, [`systemctl --user disable --now ${TASKD_UNIT}`, `rm /home/op/.config/systemd/user/${TASKD_UNIT}`]);
  });

  it("systemd honours XDG_CONFIG_HOME, and a prefix never moves the unit systemd reads", () => {
    assert.equal(systemdUserDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/op"), "/xdg/systemd/user");
    // A relative XDG value is not a path systemd would use; fall back to ~/.config.
    assert.equal(systemdUserDir({ XDG_CONFIG_HOME: "relative" }, "/home/op"), "/home/op/.config/systemd/user");
  });

  it("a platform with no user service manager has no plan", () => {
    assert.equal(enablePlan({ platform: "win32", uid: null, launchdUnit: "a", systemdUnit: "b" }), null);
  });
});

// ---------------------------------------------------------------------------
// 4 — install.sh: written once, loaded once, and honest when it cannot load
// ---------------------------------------------------------------------------

describe("install.sh: the taskd guard", () => {
  it("writes both units and loads this platform's one, reporting the label and pid", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();

    const run = runGuardInstall(prefix, guardEnv(prefix, dataDir, bin));
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, new RegExp(`taskd guard: enabled \\(${TASKD_LABEL}, pid 4242\\)`));
    assert.match(run.stdout, /taskd guard: to stop and remove it:/);

    const paths = guardPaths({ prefix, env: guardEnv(prefix, dataDir, bin) });
    for (const file of [paths.launchdUnit, paths.systemdUnit]) {
      assert.ok(existsSync(file), `install must write ${file}`);
    }
    assert.equal(countLoads(bin), 1, "exactly one load");
    assert.ok(readFileSync(bin.log, "utf8").includes(expectedLoadLine(paths)), "loaded the way the contract says");
  });

  it("--dry-run changes nothing and says so", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin);

    const run = runInstall(["--target", "claude", "--prefix", prefix, "--dry-run"], env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /taskd guard: skipped \(dry-run\)/);
    assert.equal(existsSync(join(prefix, "taskpanel")), false, "dry run writes no unit");
    assert.equal(readFileSync(bin.log, "utf8"), "", "dry run loads nothing");
  });

  it("--no-automation skips it too, and so does the env form", () => {
    for (const [label, extra] of [
      ["flag", {}],
      ["env", { MEERKAT_TASKPANEL_NO_AUTOMATION: "1" }],
    ]) {
      const prefix = makeTempDir();
      const dataDir = makeTempDir();
      const bin = fakeManagerBin();
      const args = ["--target", "claude", "--prefix", prefix];
      if (label === "flag") args.push("--no-automation");

      const run = runInstall(args, guardEnv(prefix, dataDir, bin, extra));
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /taskd guard: skipped \(--no-automation\)/, `${label} form`);
      assert.equal(existsSync(join(prefix, "taskpanel")), false, `${label} form writes no unit`);
      assert.equal(readFileSync(bin.log, "utf8"), "", `${label} form loads nothing`);
    }
  });

  it("the test-only bypass skips it, and is named in the report", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();

    const run = runInstall(["--target", "claude", "--prefix", prefix], guardEnv(prefix, dataDir, bin, { MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1" }));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /taskd guard: skipped \(MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE=1 — tests only\)/);
    assert.equal(existsSync(join(prefix, "taskpanel")), false);
    assert.equal(readFileSync(bin.log, "utf8"), "", "nothing was loaded");
  });

  it("a supervisor that refuses is reported, not fatal: the units are still written", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin, { FAKE_FAIL: "1" });

    const run = runGuardInstall(prefix, env);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /taskd guard: installed \(com\.meerkat-taskpanel\.taskd\); not loaded — /);
    assert.match(run.stdout, /taskd guard: load it with: /);
    assert.doesNotMatch(run.stdout, /taskd guard: enabled/);

    const paths = guardPaths({ prefix, env });
    assert.ok(existsSync(paths.launchdUnit), "the plist is written even when loading fails");
    assert.ok(existsSync(paths.systemdUnit));
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run `install.sh` for one host into `prefix`, with the guard's paths isolated. */
function runGuardInstall(prefix, env, extra = []) {
  return runInstall(["--target", "claude", "--prefix", prefix, ...extra], env);
}

function runInstall(args, env) {
  return spawnSync("bash", [join(ROOT, "install.sh"), ...args], { cwd: ROOT, encoding: "utf8", env });
}

/** The environment a guard install runs under: a fake manager on PATH, a private log. */
function guardEnv(prefix, dataDir, bin, extra = {}) {
  return {
    ...process.env,
    MEERKAT_TASKPANEL_TARGET_HOME: prefix,
    HOME: prefix,
    TASKD_DATA_DIR: dataDir,
    FAKE_STATE: bin.state,
    FAKE_LOG: bin.log,
    PATH: `${bin.dir}:${process.env.PATH}`,
    ...extra,
  };
}

/**
 * A fake service manager — `launchctl` **and** `systemctl`, so the same case runs on
 * either platform — that records every call and answers the probes the guard makes.
 * `FAKE_FAIL=1` makes it refuse everything, which is how the "cannot load here" path
 * is reached without a machine that actually lacks a supervisor.
 */
function fakeManagerBin() {
  const dir = makeTempDir("meerkat-taskpanel-fakebin-");
  const state = join(dir, "loaded");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");

  const launchctl = [
    "#!/usr/bin/env bash",
    'printf "launchctl %s\\n" "$*" >> "$FAKE_LOG"',
    'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "fake launchctl: refusing" >&2; exit 1; fi',
    'case "$1" in',
    '  print) if [ -f "$FAKE_STATE" ]; then printf "\\tpid = 4242\\n"; exit 0; fi; exit 1 ;;',
    '  bootstrap|load) : > "$FAKE_STATE"; exit 0 ;;',
    '  bootout) rm -f "$FAKE_STATE"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const systemctl = [
    "#!/usr/bin/env bash",
    'printf "systemctl %s\\n" "$*" >> "$FAKE_LOG"',
    'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "fake systemctl: refusing" >&2; exit 1; fi',
    'case "$*" in',
    '  *is-active*) if [ -f "$FAKE_STATE" ]; then echo active; exit 0; fi; exit 3 ;;',
    "  *\"enable --now\"*) : > \"$FAKE_STATE\"; exit 0 ;;",
    '  *" show "*) if [ -f "$FAKE_STATE" ]; then echo 4242; else echo 0; fi; exit 0 ;;',
    '  *disable*) rm -f "$FAKE_STATE"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");

  for (const [name, body] of [["launchctl", launchctl], ["systemctl", systemctl]]) {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  }
  return { dir, state, log };
}

/** How many times the manager was asked to *load* (rather than probed). */
function countLoads(bin) {
  const lines = readFileSync(bin.log, "utf8").split("\n").filter(Boolean);
  return lines.filter((line) => /launchctl (bootstrap|load)|systemctl --user enable/.test(line)).length;
}

/** The unit this platform actually loads — the plist on macOS, the systemd unit on Linux. */
function activeUnit(paths) {
  return PLATFORM === "darwin" ? paths.launchdUnit : paths.systemdUnit;
}

/** The one line this platform's plan runs to load the unit. */
function expectedLoadLine(paths) {
  return PLATFORM === "darwin"
    ? `launchctl bootstrap gui/${UID} ${paths.launchdUnit}`
    : `systemctl --user enable --now ${TASKD_UNIT}`;
}
