/**
 * The loop's independent entries, end to end at the process boundary.
 *
 * The scheduler split is only real if each entry can run on its own. These
 * tests pin the two properties the split exists for:
 *
 *   * **ping is liveness only** — it prunes the registry and touches nothing
 *     else (a sentinel `--cli` proves no board call was made);
 *   * **continue is a judgment turn** — it starts the host with a bounded
 *     `Continue` prompt, never goes through the wake glue, and a single-flight lock
 *     stops a second turn while one is still running.
 *
 * The deterministic entries are exercised in dry-run against a sentinel CLI:
 * this is enough to prove they build the right board calls without a database.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  acquireContinueLock,
  loadContinueLock,
  recordContinuePid,
  releaseContinueLock,
  runPingTick,
} from "../../scripts/loop/runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A taskctl stand-in that records its argv and answers every read with empty data. */
function sentinelCli(dir) {
  const record = join(dir, "calls.jsonl");
  const script = join(dir, "sentinel-cli.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      'process.stdout.write(`${JSON.stringify({ ok: true, data: { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } } })}\\n`);',
    ].join("\n"),
    "utf8",
  );
  return { script, record };
}

function calls(record) {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function runEntry(entry, args, env = {}, subcommand = null) {
  return spawnSync(
    process.execPath,
    [
      join(ROOT, "scripts", "loop", entry),
      ...(subcommand === null ? [] : [subcommand]),
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

function runSupervisor(args, env = {}) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", "supervisor.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------------------
// Ping — liveness only
// ---------------------------------------------------------------------------

describe("runPingTick", () => {
  const registry = {
    version: 1,
    running: {
      "T-1": { agent: "alice", pid: 100 },
      "T-2": { agent: "alice", pid: 200 },
    },
  };

  it("prunes a dead pid, keeps a live one and writes once", () => {
    const writes = [];
    const result = runPingTick({
      registry,
      isAlive: (pid) => pid === 100,
      save: (next) => writes.push(next),
    });
    assert.equal(result.pruned, 1);
    assert.equal(result.saved, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].running), ["T-1"]);
  });

  it("performs no write when nothing was pruned", () => {
    const writes = [];
    const result = runPingTick({ registry, isAlive: () => true, save: (next) => writes.push(next) });
    assert.equal(result.pruned, 0);
    assert.equal(result.saved, false);
    assert.equal(writes.length, 0);
  });

  it("dry-run reports and never writes", () => {
    const writes = [];
    const lines = [];
    const result = runPingTick({
      registry,
      isAlive: () => false,
      save: (next) => writes.push(next),
      dryRun: true,
      log: (line) => lines.push(line),
    });
    assert.equal(result.saved, false);
    assert.equal(writes.length, 0);
    assert.ok(lines.some((line) => line.includes("would prune T-1")));
  });

  it("treats an absent/odd registry as empty instead of crashing", () => {
    const result = runPingTick({ registry: {}, isAlive: () => true, save: () => {} });
    assert.deepEqual(result, { pruned: 0, live: 0, saved: false });
  });
});

describe("the continue lock", () => {
  it("is single-flight while its holder is alive", () => {
    const path = join(tempDir("tp-lock-"), "continue.state.json");
    const now = () => Date.now();
    const first = acquireContinueLock(path, { isAlive: () => true, now });
    assert.equal(first.acquired, true);
    const second = acquireContinueLock(path, { isAlive: () => true, now });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, "running");
    releaseContinueLock(path);
  });

  it("reclaims a dead holder and a holder past its max age", () => {
    const path = join(tempDir("tp-lock-"), "continue.state.json");
    writeFileSync(path, JSON.stringify({ version: 1, pid: 2147483646, startedAt: new Date().toISOString() }));
    assert.equal(acquireContinueLock(path, { isAlive: () => false }).acquired, true);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    );
    assert.equal(acquireContinueLock(path, { isAlive: () => true, now: () => Date.now(), maxAgeMs: 2 * 60 * 60 * 1000 }).acquired, true);
  });

  it("rewrites the child pid and releases cleanly", () => {
    const path = join(tempDir("tp-lock-"), "continue.state.json");
    acquireContinueLock(path, { isAlive: () => true });
    recordContinuePid(path, 4242, new Date().toISOString());
    assert.equal(loadContinueLock(path).pid, 4242);
    releaseContinueLock(path);
    assert.equal(loadContinueLock(path), null);
  });
});

