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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";
import { QUEUE_FILES } from "../../src/orchestrator/queue.mjs";

import { ACTIONS, LOOP_KINDS, SCHEDULERS, cronBlock, cronContentLines, cronMarkers, lingerState, machineStatus, poolReport, resolveScheduler, scanSetFromConfig, stripBlock, subscribeReport, subscribeStatusLine, supervisorBase, supervisorLabel, supervisorPaths } from "../../scripts/install/lib/supervisor.mjs";

const { makeTempDir, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-plan-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

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
    assert.match(asked.stderr, /Enable the supervisor now\? It runs headless in the background \(ping 60s \/ continue 600s\)\. \[y\/N\] $/);
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
// 0b — which loop kinds an action applies to (one supervisor per machine)
// ---------------------------------------------------------------------------

describe("_common.sh: supervisor_actor_kinds_value resolves the action's kinds", () => {
  const resolve = (action, explicit, targets) =>
    runCommon(
      `supervisor_actor_kinds_value ${JSON.stringify(action)} ${JSON.stringify(explicit)} ${JSON.stringify(targets)}`,
    );

  it("enable defaults to the FIRST loop kind in --target order — one supervisor per machine", () => {
    // `--target all` normalizes to `server claude openclaw codex pi`.
    assert.equal(resolve("enable", "", " server claude openclaw codex pi ").stdout, " claude ");
    // Target order, not a hard-coded preference.
    assert.equal(resolve("enable", "", " pi claude ").stdout, " pi ");
    assert.equal(resolve("enable", "", " codex ").stdout, " codex ");
    // No loop kind at all: nothing to act on.
    assert.equal(resolve("enable", "", " server openclaw ").stdout, "");
  });

  it("disable and status default to EVERY loop kind in --target order — the way back out, and the stray view", () => {
    assert.equal(resolve("disable", "", " server claude openclaw codex pi ").stdout, " claude codex pi ");
    assert.equal(resolve("status", "", " server claude openclaw codex pi ").stdout, " claude codex pi ");
    assert.equal(resolve("status", "", " pi claude ").stdout, " pi claude ");
  });

  it("an empty action computes nothing, so a plain install changes no set", () => {
    assert.equal(resolve("", "", " server claude openclaw codex pi ").stdout, "");
  });

  it("an explicit list is the only multi-kind form, and de-duplicates in first-occurrence order", () => {
    assert.equal(resolve("enable", "claude,pi", " server claude codex pi ").stdout, " claude pi ");
    assert.equal(resolve("enable", "pi,claude,pi", " server claude codex pi ").stdout, " pi claude ");
    assert.equal(resolve("disable", "codex", " server claude codex pi ").stdout, " codex ");
  });

  it("an explicit kind the install does not cover is named and dropped — its installer never runs", () => {
    const run = resolve("enable", "claude,codex", " claude ");
    assert.equal(run.stdout, " claude ");
    assert.match(run.stderr, /supervisor: kind 'codex' is not in --target; nothing to act on for it/);
  });

  it("rejects openclaw, server and an unknown kind — with their own reasons", () => {
    const openclaw = resolve("enable", "openclaw", " claude ");
    assert.notEqual(openclaw.status, 0);
    assert.match(openclaw.stderr, /OpenClaw has no meerkat-loop supervisor to enable/);

    const server = resolve("enable", "server", " claude ");
    assert.notEqual(server.status, 0);
    assert.match(server.stderr, /the server target has no meerkat-loop supervisor/);

    const unknown = resolve("enable", "emacs", " claude ");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /invalid --supervisor-actor-kinds: emacs/);
  });

  it("validates an explicit list even when no action was requested", () => {
    const run = resolve("", "openclaw", " claude ");
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /OpenClaw has no meerkat-loop supervisor to enable/);
  });

  it("rejects an unknown action", () => {
    const run = resolve("maybe", "", " claude ");
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--supervisor must be enable, disable or status/);
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
    assert.equal(supervisorLabel("alice", "claude", "ping"), "com.meerkat-taskpanel.alice.claude.ping");
    assert.equal(supervisorLabel("alice", "claude", "continue"), "com.meerkat-taskpanel.alice.claude.continue");

    // The template the installer writes is the single source of truth for the Label.
    const plist = doc("scripts/install/templates/scheduling/launchd/com.meerkat-taskpanel.ping.plist");
    assert.match(plist, /<string>com\.meerkat-taskpanel\.\{\{AGENT\}\}\.\{\{ACTOR_KIND\}\}\.ping<\/string>/);
  });

  it("the three actions and the three loop agent kinds are the contract's, and openclaw is never one", () => {
    assert.deepEqual([...ACTIONS], ["enable", "disable", "status"]);
    assert.deepEqual([...SCHEDULERS], ["auto", "launchd", "systemd", "cron"]);
    assert.deepEqual([...LOOP_KINDS], ["claude", "codex", "pi"]);
    assert.ok(!LOOP_KINDS.includes("openclaw"), "OpenClaw runs openclaw-team's own supervisor");
  });

  it("paths come from the agent directory, with the marker the docs name", () => {
    const paths = supervisorPaths({ agentBase: "/home/op/.claude", agent: "alice", actorKind: "claude", env: {}, home: "/home/op" });

    assert.equal(paths.marker, "~/.claude");
    assert.equal(paths.agentDir, ".claude");
    // With no `TP_CLI`, the cron preview names the agent-local shim; the loop's
    // state now lives in the directory beside it.
    assert.equal(paths.cli, "/home/op/.claude/bin/taskctl");
    assert.equal(paths.cliNeedsNode, false);
    assert.equal(paths.log, "/home/op/.claude/meerkat-taskpanel/supervisor.log");
    assert.equal(paths.stateDir, "/home/op/.claude/meerkat-taskpanel");
    assert.deepEqual(
      paths.launchd.map((unit) => unit.plist),
      [
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.session.plist",
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist",
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.continue.plist",
        "/home/op/.claude/scheduling/launchd/com.meerkat-taskpanel.subscribe.plist",
      ],
    );
    assert.deepEqual(paths.launchd.map((unit) => unit.label), [
      "com.meerkat-taskpanel.alice.claude.session",
      "com.meerkat-taskpanel.alice.claude.ping",
      "com.meerkat-taskpanel.alice.claude.continue",
      "com.meerkat-taskpanel.alice.claude.subscribe",
    ]);
    // systemd reads the *user's* config directory, which `--prefix` never moves.
    assert.equal(paths.systemdUnitDir, "/home/op/.config/systemd/user");
    assert.equal(
      supervisorPaths({ agentBase: "/p/.codex", agent: "a", actorKind: "codex", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/op" })
        .systemdUnitDir,
      "/xdg/systemd/user",
    );
  });
});

