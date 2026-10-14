/**
 * The supervisor enable engine's **data** and resolver layer
 * (T-20261013-214703-3) — `scripts/install/lib/supervisor.mjs`.
 *
 * `supervisor-enable.test.mjs` next door drives the whole thing through `install.sh`
 * with a faked service manager. This file holds the parts that are pure — the scheduler
 * resolver, the launchd labels, the cron marker block and its stripper, the linger probe —
 * plus the pins that keep the implementation and the contract (`docs/`, and the loop
 * skill's own `SKILL.md` / `references/operation.md`) telling the same story.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  ACTIONS,
  LOOP_HOSTS,
  SCHEDULERS,
  cronBlock,
  cronContentLines,
  cronMarkers,
  lingerState,
  resolveScheduler,
  stripBlock,
  supervisorBase,
  supervisorLabel,
  supervisorPaths,
} from "../../scripts/install/lib/supervisor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];
function makeTempDir(prefix = "meerkat-taskpanel-plan-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The files of a doc, for the contract pins below. */
const doc = (relative) => readFileSync(join(ROOT, relative), "utf8");

/** Run one line of shell against `_common.sh` — the `claim-unassigned.test.mjs` idiom. */
function runCommon(snippet, { input = "" } = {}) {
  return spawnSync("bash", ["-c", `. "$1/scripts/install/_common.sh"\n${snippet}`, "_", ROOT], {
    encoding: "utf8",
    input,
  });
}

// ---------------------------------------------------------------------------
// 0 — the request resolver: flag beats env beats the TTY question (default N)
// ---------------------------------------------------------------------------

describe("_common.sh: supervisor_value decides the opt-in", () => {
  it("returns an explicit action verbatim", () => {
    for (const action of ["enable", "disable", "status"]) {
      assert.equal(runCommon(`supervisor_value ${action} ""`).stdout.trim(), action);
    }
  });

  it("is empty when nothing was asked for — a plain install changes nothing", () => {
    assert.equal(runCommon('supervisor_value "" ""').stdout.trim(), "");
  });

  it("asks once on a TTY and defaults to **no** — the opposite of the claim question", () => {
    // Blank, EOF and an explicit `n` all mean "do nothing": the supervisor is a daemon,
    // so silence must not be taken as consent.
    for (const input of ["\n", "", "n\n", "no\n", "whatever\n"]) {
      assert.equal(runCommon('supervisor_value "" 1', { input }).stdout.trim(), "", JSON.stringify(input));
    }
    for (const input of ["y\n", "Y\n", "yes\n"]) {
      assert.equal(runCommon('supervisor_value "" 1', { input }).stdout.trim(), "enable", JSON.stringify(input));
    }
    // The question goes to stderr so a piped stdout stays clean, and it says the default.
    const asked = runCommon('supervisor_value "" 1', { input: "n\n" });
    // (The trailing space is the prompt's own, like the claim question's — a TTY answer
    // is typed at the cursor, not on the next line.)
    assert.match(asked.stderr, /Enable the supervisor now\? It runs headless in the background \(poll 60s \/ patrol 300s\)\. \[y\/N\] $/);
  });

  it("rejects an unknown action instead of silently installing the opposite", () => {
    const run = runCommon('supervisor_value maybe ""');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--supervisor must be enable, disable or status/);
  });

  it("apply_supervisor does nothing at all without a request", () => {
    const run = runCommon("apply_supervisor");
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
  });

  it("apply_supervisor rejects a bad action or scheduler before reaching the engine", () => {
    const action = runCommon("MEERKAT_TASKPANEL_SUPERVISOR=maybe apply_supervisor");
    assert.notEqual(action.status, 0);
    assert.match(action.stderr, /MEERKAT_TASKPANEL_SUPERVISOR must be enable, disable or status/);

    const scheduler = runCommon("MEERKAT_TASKPANEL_SUPERVISOR=status MEERKAT_TASKPANEL_SCHEDULER=upstart apply_supervisor");
    assert.notEqual(scheduler.status, 0);
    assert.match(scheduler.stderr, /MEERKAT_TASKPANEL_SCHEDULER must be auto, launchd, systemd or cron/);
  });
});

// ---------------------------------------------------------------------------
// 1 — resolvers and identifiers
// ---------------------------------------------------------------------------

