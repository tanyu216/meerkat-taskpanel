/**
 * The `taskd` keepalive guard (T-20261013-213717-3, hardening T-20261014-052428).
 *
 * `taskctl` lazy-starts `taskd` only when a CLI call needs it, so a board whose server
 * dies while nobody is calling it stays down until the next call. The guard closes that
 * gap with the OS's own supervisor: one launchd plist / systemd user unit, written under
 * the install root `<prefix>/.meerkat-taskpanel/scheduling/` and **loaded at install time** —
 * the one explicit exception to this installer's "write the unit, never start a daemon"
 * rule (the contract is `docs/scheduling.md`, and it is the single source of truth for
 * the unit text below).
 *
 * Four things are held here:
 *
 *   1. the **unit templates** — committed under `scripts/install/templates/taskd/` — are
 *      the contract's own text, and are well-formed (plutil, where it exists);
 *   2. **rendering**: absolute `{{SERVER_ENTRY}}` / `{{LOG}}`, an **absolute interpreter**
 *      that never has to be found on the host's `PATH` (the exit-127 crash loop this card
 *      fixes), the operator's `TASKD_*` carried into the unit's environment, the log
 *      directory created, and idempotence (a re-install rewrites nothing, `--force` is
 *      the only overwrite);
 *   3. **readiness**: `enabled` is claimed only when the board answers `/health`, not when
 *      the supervisor merely hands back a pid — the distinction the crash loop hid behind;
 *   4. **install.sh**: the guard is written *and loaded* once per machine, the second
 *      install loads nothing a second time, and the boxed-in cases — `--dry-run`,
 *      `--no-automation`, the test-only bypass, and a supervisor that refuses — report
 *      themselves instead of failing the install.
 *
 * The service manager is **faked on PATH**, the way `scheduling-units.test.mjs` fakes a
 * agent CLI: an install must never load a real unit during a test run. The readiness probe
 * is answered by a **real loopback `/health` server in its own process** — `spawnSync`
 * blocks this one's event loop, so a server in-process could never reply.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

import { READY_TIMEOUT_MS, TASKD_LABEL, TASKD_TEMPLATE_FILES, TASKD_UNIT, enablePlan, exitCode, guardPaths, installGuard, isOurBoard, plistEnvBlock, servedBoard, systemdEnvBlock, systemdUserDir, unitBoard, unitEnv, unitPath, unitVars, waitForHealth } from "../../scripts/install/lib/taskd-guard.mjs";
import { render } from "../../scripts/install/lib/apply.mjs";
import { AUTOSTART_TIMEOUT_MS } from "../../src/foundation/constants.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-guard-", installDefaults: {} });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATES = join(ROOT, "scripts", "install", "templates");
const PLATFORM = process.platform;
const UID = process.getuid?.() ?? 0;
/** The pid the fake manager reports, and therefore the one a pointer must carry. */
const FAKE_PID = 4242;

const launchdTemplate = readFileSync(join(TEMPLATES, TASKD_TEMPLATE_FILES.launchd), "utf8");
const systemdTemplate = readFileSync(join(TEMPLATES, TASKD_TEMPLATE_FILES.systemd), "utf8");

const healthServers = [];

after(() => {
  cleanup();
  for (const child of healthServers) child.kill();
});