describe("ping and continue entries", () => {
  it("ping never reads the board", () => {
    const dir = tempDir("tp-entry-ping-");
    const { script, record } = sentinelCli(dir);
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ version: 1, running: { "T-1": { pid: 2147483646 } } }));

    const sup = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts", "supervisor.mjs"),
        "--host", "claude", "--agent", "alice", "--ping-only", "--once",
        "--state", state, "--log", join(dir, "log"),
        "--cli", script,
      ],
      { encoding: "utf8", env: { ...process.env, TP_SENTINEL: record } },
    );
    assert.equal(sup.status, 0, sup.stderr);
    assert.deepEqual(calls(record), [], "ping must not call taskctl");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(state, "utf8")).running), [], "the dead pid is pruned");
  });

  it("continue dry-run prints the prompt and spawns nothing", () => {
    const dir = tempDir("tp-entry-continue-");
    const record = join(dir, "spawned");
    const bin = join(dir, "bin");
    const run = runSupervisor([
      "--continue-only", "--once",
      "--host", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"),
      "--log", join(dir, "log"), "--continue-state", join(dir, "continue.state.json"),
      "--dry-run",
    ], { TP_FAKE_CLAUDE: record, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Continue/);
    assert.match(run.stderr, /continue: would run: claude/);
    assert.equal(existsSync(join(dir, "continue.state.json")), false, "dry-run takes no lock");
  });
});

// ---------------------------------------------------------------------------
// The deterministic entries against a sentinel CLI
// ---------------------------------------------------------------------------