describe("supervisor: the scheduler and the identifiers", () => {
  it("`auto` is this platform's native mechanism, and an explicit one is taken verbatim", () => {
    assert.equal(resolveScheduler("auto", "darwin"), "launchd");
    assert.equal(resolveScheduler("auto", "linux"), "systemd");
    // Everything else — Windows, a BSD, cygwin — falls back to the portable one.
    for (const platform of ["win32", "freebsd", "aix"]) {
      assert.equal(resolveScheduler("auto", platform), "cron");
    }
    assert.equal(resolveScheduler("", "darwin"), "launchd", "an empty request means auto");
    assert.equal(resolveScheduler(undefined, "linux"), "systemd");
    for (const requested of ["launchd", "systemd", "cron"]) {
      assert.equal(resolveScheduler(requested, "darwin"), requested, "an explicit choice always wins");
    }
  });

  it("the launchd label is the one the unit template renders", () => {
    assert.equal(supervisorBase("alice", "claude"), "com.meerkat-taskpanel.alice.claude");
    assert.equal(supervisorLabel("alice", "claude", "poll"), "com.meerkat-taskpanel.alice.claude.poll");
    assert.equal(supervisorLabel("alice", "claude", "patrol"), "com.meerkat-taskpanel.alice.claude.patrol");

    // The template the installer writes is the single source of truth for the Label.
    const plist = doc("skills/meerkat-loop/templates/scheduling/launchd/com.meerkat-taskpanel.poll.plist");
    assert.match(plist, /<string>com\.meerkat-taskpanel\.\{\{AGENT\}\}\.\{\{HOST\}\}\.poll<\/string>/);
  });

  it("the three actions and the three hosts are the contract's, and openclaw is never one", () => {
    assert.deepEqual([...ACTIONS], ["enable", "disable", "status"]);
    assert.deepEqual([...SCHEDULERS], ["auto", "launchd", "systemd", "cron"]);
    assert.deepEqual([...LOOP_HOSTS], ["claude", "codex", "pi"]);
    assert.ok(!LOOP_HOSTS.includes("openclaw"), "OpenClaw runs openclaw-team's own supervisor");
  });

  it("paths come from the host directory, with the marker the docs name", () => {
    const paths = supervisorPaths({ hostBase: "/home/op/.claude", agent: "alice", host: "claude", env: {}, home: "/home/op" });

    assert.equal(paths.marker, "~/.claude");
    assert.equal(paths.hostDir, ".claude");
    assert.equal(paths.supervisor, "/home/op/.claude/meerkat-taskpanel/scripts/supervisor.mjs");
    assert.equal(paths.log, "/home/op/.claude/meerkat-taskpanel/supervisor.log");
    assert.equal(paths.state, "/home/op/.claude/meerkat-taskpanel/supervisor.state.json");
    assert.deepEqual(
      paths.launchd.map((unit) => unit.plist),
      [
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.poll.plist",
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.patrol.plist",
      ],
    );
    assert.deepEqual(paths.launchd.map((unit) => unit.label), [
      "com.meerkat-taskpanel.alice.claude.poll",
      "com.meerkat-taskpanel.alice.claude.patrol",
    ]);
    // systemd reads the *user's* config directory, which `--prefix` never moves.
    assert.equal(paths.systemdUnitDir, "/home/op/.config/systemd/user");
    assert.equal(
      supervisorPaths({ hostBase: "/p/.codex", agent: "a", host: "codex", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/op" })
        .systemdUnitDir,
      "/xdg/systemd/user",
    );
  });
});

// ---------------------------------------------------------------------------
// 2 — the cron managed block
// ---------------------------------------------------------------------------

describe("supervisor: the cron marker block is the idempotency key", () => {
  const { begin, end } = cronMarkers("~/.claude");

  it("names the host directory, exactly as the docs show", () => {
    assert.equal(begin, "# >>> meerkat-taskpanel (~/.claude) >>>");
    assert.equal(end, "# <<< meerkat-taskpanel (~/.claude) <<<");
    assert.ok(doc("docs/scheduling.md").includes(begin), "the docs quote the same marker");
  });

  it("strips the block and leaves every other line alone", () => {
    const text =
      "0 3 * * * /usr/bin/true\n" +
      "# >>> meerkat-taskpanel (~/.claude) >>>\n" +
      "* * * * * job\n" +
      "# <<< meerkat-taskpanel (~/.claude) <<<\n" +
      "30 4 * * * /usr/bin/false\n";
    const stripped = stripBlock(text, begin, end);
    assert.equal(stripped.found, true);
    assert.equal(stripped.text, "0 3 * * * /usr/bin/true\n30 4 * * * /usr/bin/false\n");
  });

  it("removes a trailing block without leaving a stray blank line behind", () => {
    // No stray line matters: the enable path re-appends the block and compares the whole
    // table byte-for-byte to decide "already enabled", so a lingering blank line would
    // make every repeat enable rewrite the crontab.
    const text = "0 3 * * * /usr/bin/true\n# >>> meerkat-taskpanel (~/.claude) >>>\njob\n# <<< meerkat-taskpanel (~/.claude) <<<\n";
    assert.equal(stripBlock(text, begin, end).text, "0 3 * * * /usr/bin/true\n");
  });

  it("is a no-op when the block is absent, and never touches a half-written one", () => {
    const nothing = "0 3 * * * /usr/bin/true\n";
    assert.deepEqual(stripBlock(nothing, begin, end), { text: nothing, found: false });

    // Only the opening marker: swallowing the rest of a user's crontab would be far worse
    // than not finding the block, so it is left exactly as it is.
    const half = "0 3 * * * /usr/bin/true\n# >>> meerkat-taskpanel (~/.claude) >>>\n* * * * * job\n";
    assert.deepEqual(stripBlock(half, begin, end), { text: half, found: false });
  });

  it("carries the rendered cron unit when there is one, and the same lines otherwise", () => {
    const paths = supervisorPaths({
      hostBase: "/home/op/.claude",
      agent: "alice",
      host: "claude",
      env: {},
      home: "/home/op",
    });
    const cronFile = join(makeTempDir(), "meerkat-taskpanel.cron");
    paths.cronFile = cronFile;

    // In a `--dry-run` nothing has been written yet — the lines are built from the same
    // recipe the unit template is rendered from, so the two are interchangeable: the
    // `PATH=` setting line first, then an ABSOLUTE interpreter. `/usr/bin/env node` is
    // exactly what cron cannot resolve (T-20261014-020103-2), so a preview that showed it
    // would be advertising a line the unit no longer carries.
    const built = cronContentLines(paths);
    assert.equal(built.length, 3);
    assert.match(built[0], /^PATH=\S+$/);
    assert.match(built[1], /^\* \* \* \* \* \/[^ ]*node \/home\/op\/\.claude\/meerkat-taskpanel\/scripts\/supervisor\.mjs --host claude --agent alice --once /);
    assert.match(built[2], /^\*\/5 \* \* \* \* .* --patrol-only --once /);
    assert.match(built[1], />\/dev\/null 2>&1$/);

    // Exported by `install.sh` before it calls this module: the preview then carries the
    // very values the rendered unit carries, not a second guess at them.
    const exported = supervisorPaths({
      hostBase: "/home/op/.claude",
      agent: "alice",
      host: "claude",
      env: { TP_NODE: "/opt/node/bin/node", TP_UNIT_PATH_CRON: "/opt/cli/bin:/opt/node/bin:/usr/bin:/bin" },
      home: "/home/op",
    });
    exported.cronFile = join(makeTempDir(), "meerkat-taskpanel.cron");
    assert.deepEqual(cronContentLines(exported), [
      "PATH=/opt/cli/bin:/opt/node/bin:/usr/bin:/bin",
      "* * * * * /opt/node/bin/node /home/op/.claude/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --once --log /home/op/.claude/meerkat-taskpanel/supervisor.log --state /home/op/.claude/meerkat-taskpanel/supervisor.state.json >/dev/null 2>&1",
      "*/5 * * * * /opt/node/bin/node /home/op/.claude/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --patrol-only --once --log /home/op/.claude/meerkat-taskpanel/supervisor.log --state /home/op/.claude/meerkat-taskpanel/supervisor.state.json >/dev/null 2>&1",
    ]);

    // Once the installer has written the unit, that file is the source: the enable path
    // and the manual `crontab <file>` path can never drift apart.
    writeFileSync(cronFile, "# a comment\n\n0 0 * * * /from/the/unit --once\n", "utf8");
    assert.deepEqual(cronContentLines(paths), ["0 0 * * * /from/the/unit --once"]);

    const block = cronBlock(paths);
    assert.equal(block.split("\n")[0], begin);
    assert.equal(block.split("\n").at(-1), end);
    assert.match(block, /0 0 \* \* \* \/from\/the\/unit --once/);
  });
});

// ---------------------------------------------------------------------------
// 3 — the linger probe (the headless caveat)
// ---------------------------------------------------------------------------

describe("supervisor: the systemd linger probe", () => {
  const runner = (result) => () => ({ status: 0, stdout: "", stderr: "", ...result });

  it("reads loginctl's answer, and treats an unanswerable machine as unknown", () => {
    assert.equal(lingerState({ user: "alice", run: runner({ stdout: "Linger=yes\n" }) }), "on");
    assert.equal(lingerState({ user: "alice", run: runner({ stdout: "Linger=no\n" }) }), "off");
    assert.equal(lingerState({ user: "alice", run: runner({ status: 1, stderr: "Failed to connect to bus" }) }), "unknown");
    assert.equal(lingerState({ user: "", run: runner({ stdout: "Linger=yes\n" }) }), "unknown", "no user to ask about");
  });

  it("asks loginctl with the property the docs' remedy implies", () => {
    let seen = null;
    const spy = (command, args) => {
      seen = [command, ...args];
      return { status: 0, stdout: "Linger=no\n", stderr: "" };
    };
    assert.equal(lingerState({ user: "alice", run: spy }), "off");
    assert.deepEqual(seen, ["loginctl", "show-user", "alice", "--property", "Linger"]);
  });
});

// ---------------------------------------------------------------------------
// 4 — the implementation and the contract tell the same story
// ---------------------------------------------------------------------------

describe("supervisor: the docs and the implementation agree", () => {
  it("the interface docs describe the flag surface this implements", () => {
    const install = doc("docs/install.md");
    for (const form of [
      "--supervisor=enable|disable|status",
      "--enable-supervisor",
      "--disable-supervisor",
      "--supervisor-status",
      "--supervisor-hosts",
      "--scheduler auto|launchd|systemd|cron",
      "MEERKAT_TASKPANEL_SUPERVISOR",
    ]) {
      assert.ok(install.includes(form), `docs/install.md must document ${form}`);
    }
  });

  it("the enable report the docs print is the one the launchd plan produces", () => {
    // The doc's example (`docs/install.md` §Enabling the supervisor (opt-in)) is written
    // with `<agent>` as a placeholder; filling it in must give exactly the string the
    // launchd mechanism reports, or the doc is lying about what a user will see.
    const documented = doc("docs/install.md").match(/^supervisor: enabled \(host=claude, scheduler=launchd, units=(.*)\)$/m);
    assert.notEqual(documented, null, "the enable report must be quoted in docs/install.md");
    assert.equal(
      documented[1].replace("<agent>", "alice"),
      `${supervisorBase("alice", "claude")}.poll,.patrol`,
      "the documented units= is the one the plan reports",
    );
  });

  it("the per-OS commands the docs give are the ones the plans run", () => {
    const scheduling = doc("docs/scheduling.md");
    assert.ok(scheduling.includes("launchctl bootstrap gui/$(id -u)"), "launchd bootstrap");
    assert.ok(scheduling.includes("launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.poll"), "launchd bootout");
    assert.ok(
      scheduling.includes("systemctl --user enable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer"),
      "systemd enable",
    );
    assert.ok(scheduling.includes("loginctl enable-linger"), "the lingering remedy");
  });

  it("the opt-in is documented in the loop skill too, and nothing still calls it unwired", () => {
    for (const relative of ["docs/install.md", "docs/scheduling.md"]) {
      assert.doesNotMatch(doc(relative), /Not yet wired/, `${relative} still says the flag is not implemented`);
    }
    for (const relative of ["skills/meerkat-loop/SKILL.md", "skills/meerkat-loop/references/operation.md"]) {
      const text = doc(relative);
      assert.match(text, /--supervisor=enable/, `${relative} must name the opt-in`);
      assert.match(text, /disable/, `${relative} must name the way back out`);
    }
  });

  it("OpenClaw's exclusion is still stated, and still true of the loop hosts", () => {
    const scheduling = doc("docs/scheduling.md");
    assert.match(scheduling, /OpenClaw: do not build a supervisor/);
    assert.match(scheduling, /--supervisor-hosts openclaw` is \*\*rejected\*\*/);
    assert.ok(!LOOP_HOSTS.includes("openclaw"));
  });
});