// ---------------------------------------------------------------------------
// 1b — the two facts `--supervisor=status` adds: the scan set and the machine view
// ---------------------------------------------------------------------------

describe("supervisor: the per-kind scan set and the machine-level view", () => {
  it("reads the scan set from the per-kind config, never the installer's own env", () => {
    const dir = makeTempDir();
    const path = join(dir, ".env.claude");

    assert.deepEqual(scanSetFromConfig(path), { agents: [], source: "unset" });

    writeFileSync(path, "MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing\n", "utf8");
    assert.deepEqual(scanSetFromConfig(path), { agents: ["Jobs", "Linus", "Turing"], source: "config" });

    // Whitespace-separated is accepted too, and the last occurrence wins (agentConfigValue's rule).
    writeFileSync(path, "MEERKAT_TASKPANEL_AGENTS=Jobs Linus\nMEERKAT_TASKPANEL_AGENTS=Turing\n", "utf8");
    assert.deepEqual(scanSetFromConfig(path), { agents: ["Turing"], source: "config" });

    writeFileSync(path, "MEERKAT_TASKPANEL_AGENTS=\n", "utf8");
    assert.deepEqual(scanSetFromConfig(path), { agents: [], source: "unset" });
  });

  it("names every loop kind loaded on the machine, across mechanisms", () => {
    const home = makeTempDir();
    // A launchd job is loaded; everything else answers "not loaded".
    const run = (command, args) => {
      const loaded = command === "launchctl" && args[0] === "print" && args[1].includes(".codex.");
      return {
        status: loaded ? 0 : 1,
        stdout: "",
        stderr: loaded ? "" : "Could not find service",
        error: null,
      };
    };
    const report = machineStatus({
      home,
      agent: "alice",
      scheduler: "launchd",
      env: { HOME: home },
      run,
      platform: "darwin",
    });
    assert.deepEqual(report.loadedKinds, ["codex"]);
    assert.equal(report.kinds.length, LOOP_KINDS.length);
    assert.equal(report.kinds.find((row) => row.kind === "codex").loaded, true);
    assert.equal(report.kinds.find((row) => row.kind === "claude").loaded, false);
  });

  it("reports none when no loop kind is loaded", () => {
    const home = makeTempDir();
    const run = () => ({ status: 1, stdout: "", stderr: "", error: null });
    assert.deepEqual(
      machineStatus({ home, agent: "alice", scheduler: "launchd", env: { HOME: home }, run, platform: "darwin" }).loadedKinds,
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// 2 — the cron managed block
// ---------------------------------------------------------------------------

describe("supervisor: the cron marker block is the idempotency key", () => {
  const { begin, end } = cronMarkers("~/.claude");

  it("names the agent directory, exactly as the docs show", () => {
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
      agentBase: "/home/op/.claude",
      agent: "alice",
      actorKind: "claude",
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
    assert.match(built[1], /^\* \* \* \* \* \/home\/op\/\.claude\/bin\/taskctl loop run --ping-once --actor-kind claude /);
    assert.match(built[2], /^\*\/10 \* \* \* \* .* loop run --continue-once /);
    assert.match(built[1], />\/dev\/null 2>&1$/);

    // Exported by `install.sh` before it calls this module: the preview then carries the
    // very values the rendered unit carries, not a second guess at them.
    const exported = supervisorPaths({
      agentBase: "/home/op/.claude",
      agent: "alice",
      actorKind: "claude",
      env: {
        TP_NODE: "/opt/node/bin/node",
        TP_CLI: "/opt/repo/src/cli/index.mjs",
        TP_UNIT_PATH_CRON: "/opt/cli/bin:/opt/node/bin:/usr/bin:/bin",
      },
      home: "/home/op",
    });
    exported.cronFile = join(makeTempDir(), "meerkat-taskpanel.cron");
    assert.deepEqual(cronContentLines(exported), [
      "PATH=/opt/cli/bin:/opt/node/bin:/usr/bin:/bin",
      "* * * * * /opt/node/bin/node /opt/repo/src/cli/index.mjs loop run --ping-once --actor-kind claude --log /home/op/.claude/meerkat-taskpanel/supervisor.log --state-dir /home/op/.claude/meerkat-taskpanel >/dev/null 2>&1",
      "*/10 * * * * /opt/node/bin/node /opt/repo/src/cli/index.mjs loop run --continue-once --actor-kind claude --log /home/op/.claude/meerkat-taskpanel/supervisor.log --state-dir /home/op/.claude/meerkat-taskpanel >/dev/null 2>&1",
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
    const install = doc("docs/ops/install.md");
    for (const form of [
      "--supervisor=enable|disable|status",
      "--enable-supervisor",
      "--disable-supervisor",
      "--supervisor-status",
      "--supervisor-actor-kinds",
      "--scheduler auto|launchd|systemd|cron",
      "MEERKAT_TASKPANEL_SUPERVISOR",
    ]) {
      assert.ok(install.includes(form), `docs/ops/install.md must document ${form}`);
    }
  });

  it("reports the resident pool's runtime state, best effort", () => {
    const dir = makeTempDir();
    assert.deepEqual(
      { live: poolReport(dir).live, reason: poolReport(dir).reason },
      { live: false, reason: "no session state" },
    );

    const now = Date.parse("2026-01-01T00:00:00.000Z");
    writeFileSync(
      join(dir, "sessions.state.json"),
      JSON.stringify({ version: 1, poolPid: 4242, heartbeatAt: new Date(now - 3_000).toISOString() }),
    );
    writeFileSync(
      join(dir, "subagents.state.json"),
      JSON.stringify({
        version: 1,
        subagents: [
          { subagentId: "a-1", status: "running" },
          { subagentId: "a-2", status: "completed" },
          { subagentId: "a-3", status: "reattaching" },
        ],
      }),
    );
    writeFileSync(
      join(dir, QUEUE_FILES.cards),
      JSON.stringify({
        version: 1,
        cards: [
          { id: "T-1-worker", status: "pending", queue_kind: "handoff" },
          // The question lane is a project-session turn, not a queued card.
          { id: "question:T-2:q-1", status: "pending", queue_kind: "question" },
        ],
      }),
    );
    writeFileSync(join(dir, "continue.pending.json"), JSON.stringify({ version: 1, reason: "timer" }));

    const live = poolReport(dir, { isAlive: () => true, now: () => now });
    assert.equal(live.live, true);
    assert.equal(live.pid, 4242);
    assert.equal(live.heartbeatAgeMs, 3_000);
    assert.equal(live.liveSubagents, 2, "running and reattaching subagents occupy a slot");
    assert.equal(live.cardsQueued, 1);
    assert.equal(live.continueQueued, true);

    assert.equal(poolReport(dir, { isAlive: () => false, now: () => now }).live, false);
  });

  it("reports the subscriber's runtime state, best effort", () => {
    const dir = makeTempDir();
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    assert.equal(subscribeReport(dir, { now: () => now }).state, "missing");

    writeFileSync(
      join(dir, "subscribe.state.json"),
      JSON.stringify({
        version: 1,
        pid: 4242,
        connectedAt: new Date(now - 12_000).toISOString(),
        lastEventAt: new Date(now - 3_000).toISOString(),
        lastEventId: 812,
        reconnects: 0,
        lastError: null,
        lastErrorAt: null,
        nextAttemptAt: null,
        dispatchEnabled: true,
      }),
    );
    const streaming = subscribeReport(dir, { isAlive: () => true, now: () => now, unitLoaded: true });
    assert.equal(streaming.state, "streaming");
    assert.equal(streaming.pid, 4242);
    assert.equal(
      subscribeStatusLine(streaming, now),
      "supervisor:   subscribe: running (streaming; pid 4242, connected 12s ago, last event 3s ago, id 812, reconnects 0, dispatch on)",
    );
    assert.equal(subscribeReport(dir, { isAlive: () => false, now: () => now }).state, "dead");
    assert.equal(
      subscribeStatusLine({ state: "dead", pid: 4242, unitLoaded: false }, now),
      "supervisor:   subscribe: not running (pid 4242 is gone; unit not loaded)",
    );
    assert.equal(
      subscribeStatusLine({ state: "missing", unitLoaded: false }, now),
      "supervisor:   subscribe: not running (no subscribe state; unit not loaded)",
    );

    writeFileSync(
      join(dir, "subscribe.state.json"),
      JSON.stringify({
        version: 1,
        pid: 4242,
        connectedAt: new Date(now - 60_000).toISOString(),
        lastEventAt: null,
        lastEventId: null,
        reconnects: 2,
        lastError: "taskctl exited 1",
        lastErrorAt: new Date(now - 300_000).toISOString(),
        nextAttemptAt: new Date(now + 8_000).toISOString(),
        dispatchEnabled: false,
      }),
    );
    const reconnecting = subscribeReport(dir, { isAlive: () => true, now: () => now });
    assert.equal(reconnecting.state, "reconnecting");
    assert.equal(reconnecting.nextInMs, 8_000);
    assert.match(
      subscribeStatusLine(reconnecting, now),
      /^supervisor:   subscribe: running \(reconnecting; pid 4242, attempt 2, next in 8s, last error 5m ago: taskctl exited 1\)$/,
    );

    writeFileSync(
      join(dir, "subscribe.state.json"),
      JSON.stringify({ version: 1, pid: 4242, nextAttemptAt: null, dispatchEnabled: true }),
    );
    const starting = subscribeReport(dir, { isAlive: () => true, now: () => now });
    assert.equal(starting.state, "starting");
    assert.equal(
      subscribeStatusLine(starting, now),
      "supervisor:   subscribe: running (starting; pid 4242, no connection yet, dispatch on)",
    );

    assert.equal(subscribeReport(dir, { scheduler: "cron" }).state, "unavailable");
    assert.equal(
      subscribeStatusLine({ state: "unavailable", reason: "scheduler=cron has no long-lived process" }, now),
      "supervisor:   subscribe: not available (scheduler=cron has no long-lived process)",
    );
  });

  it("the enable report the docs print is the one the launchd plan produces", () => {
    // The doc's example (`docs/ops/install.md` §Enabling the supervisor (opt-in)) is written
    // with `<agent>` as a placeholder; filling it in must give exactly the string the
    // launchd mechanism reports, or the doc is lying about what a user will see.
    const documented = doc("docs/ops/install.md").match(/^supervisor: enabled \(kind=claude, scheduler=launchd, units=(.*)\)$/m);
    assert.notEqual(documented, null, "the enable report must be quoted in docs/ops/install.md");
    assert.equal(
      documented[1].replace("<agent>", "alice"),
      `${supervisorBase("alice", "claude")}.session,.ping,.continue,.subscribe`,
      "the documented units= is the one the plan reports",
    );
  });

  it("the per-OS commands the docs give are the ones the plans run", () => {
    const scheduling = doc("docs/scheduling.md");
    assert.ok(scheduling.includes("launchctl bootstrap gui/$(id -u)"), "launchd bootstrap");
    assert.ok(scheduling.includes("launchctl bootout gui/$(id -u)/com.meerkat-taskpanel.<agent>.claude.ping"), "launchd bootout");
    assert.ok(
      scheduling.includes("systemctl --user enable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer meerkat-taskpanel-subscribe.service"),
      "systemd enable",
    );
    assert.ok(scheduling.includes("loginctl enable-linger"), "the lingering remedy");
  });

  it("the opt-in is documented in the install docs, not in the skill", () => {
    for (const relative of ["docs/ops/install.md", "docs/scheduling.md"]) {
      assert.doesNotMatch(doc(relative), /Not yet wired/, `${relative} still says the flag is not implemented`);
    }
    const install = doc("docs/ops/install.md");
    assert.match(install, /--supervisor=enable/, "docs/ops/install.md must name the opt-in");
    assert.match(install, /disable/, "docs/ops/install.md must name the way back out");
    for (const relative of ["skills/meerkat-loop/SKILL.md", "skills/meerkat-loop/references/operation.md"]) {
      const text = doc(relative);
      assert.doesNotMatch(text, /install\.sh/, `${relative} must not carry installation instructions`);
      assert.doesNotMatch(text, /--supervisor=/, `${relative} must not carry supervisor enable/disable/status`);
    }
  });

  it("OpenClaw's exclusion is still stated, and still true of the loop agent kinds", () => {
    const scheduling = doc("docs/scheduling.md");
    assert.match(scheduling, /OpenClaw: no loop units/);
    assert.match(scheduling, /--supervisor-actor-kinds openclaw` is \*\*rejected\*\*/);
    assert.ok(!LOOP_KINDS.includes("openclaw"));
  });
});