describe("deterministic entries (dry-run, sentinel CLI)", () => {
  function runWithSentinel(pass, extra = []) {
    const dir = tempDir(`tp-entry-${pass}-`);
    const { script, record } = sentinelCli(dir);
    const run = runEntry("passes.mjs", [
      "--host", "claude", "--agent", "alice", "--dry-run",
      "--cli", script, "--repo", dir,
      "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ...extra,
    ], { TP_SENTINEL: record }, pass);
    return { run, record, dir };
  }

  it("poll scans candidates and writes nothing", () => {
    const { run, record } = runWithSentinel("poll");
    assert.equal(run.status, 0, run.stderr);
    const args = calls(record);
    assert.ok(args.length > 0, "poll must scan");
    assert.ok(
      args.some((call) => call.includes("project") && call[call.indexOf("project") + 1] === "list"),
      "the project reviewer overrides are read before the scan",
    );
    const candidateCall = args.find((call) => call.includes("candidates"));
    assert.ok(candidateCall, "the scan is `issue candidates`");
    assert.equal(candidateCall[candidateCall.indexOf("candidates") - 1], "issue");
    assert.equal(existsSync(join(dirname(record), "state.json")), false, "dry-run writes no registry");
  });

  it("patrol reads the board and the SLA rows, and writes nothing", () => {
    const { run, record, dir } = runWithSentinel("patrol");
    assert.equal(run.status, 0, run.stderr);
    const args = calls(record);
    assert.ok(args.some((call) => call.join(" ").includes("issue list ")), "the legacy stale read");
    assert.ok(
      args.some((call) => call.includes("sla") && call.includes("list")),
      "the SLA rows come from the board's `sla list`",
    );
    assert.equal(existsSync(join(dir, "state.json")), false);
  });

  it("workflow asks the board for the plan, and writes nothing in dry-run", () => {
    const { run, record } = runWithSentinel("workflow");
    assert.equal(run.status, 0, run.stderr);
    // The loop's acceptance copy is advisory — the board decides in the plan.
    // It is still said out loud at startup, which is the only thing it is for.
    assert.match(run.stderr, /acceptance=both \(advisory\)/, "the advisory policy is stated");
    const args = calls(record);
    assert.ok(
      args.some((call) => call.includes("project") && call[call.indexOf("project") + 1] === "list"),
      "the required-project reviewer promise is checked before reconcile",
    );
    const callsToReconcile = args.filter((call) => call.includes("issue") && call.includes("reconcile"));
    assert.equal(callsToReconcile.length, 1, "one plan read: the board computes the plan");
    const call = callsToReconcile[0];
    assert.ok(call.includes("--workflow"), JSON.stringify(call));
    assert.ok(call.includes("--dry-run"), JSON.stringify(call));
  });

  it("workflow refuses agent-only with auto-accept off", () => {
    const { run } = runWithSentinel("workflow", [
      "--acceptance", "agent-only", "--auto-accept-reviews=no",
    ]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(
      run.stderr,
      /acceptance=agent-only with auto_accept_reviews=no/,
      "the conflict is named",
    );
    assert.match(run.stderr, /auto_accept_reviews=yes/, "the repair is named");
  });

  it("workflow does not warn for agent-only with auto-accept on", () => {
    const { run } = runWithSentinel("workflow", ["--acceptance", "agent-only"]);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /review cards will accumulate/);
  });

  it("workflow=no does not read the board at all", () => {
    const { run, record } = runWithSentinel("workflow", ["--workflow=no"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(calls(record), []);
  });
});

// ---------------------------------------------------------------------------
// Continue — the spawn path
// ---------------------------------------------------------------------------

describe("continue spawn", () => {
  function fakeClaude(dir) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const record = join(dir, "args.txt");
    const script = join(bin, "claude");
    writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TP_FAKE_CLAUDE"\n', "utf8");
    chmodSync(script, 0o755);
    return { bin, record, env: { TP_FAKE_CLAUDE: record, PATH: `${bin}:${process.env.PATH}` } };
  }

  function waitFor(path, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      Atomics.wait(sleeper, 0, 0, 20);
    }
    return false;
  }

  it("starts the host with -p and a prompt that begins with Continue", () => {
    const dir = tempDir("tp-continue-spawn-");
    const fake = fakeClaude(dir);
    const state = join(dir, "state.json");
    const lock = join(dir, "continue.state.json");
    const run = runSupervisor(["--continue-only", "--once",
      "--host", "claude", "--agent", "alice",
      "--repo", dir, "--state", state, "--log", join(dir, "log"),
      "--continue-state", lock,
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(waitFor(fake.record), "the fake host was not started");
    const argv = readFileSync(fake.record, "utf8").split("\n");
    assert.equal(argv[0], "-p");
    assert.ok(argv[1].startsWith("Continue"), argv[1].slice(0, 40));
    assert.doesNotMatch(argv[1], /--project\b|TP_PROJECT/);
    const held = loadContinueLock(lock);
    assert.ok(Number.isInteger(held.pid) && held.pid > 0, "the lock holds the child pid");
  });

  it("skips while a live turn holds the lock", () => {
    const dir = tempDir("tp-continue-lock-");
    const fake = fakeClaude(dir);
    const lock = join(dir, "continue.state.json");
    writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }));
    const run = runSupervisor(["--continue-only", "--once",
      "--host", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", lock,
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /still running/);
    assert.equal(existsSync(fake.record), false, "no second LLM turn");
  });

  it("releases the lock and exits 1 when the host cannot start", () => {
    const dir = tempDir("tp-continue-fail-");
    const emptyBin = join(dir, "empty");
    mkdirSync(emptyBin, { recursive: true });
    const lock = join(dir, "continue.state.json");
    const run = runSupervisor(["--continue-only", "--once",
      "--host", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", lock,
    ], { PATH: emptyBin });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(existsSync(lock), false, "a failed spawn leaves no lock behind");
  });
});