/** Literal text as a regular expression — temp paths may hold `.` and `-`. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** The plist without its XML comments — what launchd actually parses. */
function withoutXmlComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/** The systemd unit without its comment lines — what systemd actually parses. */
function withoutIniComments(ini) {
  return ini
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

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

  it("the rendered plist is well-formed, and plutil agrees where it exists", () => {
    // Rendered, not raw: `{{ENV_PLIST}}` expands to markup, so only the rendered document
    // is a plist at all. Both shapes are checked — the operator who isolated their board
    // (entries present) and the default install (the token expands to nothing, which must
    // still leave a parseable `<dict>`).
    for (const [label, env] of [
      ["no TASKD_* set", {}],
      ["TASKD_DATA_DIR + TASKD_RUNTIME_POINTER set", { TASKD_DATA_DIR: makeTempDir(), TASKD_RUNTIME_POINTER: join(makeTempDir(), "runtime.json") }],
    ]) {
      const paths = guardPaths({ prefix: makeTempDir(), env });
      const rendered = render(launchdTemplate, unitVars(paths));
      assert.doesNotMatch(rendered, /\{\{/, `${label}: every token is substituted`);
      assertWellFormedPlist(rendered);
      assert.match(rendered, new RegExp(`<string>${escapeRegExp(paths.serverEntry)}</string>`));

      // plutil ships with macOS; on Linux the structural check above is the equivalent
      // assertion the acceptance allows. Deliberately not a `skip`: a skipped case is a
      // case nobody reads.
      if (existsSync("/usr/bin/plutil")) {
        const file = join(makeTempDir(), `${TASKD_LABEL}.plist`);
        writeFileSync(file, rendered, "utf8");
        const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
        assert.equal(lint.status, 0, `${label}: ${lint.stdout}${lint.stderr}`);
        assert.match(lint.stdout, /OK/);
      }
    }
  });

  it("the plist carries the keepalive shape the contract fixes", () => {
    const text = launchdTemplate;
    assert.match(text, /<key>Label<\/key>\s*<string>com\.meerkat-taskpanel\.taskd<\/string>/);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(text, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    // The daemon writes and rotates taskd.log itself; a redirect into the same
    // file would duplicate every line.
    assert.doesNotMatch(text, /<key>StandardOutPath<\/key>/);
    assert.doesNotMatch(text, /<key>StandardErrorPath<\/key>/);
    // No scheduled tick: a long-running owner of the write lock, not an interval job.
    assert.doesNotMatch(text, /<key>(StartInterval|StartCalendarInterval)<\/key>/);

    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    assert.notEqual(args, null, "ProgramArguments must be an array");
    const argv = [...args[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    assert.deepEqual(argv, ["{{NODE}}", "{{SERVER_ENTRY}}"]);
  });

  it("neither unit starts the server through the host's PATH (the exit-127 crash loop)", () => {
    // The whole defect (T-20261014-052428): `/usr/bin/env node` is resolved against the
    // supervisor's PATH — launchd's is `/usr/bin:/bin:/usr/sbin:/sbin` — so a node that
    // lives only under nvm or Homebrew is not found, the job exits 127, and `KeepAlive`
    // turns that into an endless restart loop. The interpreter is named outright instead.
    // Checked on the *effective* files: both templates name `env node` in a comment, to
    // record what they must never go back to.
    assert.doesNotMatch(withoutXmlComments(launchdTemplate), /\/usr\/bin\/env/);
    assert.doesNotMatch(withoutIniComments(systemdTemplate), /\/usr\/bin\/env/);
    assert.match(withoutXmlComments(launchdTemplate), /<string>\{\{NODE\}\}<\/string>/);
    assert.match(withoutIniComments(systemdTemplate), /^ExecStart=\{\{NODE\}\} \{\{SERVER_ENTRY\}\}$/m);

    // launchd's PATH is the minimal default launchd gives a job, with node's own
    // directory in front — so a *child* that looks `node` up by name finds it too. The
    // token is the whole PATH, so the default cannot be dropped by accident.
    assert.match(launchdTemplate, /<key>PATH<\/key>\s*<string>\{\{PATH\}\}<\/string>/);
  });

  it("the systemd unit carries the restart + back-off shape the contract fixes", () => {
    const text = systemdTemplate;
    assert.match(text, /\[Unit\]/);
    assert.match(text, /Description=Meerkat TaskPanel taskd \(board server\) guard/);
    assert.match(text, /\[Service\]/);
    assert.match(text, /Type=simple/);
    assert.match(text, /Restart=always/);
    assert.match(text, /RestartSec=5/);
    // The application owns its log file (and its rotation).
    assert.doesNotMatch(text, /^StandardOutput=/m);
    assert.doesNotMatch(text, /^StandardError=/m);
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
    // `TASKD_DATA_DIR` / `TASKD_RUNTIME_POINTER` are the opposite case — the unit must
    // carry those, or it guards a board nobody installed — and they arrive through the
    // `{{ENV_PLIST}}` / `{{ENV_SYSTEMD}}` tokens, never as literals here.
    for (const [name, text] of [["launchd", launchdTemplate], ["systemd", systemdTemplate]]) {
      assert.doesNotMatch(text, /TASKD_NO_AUTOSTART/, `${name} must not set TASKD_NO_AUTOSTART`);
      assert.doesNotMatch(text, /TASKD_PORT/, `${name} must not set TASKD_PORT`);
    }
  });

  it("the label and unit name carry no agent or actor-kind segment (one guard per machine)", () => {
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
// 2 — rendering: absolute paths, the unit's own environment, idempotence
// ---------------------------------------------------------------------------

describe("taskd guard: rendering", () => {
  it("lands under the install root, never in a stray <prefix>/taskpanel or an agent kind's tree", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const paths = guardPaths({ prefix, env: { TASKD_DATA_DIR: dataDir } });

    assert.equal(paths.launchdUnit, join(prefix, ".meerkat-taskpanel", "scheduling", "launchd", `${TASKD_LABEL}.plist`));
    assert.equal(paths.systemdUnit, join(prefix, ".meerkat-taskpanel", "scheduling", "systemd", TASKD_UNIT));
    assert.ok(!paths.launchdUnit.includes(join(prefix, "taskpanel")), "no stray <prefix>/taskpanel directory");
    assert.equal(paths.serverEntry, join(ROOT, "src", "server", "main.mjs"));
    assert.equal(paths.logFile, join(dataDir, "logs", "taskd.log"));
    for (const agentDir of [".claude", ".codex", ".openclaw", ".agents"]) {
      assert.ok(!paths.launchdUnit.includes(join(prefix, agentDir)), `never under ${agentDir}/`);
    }
  });

  it("points at the installed tree and pins its data dir when asked", () => {
    const prefix = makeTempDir();
    const tree = makeTempDir();
    const dataDir = join(tree, ".data");
    const paths = guardPaths({ prefix, root: tree, dataDir });

    assert.equal(paths.serverEntry, join(tree, "src", "server", "main.mjs"));
    assert.equal(paths.logFile, join(dataDir, "logs", "taskd.log"));
    assert.equal(paths.pinDataDir, true);
    assert.match(unitVars(paths).ENV_SYSTEMD, new RegExp(`TASKD_DATA_DIR=${escapeRegExp(dataDir)}`));

    // The default guard is still unpinned and names this checkout.
    const plain = guardPaths({ prefix, env: {} });
    assert.equal(plain.pinDataDir, false);
    assert.equal(plain.serverEntry, join(ROOT, "src", "server", "main.mjs"));
    assert.deepEqual(unitEnv({ env: {}, dataDir: plain.dataDir, pinDataDir: plain.pinDataDir }), []);
  });

  it("the interpreter is this node, absolute — not a name to be looked up", () => {
    const paths = guardPaths({ prefix: makeTempDir(), env: {} });
    assert.equal(paths.node, resolve(process.execPath));
    assert.equal(paths.nodeDir, dirname(resolve(process.execPath)));
    assert.ok(isAbsolute(paths.node));

    // The PATH the plist exports is `node`'s own directory followed by launchd's
    // documented default — so the job can find its interpreter *and* a child that
    // looks `node` up by name still gets the same one.
    assert.equal(unitPath(paths.nodeDir), `${paths.nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`);
    const first = unitPath(paths.nodeDir).split(":")[0];
    assert.equal(first, dirname(paths.node));
  });

  it("carries TASKD_DATA_DIR / TASKD_RUNTIME_POINTER only when the operator set them", () => {
    // Unset: nothing to inject, so a default install's unit stays minimal (and stable
    // across machines, which is what keeps re-installs byte-identical).
    const dataDir = makeTempDir();
    assert.deepEqual(unitEnv({ env: {} }), []);
    assert.equal(plistEnvBlock([]), "");
    assert.equal(systemdEnvBlock([]), "");

    // Set: absolute, in a stable order, and **not** the two client-only variables.
    const pointer = join(makeTempDir(), "runtime.json");
    const env = { TASKD_DATA_DIR: dataDir, TASKD_RUNTIME_POINTER: pointer, TASKD_PORT: "29527", TASKD_NO_AUTOSTART: "1" };
    assert.deepEqual(unitEnv({ env }), [
      ["TASKD_DATA_DIR", resolve(dataDir)],
      ["TASKD_RUNTIME_POINTER", resolve(pointer)],
    ]);
  });

  it("escapes what both file formats give meaning to", () => {
    // A path may legitimately hold `&`. Unescaped it makes the plist unparseable —
    // and the escape is asserted, not assumed, because `plutil` is not on every host.
    const plist = plistEnvBlock([["TASKD_DATA_DIR", "/tmp/a&b<c>/d"]]);
    assert.match(plist, /<string>\/tmp\/a&amp;b&lt;c&gt;\/d<\/string>/);

    // systemd splits an unquoted Environment= value on whitespace, so a path with a
    // space has to arrive quoted or systemd rejects the whole unit.
    assert.equal(systemdEnvBlock([["TASKD_DATA_DIR", "/tmp/board-data"]]), "Environment=TASKD_DATA_DIR=/tmp/board-data");
    assert.equal(systemdEnvBlock([["TASKD_DATA_DIR", "/tmp/board data"]]), 'Environment=TASKD_DATA_DIR="/tmp/board data"');
  });

  it("substitutes every placeholder, and creates the log directory launchd will not", async () => {
    const install = await readyInstall();

    const first = install.run();
    assert.equal(first.status, 0, first.stderr);

    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    for (const file of [paths.launchdUnit, paths.systemdUnit]) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /\{\{/, `${file} still has a template token`);
      assert.ok(text.includes(paths.serverEntry), `${file} must name the absolute server entry`);
      assert.ok(text.includes(paths.logFile), `${file} must name the absolute log file`);
      assert.ok(text.includes(paths.node), `${file} must name the absolute interpreter`);
      assert.ok(text.includes(paths.nodeDir), `${file} must put node's directory on PATH`);
    }

    // launchd will not create a missing StandardOutPath directory, so the installer
    // must — otherwise the job starts and cannot log.
    assert.ok(statSync(join(install.dataDir, "logs")).isDirectory(), "the log directory must exist");
  });

  it("the rendered plist runs the absolute interpreter, with an absolute PATH that has node", async () => {
    const install = await readyInstall();
    assert.equal(install.run().status, 0);

    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    const text = readFileSync(paths.launchdUnit, "utf8");
    assertWellFormedPlist(text);
    assert.doesNotMatch(withoutXmlComments(text), /\/usr\/bin\/env/);

    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    const argv = [...args[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    assert.equal(argv.length, 2);
    assert.equal(argv[0], resolve(process.execPath), "the interpreter is the node that rendered it");
    assert.ok(isAbsolute(argv[0]) && existsSync(argv[0]), `${argv[0]} must be an absolute, existing node`);
    assert.match(basename(argv[0]), /^node/);
    assert.equal(argv[1], paths.serverEntry);

    const exported = /<key>PATH<\/key>\s*<string>(.*?)<\/string>/.exec(text)?.[1];
    assert.equal(exported, `${paths.nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`);

    // The operator's data directory is carried into the unit, or the guard would serve
    // a different board than the one that was installed.
    assert.match(text, new RegExp(`<key>TASKD_DATA_DIR</key>\\s*<string>${escapeRegExp(paths.dataDir)}</string>`));
  });

  it("the rendered systemd unit runs the absolute interpreter and carries the environment", async () => {
    const install = await readyInstall();
    assert.equal(install.run().status, 0);

    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    const text = readFileSync(paths.systemdUnit, "utf8");
    assert.doesNotMatch(text, /\{\{/);
    assert.match(text, new RegExp(`^ExecStart=${escapeRegExp(resolve(process.execPath))} `, "m"));
    assert.match(text, new RegExp(`^Environment=TASKD_DATA_DIR=${escapeRegExp(paths.dataDir)}$`, "m"));
    assert.match(text, new RegExp(`^Environment=TASKD_RUNTIME_POINTER=`, "m"));
    assert.doesNotMatch(text, /TASKD_NO_AUTOSTART|TASKD_PORT/);
  });

  it("is idempotent: a re-install rewrites nothing, and does not load a second time", async () => {
    const install = await readyInstall();

    const first = install.run();
    assert.equal(first.status, 0, first.stderr);
    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    const before = { plist: readFileSync(paths.launchdUnit, "utf8"), unit: readFileSync(paths.systemdUnit, "utf8") };
    const loadsBefore = countLoads(install.bin);

    const again = install.run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /taskd guard: already loaded \(no change\)/);
    assert.equal(readFileSync(paths.launchdUnit, "utf8"), before.plist, "the plist is not rewritten");
    assert.equal(readFileSync(paths.systemdUnit, "utf8"), before.unit, "the unit is not rewritten");
    assert.equal(countLoads(install.bin), loadsBefore, "the guard is not loaded a second time");
  });

  it("--force is the only way to refresh a unit that drifted, and a stale unit is never loaded", async () => {
    const install = await readyInstall();
    assert.equal(install.run().status, 0);
    const loadsAfterInstall = countLoads(install.bin);

    // Drift the unit *this platform loads* — the plist on macOS, the systemd unit on
    // Linux. The other one is written but never loaded, so it cannot make this case pass.
    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    const unitPath = activeUnit(paths);
    const drift = PLATFORM === "darwin" ? "<plist/>\n" : "# drifted\n";
    const restored = PLATFORM === "darwin" ? /KeepAlive/ : /Restart=always/;
    writeFileSync(unitPath, drift, "utf8");

    // Merge, never clobber — and do *not* load what this run did not write: a stale
    // unit is typically a previous install pointing at a checkout that has moved.
    const stale = install.run();
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(readFileSync(unitPath, "utf8"), drift, "merge, never clobber");
    assert.match(stale.stdout, /taskd guard: not loaded — .*re-run with --force/);
    assert.equal(countLoads(install.bin), loadsAfterInstall, "a unit this run did not write is not loaded");

    const forced = install.run(["--force"]);
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
// 4 — readiness: `enabled` means `/health` answers, not "a pid exists"
// ---------------------------------------------------------------------------

describe("taskd guard: readiness", () => {
  const pointer = (over = {}) => ({ url: "http://127.0.0.1:9527", pid: FAKE_PID, dataDir: "/data", ...over });

  it("waits longer than the CLI's lazy start, on purpose", () => {
    // Not a style preference. `AUTOSTART_TIMEOUT_MS` bounds a *call*; this bounds the last
    // step of an *install*, and the two errors are not symmetric — a healthy board that is
    // merely slow must not be reported the same way as the crash loop this gate exists to
    // expose. A first spawn under load was measured at ~5.5s during this card's own
    // real-machine run, which is exactly the budget that would have misreported it.
    assert.ok(READY_TIMEOUT_MS > AUTOSTART_TIMEOUT_MS, `${READY_TIMEOUT_MS} must exceed ${AUTOSTART_TIMEOUT_MS}`);
  });

  it("a pointer is ours when the pid and the data directory agree", () => {
    assert.equal(isOurBoard(pointer(), { pid: FAKE_PID, dataDir: "/data" }), true);
    // A *different* pid is a different board: the stale pointer the old daemon left, or
    // another board's address entirely. Neither is this unit's readiness.
    assert.equal(isOurBoard(pointer({ pid: 12 }), { pid: FAKE_PID, dataDir: "/data" }), false);
    assert.equal(isOurBoard(pointer({ dataDir: "/other" }), { pid: FAKE_PID, dataDir: "/data" }), false);
    // A pointer that names no owner protects nobody, so an absent pid/dataDir is not a
    // mismatch — the `/health` knock is what decides.
    assert.equal(isOurBoard({ url: "http://x" }, { pid: FAKE_PID, dataDir: "/data" }), true);
    assert.equal(isOurBoard({ pid: FAKE_PID }, { pid: FAKE_PID }), false, "no url, nothing to knock on");
    assert.equal(isOurBoard(null, {}), false);
  });

  it("waits for the pointer to appear, then for /health — and the pid must match", async () => {
    const calls = [];
    const probe = async (url) => {
      calls.push(url);
      return url === "http://127.0.0.1:9527";
    };
    let reads = 0;
    const readPointerFn = () => {
      reads += 1;
      if (reads === 1) return null; // the server has not written it yet
      if (reads === 2) return pointer({ pid: 999 }); // someone else's, still starting
      return pointer();
    };

    const result = await waitForHealth({
      pointers: ["/p/runtime.json"],
      dataDir: "/data",
      pid: FAKE_PID,
      timeoutMs: 1_000,
      pollMs: 1,
      probe,
      readPointerFn,
      sleep: async () => {},
    });

    assert.deepEqual(result, { ready: true, url: "http://127.0.0.1:9527", pid: FAKE_PID, path: "/p/runtime.json" });
    assert.deepEqual(calls, ["http://127.0.0.1:9527"], "the foreign pointer is never knocked on");
    assert.equal(reads, 3);
  });

  it("asks the second pointer too — a board beside its own data directory is still ours", async () => {
    const wanted = { url: "http://127.0.0.1:9600", pid: FAKE_PID, dataDir: "/data" };
    const result = await waitForHealth({
      pointers: ["/machine-wide.json", "/data/runtime.json"],
      dataDir: "/data",
      pid: FAKE_PID,
      timeoutMs: 1_000,
      pollMs: 1,
      probe: async () => true,
      readPointerFn: ({ path }) => (path === "/data/runtime.json" ? wanted : null),
      sleep: async () => {},
    });
    assert.equal(result.ready, true);
    assert.equal(result.path, "/data/runtime.json");
  });

  it("times out honestly when nothing ever answers", async () => {
    let clock = 0;
    const result = await waitForHealth({
      pointers: ["/p/runtime.json"],
      pid: FAKE_PID,
      timeoutMs: 30,
      pollMs: 10,
      probe: async () => false,
      readPointerFn: () => pointer(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    assert.equal(result.ready, false);
    // The URL it last saw is reported: "loaded, and here is the address that did not
    // answer" is what an operator can act on.
    assert.equal(result.url, "http://127.0.0.1:9527");
  });

  it("never throws when a probe blows up", async () => {
    // A probe that rejects would otherwise take the whole install down with it — and an
    // install that dies mid-way is worse than one that reports an unready guard.
    const result = await waitForHealth({
      pointers: ["/p/runtime.json"],
      pid: FAKE_PID,
      timeoutMs: 0,
      probe: async () => {
        throw new Error("connection reset");
      },
      readPointerFn: () => pointer(),
      sleep: async () => {},
    });
    assert.equal(result.ready, false);
    assert.equal(result.url, "http://127.0.0.1:9527", "the address that failed is still reported");
  });
});

// ---------------------------------------------------------------------------
// 5 — install.sh: written once, loaded once, and honest when it cannot serve
// ---------------------------------------------------------------------------

describe("install.sh: the taskd guard", () => {
  it("writes both units and loads this platform's one, reporting the label and pid", async () => {
    const install = await readyInstall();

    const run = install.run();
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, new RegExp(`taskd guard: enabled \\(${TASKD_LABEL}, pid ${FAKE_PID}\\)`));
    assert.match(run.stdout, /taskd guard: to stop and remove it:/);

    const paths = guardPaths({ prefix: install.prefix, env: install.env });
    for (const file of [paths.launchdUnit, paths.systemdUnit]) {
      assert.ok(existsSync(file), `install must write ${file}`);
    }
    assert.equal(countLoads(install.bin), 1, "exactly one load");
    assert.ok(readFileSync(install.bin.log, "utf8").includes(expectedLoadLine(paths)), "loaded the way the contract says");
  });

  it("reports a loaded-but-not-serving unit as loaded, never as enabled", async () => {
    // The defect this hardening closes: `launchctl print` answers a pid for a job that
    // has already died (the exit-127 loop), and the old report called that `enabled`.
    // With nothing writing a pointer, no board can answer /health — so the honest line
    // is `loaded`, with the log to read, and `enabled` must not appear at all.
    // This walks the whole budget (`READY_TIMEOUT_MS`), which is the point: the wait is
    // what makes the difference between the two lines observable.
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin);

    const run = runGuardInstall(prefix, env);
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, new RegExp(`taskd guard: loaded \\(${TASKD_LABEL}, pid ${FAKE_PID}\\)`));
    assert.match(run.stdout, new RegExp(`/health did not answer within ${READY_TIMEOUT_MS}ms — read .*logs[/\\\\]taskd\\.log`));
    assert.doesNotMatch(run.stdout, /taskd guard: enabled/);
    // Still a real load, and still the undo commands: the unit *is* installed.
    assert.equal(countLoads(bin), 1);
    assert.match(run.stdout, /taskd guard: to stop and remove it:/);
  });

  it("--dry-run changes nothing and says so", () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const bin = fakeManagerBin();
    const env = guardEnv(prefix, dataDir, bin);

    const run = runInstall(["--target", "claude", "--prefix", prefix, "--dry-run"], env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /taskd guard: skipped \(dry-run\)/);
    assert.equal(existsSync(join(prefix, ".meerkat-taskpanel")), false, "dry run writes no unit");
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
      assert.equal(existsSync(join(prefix, ".meerkat-taskpanel")), false, `${label} form writes no unit`);
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
    assert.equal(existsSync(join(prefix, ".meerkat-taskpanel")), false);
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
// 6 — the machine's one guard: a second board refuses, it never clobbers (F1/F2)
// ---------------------------------------------------------------------------

/**
 * The two defects this block pins, both from `T-20261014-063205` §2.2 (a probe that
 * ran an install twice against one fake machine):
 *
 *   **F1** — a second install copied its unit over `~/.config/systemd/user/<TASKD_UNIT>`
 *   *before* asking whether the guard was loaded, so the machine's **only** guard was
 *   re-pointed at the second board, silently, with the change showing only at the next
 *   reload. The file systemd reads is the guard's definition; it must not be rewritten
 *   out from under a loaded guard that serves a different board.
 *
 *   **F2** — the report said `already loaded (no change)` in that case, which reads as
 *   "your board is guarded" when the loaded guard served another one. The board is now
 *   named — this one, another one, or "could not be read".
 *
 * The platform is passed explicitly (the `test/install/supervisor-*` precedent), so the
 * Linux-only refusal is exercised on the host that runs the suite, macOS included.
 */
describe("taskd guard: one guard per machine (F1/F2)", () => {
  /** A `spawnSync`-shaped service manager, loaded, answering either platform's probes. */
  function loadedManager({ pid = 9001 } = {}) {
    const calls = [];
    return {
      calls,
      loads: () => calls.filter((line) => /enable --now|launchctl (bootstrap|load)/.test(line)).length,
      run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "launchctl") return { status: 0, stdout: `\tpid = ${pid}\n`, stderr: "" };
        if (args.includes("is-active")) return { status: 0, stdout: "active\n", stderr: "" };
        if (args.includes("show")) return { status: 0, stdout: `${pid}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
  }

  /**
   * A machine whose guard is installed and loaded **for `board`**, plus a second install
   * pointed at `mine` — the two boards of the F1 scenario, with nothing real touched:
   * a throwaway `HOME` (so `~/.config/systemd/user/` is a temp dir), a throwaway pointer
   * file, and a fake manager. The guard's pid is `9001`, which is also the pid the default
   * pointer carries — the healthy case, where the pointer confirms the board the unit
   * names rather than contradicting it.
   */
  function machine({ board, mine, force = false, platform = "linux", readPointerFn = null, healthProbe = null, pid = 9001 } = {}) {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const unitDir = systemdUserDir({}, home);
    mkdirSync(unitDir, { recursive: true });

    // Board A's unit, rendered by the same code path a real install uses — so the
    // comparison under test is between two authentic units, not a hand-written string.
    const installed = join(unitDir, TASKD_UNIT);
    writeFileSync(installed, render(systemdTemplate, unitVars(guardPaths({ prefix: home, env: { TASKD_DATA_DIR: board } }))), "utf8");

    const runner = loadedManager({ pid });
    const lines = [];
    return {
      home,
      dataDir,
      installed,
      runner,
      lines,
      read: () => readFileSync(installed, "utf8"),
      run: async () =>
        installGuard({
          prefix: home,
          platform,
          home,
          force,
          env: { TASKD_DATA_DIR: mine, TASKD_RUNTIME_POINTER: join(dataDir, "runtime.json") },
          runner: runner.run,
          log: (line) => lines.push(line),
          pidWaitMs: 20,
          healthWaitMs: 20,
          healthPollMs: 5,
          healthProbe: healthProbe ?? (async () => true),
          readPointerFn: readPointerFn ?? (() => ({ url: "http://127.0.0.1:9527", pid, dataDir: mine })),
        }),
    };
  }

  it("refuses to re-point a loaded guard at a second board, and leaves its unit alone", async () => {
    const boardA = makeTempDir();
    const boardB = makeTempDir();
    const m = machine({ board: boardA, mine: boardB });
    const before = m.read();

    const report = await m.run();

    // The unit systemd would read is byte-for-byte the one the first install wrote.
    // This is the F1 defect's own assertion: before the fix it held board B here.
    assert.equal(m.read(), before, "the machine's guard unit must not be rewritten");
    assert.equal(unitBoard(m.read()), resolve(boardA), "and it still pins the first board");

    assert.equal(report.state, "occupied");
    assert.match(report.reason, /another board/);
    const out = m.lines.join("\n");
    assert.match(out, /taskd guard: refused — .*already loaded and serves another board \(/);
    assert.ok(out.includes(boardA), `the refusal names the board that owns it:\n${out}`);
    assert.match(out, /re-run with --force to point it at /);
    assert.ok(out.includes(boardB), `and the board it was asked for:\n${out}`);
    assert.equal(m.runner.loads(), 0, "nothing was loaded, enabled or re-enabled");
    assert.equal(exitCode(report), 3, "a refusal has a code of its own");
  });

  it("serves this board when the loaded guard is already the one that was asked for", async () => {
    const boardA = makeTempDir();
    const m = machine({ board: boardA, mine: boardA });

    const report = await m.run();

    assert.equal(report.state, "already");
    assert.equal(exitCode(report), 0, "the same board is not a refusal");
    const out = m.lines.join("\n");
    // F2: the board is named, rather than a bare `already loaded (no change)` that
    // reads the same whether or not the guard is this board's.
    assert.match(out, /taskd guard: already loaded \(no change\) — the machine's guard serves this board \(/);
    assert.ok(out.includes(resolve(boardA)), out);
    assert.doesNotMatch(out, /another board/);
    assert.equal(unitBoard(m.read()), resolve(boardA), "the unit is left as the first install wrote it");
    assert.equal(m.runner.loads(), 0, "and nothing is loaded a second time");
  });

  it("names the other board in the report even where nothing is written over (macOS)", async () => {
    // No `unitDir` on launchd, so there is nothing to refuse — but the honest answer is
    // still "that guard is not yours", which is exactly the reading F2 was about. The
    // evidence here is the board's own pointer, carrying the guard's pid.
    const boardA = makeTempDir();
    const boardB = makeTempDir();
    const m = machine({
      board: boardA,
      mine: boardB,
      platform: "darwin",
      readPointerFn: () => ({ url: "http://127.0.0.1:9527", pid: 9001, dataDir: boardA }),
    });

    const report = await m.run();

    assert.notEqual(report.state, "occupied", "nothing is overwritten on launchd, so nothing is refused");
    const out = m.lines.join("\n");
    assert.match(out, /taskd guard: already loaded \(no change\) — the machine's guard serves another board \(/);
    assert.ok(out.includes(boardA), out);
    assert.ok(out.includes(boardB), `the line also names the board that is not guarded:\n${out}`);
  });

  it("says the board could not be read, rather than passing it off as a plain no-change", async () => {
    const boardA = makeTempDir();
    // No unit file to read (launchd) and no pointer naming the guard's pid: neither
    // source can answer, which is reported as exactly that.
    const m = machine({ board: boardA, mine: boardA, platform: "darwin", readPointerFn: () => null });

    await m.run();

    const out = m.lines.join("\n");
    assert.match(out, /taskd guard: already loaded \(no change\) — which board it serves could not be read here/);
  });

  it("--force is the deliberate way to re-point it, and then the unit does change", async () => {
    const boardA = makeTempDir();
    const boardB = makeTempDir();
    const m = machine({ board: boardA, mine: boardB, force: true });

    const report = await m.run();

    assert.notEqual(report.state, "occupied");
    assert.equal(exitCode(report), 0);
    assert.equal(unitBoard(m.read()), resolve(boardB), "--force re-points the guard");
    const out = m.lines.join("\n");
    assert.doesNotMatch(out, /refused/);
    // The file now names this board, but the job is still the one that was already
    // running — which is a thing the operator has to know, so the line says it.
    assert.match(out, /still serves .* until it is reloaded/);
    assert.ok(out.includes(resolve(boardA)) && out.includes(resolve(boardB)), out);
  });

  it("reads the pinned board out of either unit format", () => {
    const dataDir = makeTempDir();
    const paths = guardPaths({ prefix: makeTempDir(), env: { TASKD_DATA_DIR: dataDir, TASKD_RUNTIME_POINTER: join(dataDir, "runtime.json") } });
    const vars = unitVars(paths);

    assert.equal(unitBoard(render(systemdTemplate, vars)), resolve(dataDir));
    assert.equal(unitBoard(render(launchdTemplate, vars)), resolve(dataDir));

    // Unpinned is its own answer — the board `resolveDataDir` resolves at the unit's
    // start — and never confused with "could not be read".
    assert.equal(unitBoard(render(systemdTemplate, unitVars(guardPaths({ prefix: makeTempDir(), env: {} })))), null);
    // A name in a comment is not a directive systemd reads.
    assert.equal(unitBoard("# Environment=TASKD_DATA_DIR=/tmp/ignored\n"), null);
  });

  it("takes the unit as the authority, and only falls back to a pointer that names the guard's pid", () => {
    const dataDir = makeTempDir();
    const unitFile = join(makeTempDir(), TASKD_UNIT);
    writeFileSync(unitFile, render(systemdTemplate, unitVars(guardPaths({ prefix: makeTempDir(), env: { TASKD_DATA_DIR: dataDir } }))), "utf8");

    const pointer = { pid: 9001, dataDir: "/other" };
    const read = () => pointer;

    // The unit answers on its own: the file systemd reads defines the guard.
    assert.deepEqual(servedBoard({ unitFile, pid: 9001, readPointerFn: read }), { dataDir: resolve(dataDir), source: "unit" });
    // No unit (launchd): the pointer decides — but only when it carries *this* pid.
    assert.deepEqual(servedBoard({ pointers: ["/p"], pid: 9001, readPointerFn: read }), { dataDir: "/other", source: "pointer" });
    assert.equal(servedBoard({ pointers: ["/p"], pid: 4242, readPointerFn: read }), null, "another process's pointer says nothing");
    assert.equal(servedBoard({ pointers: ["/p"], pid: 9001, readPointerFn: () => null }), null, "no pointer, no guess");
    // A file that is not there is not a board.
    assert.deepEqual(servedBoard({ unitFile: "/nowhere", pointers: ["/p"], pid: 9001, readPointerFn: read }), { dataDir: "/other", source: "pointer" });
  });
});

// ---------------------------------------------------------------------------
// 7 — installGuard in-process: the readiness gate without a real supervisor
// ---------------------------------------------------------------------------

describe("taskd guard: the readiness gate", () => {
  /** A `spawnSync`-shaped fake of the platform's service manager. */
  function fakeRunner(options = {}) {
    const state = { loaded: Boolean(options.already), loads: 0 };
    return {
      state,
      run(command, args) {
        const line = `${command} ${args.join(" ")}`;
        if (options.fail) return { status: 1, stdout: "", stderr: "refusing" };
        if (/\b(bootstrap|load|enable)\b/.test(line)) {
          state.loads += 1;
          state.loaded = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (command === "launchctl") {
          return state.loaded ? { status: 0, stdout: `\tpid = ${FAKE_PID}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "not found" };
        }
        if (args.includes("is-active")) return state.loaded ? { status: 0, stdout: "active\n", stderr: "" } : { status: 3, stdout: "inactive\n", stderr: "" };
        return { status: 0, stdout: `${state.loaded ? FAKE_PID : 0}\n`, stderr: "" };
      },
    };
  }

  /** An install whose guard runs in-process, so the probe and the clock are ours. */
  async function guardRun({ ready = true, healthWaitMs = 200 } = {}) {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const lines = [];
    const runner = fakeRunner();
    const report = await installGuard({
      prefix,
      platform: "darwin",
      uid: 501,
      home: prefix,
      env: { ...process.env, TASKD_DATA_DIR: dataDir },
      runner: runner.run,
      log: (line) => lines.push(line),
      pidWaitMs: 20,
      healthWaitMs,
      healthPollMs: 5,
      // The pointer appears only once the supervisor has loaded the job — the same
      // order a real start follows. A pointer that exists *before* the load is the
      // "a board is already running" case the guard must not load over.
      readPointerFn: () => (runner.state.loaded ? { url: "http://127.0.0.1:9527", pid: FAKE_PID, dataDir } : null),
      healthProbe: async () => ready,
    });
    return { report, lines, runner, prefix, dataDir };
  }

  it("reports enabled, with the url, when the board answers /health", async () => {
    const { report, lines, runner } = await guardRun({ ready: true });
    assert.equal(report.state, "enabled");
    assert.equal(report.ready, true);
    assert.equal(report.url, "http://127.0.0.1:9527");
    assert.equal(report.pid, FAKE_PID);
    assert.equal(runner.state.loads, 1);
    assert.ok(lines.some((line) => line === `taskd guard: enabled (${TASKD_LABEL}, pid ${FAKE_PID})`), lines.join("\n"));
  });

  it("does not start a second board when one is already serving /health", async () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const lines = [];
    const runner = fakeRunner();
    const report = await installGuard({
      prefix,
      platform: "darwin",
      uid: 501,
      home: prefix,
      env: { ...process.env, TASKD_DATA_DIR: dataDir },
      runner: runner.run,
      log: (line) => lines.push(line),
      pidWaitMs: 20,
      healthWaitMs: 20,
      healthPollMs: 5,
      readPointerFn: () => ({ url: "http://127.0.0.1:9527", pid: 777, dataDir: makeTempDir() }),
      healthProbe: async () => true,
    });

    assert.equal(report.state, "running");
    assert.equal(report.url, "http://127.0.0.1:9527");
    assert.equal(report.pid, null, "no guard pid was claimed");
    assert.equal(runner.state.loads, 0, "the loaded board is left alone — nothing new was started");
    assert.ok(
      lines.some((line) => /already serving .*9527/.test(line) && /stop it and re-run/.test(line)),
      lines.join("\n"),
    );
  });

  it("reports loaded, unready, when the supervisor answers but /health does not", async () => {
    const { report, lines } = await guardRun({ ready: false });
    assert.equal(report.state, "unready");
    assert.equal(report.ready, false);
    assert.equal(report.pid, FAKE_PID, "the pid is still reported — that much is true");
    assert.ok(!lines.includes(`taskd guard: enabled (${TASKD_LABEL}, pid ${FAKE_PID})`), lines.join("\n"));
    assert.ok(lines.some((line) => /^taskd guard: loaded \(.*\); \/health did not answer/.test(line)), lines.join("\n"));
  });

  it("does not claim the guard is live when the supervisor refuses to load it", async () => {
    const prefix = makeTempDir();
    const dataDir = makeTempDir();
    const lines = [];
    const runner = fakeRunner({ fail: true });
    const report = await installGuard({
      prefix,
      platform: "darwin",
      uid: 501,
      home: prefix,
      env: { ...process.env, TASKD_DATA_DIR: dataDir },
      runner: runner.run,
      log: (line) => lines.push(line),
      pidWaitMs: 20,
      healthWaitMs: 20,
      healthPollMs: 5,
      readPointerFn: () => null,
    });
    assert.equal(report.state, "manual");
    assert.equal(report.ready, false);
    assert.doesNotMatch(lines.join("\n"), /enabled/);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run `install.sh` for one agent kind into `prefix`, with the guard's paths isolated. */
function runGuardInstall(prefix, env, extra = []) {
  return runInstall(["--target", "claude", "--prefix", prefix, ...extra], env);
}

/**
 * The environment a guard install runs under: a fake manager on PATH, a private log,
 * and — because the guard now reads the board's real address — an isolated runtime
 * pointer inside the throwaway data directory.
 */
function guardEnv(prefix, dataDir, bin, extra = {}) {
  return {
    ...process.env,
    MEERKAT_TASKPANEL_TARGET_HOME: prefix,
    HOME: prefix,
    TASKD_DATA_DIR: dataDir,
    TASKD_RUNTIME_POINTER: join(dataDir, "runtime.json"),
    FAKE_STATE: bin.state,
    FAKE_LOG: bin.log,
    PATH: `${bin.dir}:${process.env.PATH}`,
    ...extra,
  };
}

/**
 * An isolated install that can actually become **ready**: the fake manager, a throwaway
 * prefix and data directory, and a live loopback `/health` server whose address is
 * written into the pointer the guard reads (with the pid the fake manager reports).
 *
 * Call it from an `async` test: the server is a child process because `spawnSync` — how
 * the installer is run — blocks this process's event loop, so an in-process server could
 * never answer the guard's probe.
 */
async function readyInstall(extra = {}) {
  const prefix = makeTempDir();
  const dataDir = makeTempDir();
  const bin = fakeManagerBin();
  const server = await startHealthServer();

  // The pointer is written by the *loaded board*, not before it: a pointer that exists
  // before the load means a board is already running, and the guard must not start a
  // second one over it. The fake manager writes it on load, which is the real order.
  const env = guardEnv(prefix, dataDir, bin, {
    FAKE_POINTER: join(dataDir, "runtime.json"),
    FAKE_POINTER_URL: server.url,
    FAKE_DATA_DIR: dataDir,
    ...extra,
  });
  return { prefix, dataDir, bin, server, env, run: (argv = []) => runGuardInstall(prefix, env, argv) };
}

/** A minimal `/health` server in its own process; prints its port, then serves. */
async function startHealthServer() {
  const script = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { status: "ok" } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
  `;

  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  healthServers.push(child);

  const port = await new Promise((done, fail) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const [first] = buffer.split("\n");
      if (/^\d+$/.test(first.trim())) done(Number(first.trim()));
    });
    child.on("exit", (code) => fail(new Error(`the /health server exited early (${code})`)));
  });
  return { port, url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
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
    '  bootstrap|load) : > "$FAKE_STATE"; if [ -n "${FAKE_POINTER:-}" ]; then printf \'{"url":"%s","pid":4242,"dataDir":"%s"}\\n\' "$FAKE_POINTER_URL" "$FAKE_DATA_DIR" > "$FAKE_POINTER"; fi; exit 0 ;;',
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
    "  *\"enable --now\"*) : > \"$FAKE_STATE\"; if [ -n \"${FAKE_POINTER:-}\" ]; then printf '{\"url\":\"%s\",\"pid\":4242,\"dataDir\":\"%s\"}\\n' \"$FAKE_POINTER_URL\" \"$FAKE_DATA_DIR\" > \"$FAKE_POINTER\"; fi; exit 0 ;;",
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
