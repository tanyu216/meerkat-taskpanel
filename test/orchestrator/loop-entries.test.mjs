/**
 * The loop's independent entries, end to end at the process boundary.
 *
 * The scheduler split is only real if each entry can run on its own. These
 * tests pin the two properties the split exists for:
 *
 *   * **ping is liveness only** — it prunes the registry and touches nothing
 *     else (a sentinel `--cli` proves no board call was made);
 *   * **continue is a judgment turn** — it starts the agent with a bounded
 *     `Continue` prompt, never goes through a project directory, and a single-flight
 *     lock stops a second turn while one is still running.
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

import { readOpenQuestions } from "../../src/orchestrator/board.mjs";
import {
  createProjectAdmission,
  createQueueDispatch,
  isGitCheckout,
} from "../../src/orchestrator/passes.mjs";
import { QUEUE_FILES, readCards } from "../../src/orchestrator/queue.mjs";
import { findWorkspace, upsertWorkspaceRecord } from "../../src/orchestrator/workspace.mjs";
import { runContinue, runPollTick, runQuestionTick } from "../../src/orchestrator/runners.mjs";
import {
  acquireContinueLock,
  loadContinueLock,
  readCardForRedispatch,
  readRouteOutcome,
  recordContinuePid,
  recoverWedgedPool,
  releaseContinueLock,
  runCli,
  runPingTick,
} from "../../src/orchestrator/runtime.mjs";

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

/** Write one role skill into a kind's skills tree (the discovery input). */
function seedRole(home, kind, id, agent, lanes = ["worker"]) {
  const roleDir = join(home, `.${kind}`, "skills", id);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, "SKILL.md"), `---\nname: ${id}\n---\n`, "utf8");
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({ schema: "meerkat-role", id, agent, lanes }),
    "utf8",
  );
  return roleDir;
}

/** A state file that says "the pool manager is alive and beating". */
function writeLivePool(dir, extra = {}) {
  writeFileSync(
    join(dir, "sessions.state.json"),
    JSON.stringify({
      version: 1,
      poolPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      control: { pid: process.pid, sessionId: "sid-control" },
      projects: {},
      ...extra,
    }),
  );
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
      join(ROOT, "src", "orchestrator", entry),
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
  return spawnSync(process.execPath, [join(ROOT, "src", "orchestrator", "supervisor.mjs"), ...args], {
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

describe("the pool watchdog", () => {
  it("stops a wedged pool and nothing else", () => {
    const kills = [];
    const kill = (pid, signal) => kills.push([pid, signal]);
    const log = () => {};

    for (const verdict of ["running", "starting", "unresponsive", "gone"]) {
      const result = recoverWedgedPool({
        pool: { live: verdict !== "gone", verdict, poolPid: 4242 },
        kill,
        log,
      });
      assert.equal(result.killed, false, `${verdict} is not wedged`);
    }

    const stopped = recoverWedgedPool({
      pool: { live: true, verdict: "wedged", poolPid: 4242, reason: "tick in flight for 3h" },
      kill,
      log,
    });
    assert.equal(stopped.killed, true);
    assert.deepEqual(kills, [[4242, "SIGTERM"]], "the unit restarts the stopped pool");
  });
});

describe("the route lane's board check", () => {
  it("settles only when the card is assigned or has left todo", () => {
    const opts = { agents: ["alice"] };
    const run = (fields) => () => ({ ok: true, data: { task: fields } });
    assert.equal(readRouteOutcome(opts, "T-1", () => {}, run({ status: "todo", assignee: null })).settled, false);
    assert.equal(
      readRouteOutcome(opts, "T-1", () => {}, run({ status: "todo", assignee: { display_name: "linus" } })).settled,
      true,
    );
    assert.equal(readRouteOutcome(opts, "T-1", () => {}, run({ status: "in_progress", assignee: null })).settled, true);
    const failed = readRouteOutcome(opts, "T-1", () => {}, () => ({ ok: false, error: "board down" }));
    assert.equal(failed.ok, false);
  });
});

describe("the taskctl boundary", () => {
  it("kills a taskctl that never answers instead of wedging the tick", () => {
    const dir = tempDir("tp-cli-timeout-");
    const cli = join(dir, "hang-cli.mjs");
    writeFileSync(cli, "setInterval(() => {}, 1000);\n");

    const started = Date.now();
    const result = runCli({ cli, cliTimeoutMs: 100 }, "alice", ["issue", "list"], {
      actorKind: "system",
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    assert.ok(Date.now() - started < 5_000, "the bound is the child's, not the test's");
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

  it("does not release a lock another process now owns", () => {
    const path = join(tempDir("tp-lock-"), "continue.state.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, pid: 4242, token: "new-holder", startedAt: new Date().toISOString() }),
    );
    const result = releaseContinueLock(path);
    assert.equal(result.released, false, "a slow ex-holder must not delete the new holder's lock");
    assert.equal(result.foreign, true);
    assert.notEqual(loadContinueLock(path), null);
  });
});

describe("continue — the event path needs a live pool", () => {
  const opts = (dir) => ({
    agents: ["alice"],
    actorKind: "claude",
    home: dir,
    repo: dir,
    state: join(dir, "supervisor.state.json"),
    continueState: join(dir, "continue.state.json"),
    continueInterval: 600,
  });

  it("skips an event-triggered turn when no resident pool is live", async () => {
    const dir = tempDir("tp-require-pool-");
    const logs = [];
    let spawned = false;
    let notified = false;
    const code = await runContinue(opts(dir), {
      requirePool: true,
      poolStatus: () => ({ live: false, reason: "no session state" }),
      spawn: async () => {
        spawned = true;
        return { ok: true };
      },
      notify: () => {
        notified = true;
      },
      log: (line) => logs.push(line),
      now: () => 0,
    });
    assert.equal(code, 0);
    assert.equal(spawned, false, "no agent turn is started");
    assert.equal(notified, false, "the timer owns the no-resident alert");
    assert.equal(logs.some((line) => /event dispatch skipped/.test(line)), true);
    assert.equal(existsSync(join(dir, "continue.state.json")), false, "no lock is taken");
  });

  it("still runs the timer turn with no pool (patrol + workflow only)", async () => {
    const dir = tempDir("tp-timer-pool-");
    const logs = [];
    const code = await runContinue(
      { ...opts(dir), dryRun: true },
      {
        poolStatus: () => ({ live: false, reason: "no session state" }),
        notify: () => {},
        log: (line) => logs.push(line),
        now: () => 0,
      },
    );
    assert.equal(code, 0);
    assert.equal(logs.some((line) => /would run patrol → workflow → poll/.test(line)), true);
    assert.equal(logs.some((line) => /event dispatch skipped/.test(line)), false);
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
        join(ROOT, "src", "orchestrator", "supervisor.mjs"),
        "--actor-kind", "claude", "--agent", "alice", "--ping-only", "--once",
        "--state", state, "--log", join(dir, "log"),
        "--cli", script,
      ],
      { encoding: "utf8", env: { ...process.env, TP_SENTINEL: record } },
    );
    assert.equal(sup.status, 0, sup.stderr);
    assert.deepEqual(calls(record), [], "ping must not call taskctl");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(state, "utf8")).running), [], "the dead pid is pruned");
  });

  it("tick dry-run prints the pass order and spawns nothing", () => {
    const dir = tempDir("tp-entry-continue-");
    const record = join(dir, "spawned");
    const bin = join(dir, "bin");
    const run = runSupervisor([
      "--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"),
      "--log", join(dir, "log"), "--continue-state", join(dir, "continue.state.json"),
      "--dry-run",
    ], { TP_FAKE_CLAUDE: record, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /tick: would run patrol → workflow → poll on claude/);
    assert.equal(existsSync(record), false, "dry-run spawns no agent");
    assert.equal(existsSync(join(dir, "continue.state.json")), false, "dry-run takes no lock");
  });
});

// ---------------------------------------------------------------------------
// The deterministic entries against a sentinel CLI
// ---------------------------------------------------------------------------

describe("deterministic entries (dry-run, sentinel CLI)", () => {
  function runWithSentinel(pass, extra = [], { livePool = false } = {}) {
    const dir = tempDir(`tp-entry-${pass}-`);
    if (livePool) writeLivePool(dir);
    // The scan set is the discovered Worker role. Scope it to this temp home so a
    // developer's installed role skills cannot answer for the test.
    const home = join(dir, "home");
    seedRole(home, "claude", "worker", "Worker");
    const { script, record } = sentinelCli(dir);
    const run = runEntry("passes.mjs", [
      "--actor-kind", "claude", "--agent", "alice", "--dry-run",
      "--home", home,
      "--cli", script, "--repo", dir,
      "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      // Keep a developer's installed per-kind config out of the test's scan set.
      "--config", join(dir, ".env.claude"),
      ...extra,
    ], { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir }, pass);
    return { run, record, dir };
  }

  it("poll scans candidates and writes nothing while the pool is resident", () => {
    const { run, record } = runWithSentinel("poll", [], { livePool: true });
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

  it("scans the public pool as the discovered Worker role, not as the writer identity", () => {
    // setup-meerkat may never have run, so no scan-set key exists — none is needed:
    // the Worker role skill is what owns the public pool. The writer identity
    // (`pollbot`, from USER) must not become claimable by accident.
    const dir = tempDir("tp-entry-poll-worker-");
    writeLivePool(dir);
    const home = join(dir, "home");
    const roleDir = join(home, ".claude", "skills", "worker");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "SKILL.md"), "---\nname: worker\n---\n");
    writeFileSync(
      join(roleDir, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "worker", agent: "Worker", lanes: ["worker"] }),
    );
    const { script, record } = sentinelCli(dir);
    // The child inherits this process's env; empty values stand in for absent
    // ones, and the parser treats "" exactly like missing.
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--dry-run",
        "--home", home,
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ],
      {
        TP_SENTINEL: record,
        TASKCTL_AGENT: "",
        USER: "pollbot",
        LOGNAME: "",
      },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    const candidateCall = calls(record).find((call) => call.includes("candidates"));
    assert.ok(candidateCall, "the discovered Worker role must still scan");
    assert.deepEqual(candidateCall.slice(candidateCall.indexOf("issue")), [
      "issue",
      "candidates",
      "--assignee",
      "Worker",
      "--include-unassigned",
      "--stale",
    ]);
  });

  it("scans nothing when no role skill is installed, even with a writer identity", () => {
    // `--agent pollbot` is the loop's *writer* identity. Without a discovered
    // role it is not a claim identity: scanning for it would make an arbitrary
    // name silently claimable.
    const dir = tempDir("tp-entry-poll-noskill-");
    writeLivePool(dir);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const { script, record } = sentinelCli(dir);
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--dry-run", "--agent", "pollbot",
        "--home", home,
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        // Pin the config root: a developer's installed `.env.<kind>` (with a
        // reviewer) must not become part of this test's scan set.
        "--config", join(dir, ".env.claude"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      calls(record).some((call) => call.includes("candidates")),
      false,
      "the writer identity alone is never a scan identity",
    );
  });

  it("poll claims nothing at all without a resident pool", () => {
    const { run, record, dir } = runWithSentinel("poll");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /no resident session pool/);
    const args = calls(record);
    assert.equal(
      args.some((call) => call.includes("candidates")),
      false,
      "no scan, so no card can be claimed",
    );
    assert.equal(existsSync(join(dir, QUEUE_FILES.cards)), false);
  });

  it("poll enqueues an unanswered question without claiming the card", () => {
    const dir = tempDir("tp-question-lane-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    const projectsJson = join(dir, "projects.json");
    writeFileSync(projectsJson, JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    writeLivePool(dir, { version: 2, capabilities: ["question-lane"] });
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "question-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const at = argv.findIndex((a) => a === 'issue' || a === 'comment');",
        "const args = at === -1 ? [] : argv.slice(at);",
        "const status = args.includes('--status') ? args[args.indexOf('--status') + 1] : null;",
        "let data = { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } };",
        "if (args[0] === 'issue' && status === 'in_progress') {",
        "  data = { tasks: [{ identifier: 'T-1', project_id: 'P', kind: 'task', status: 'in_progress', assignee: { display_name: 'alice' } }] };",
        "} else if (args[0] === 'issue' && args.includes('candidates')) {",
        "  data = { candidates: [{ identifier: 'T-1', project: 'P', agent: 'alice', reason: 'stale_same' }] };",
        "} else if (args[0] === 'comment') {",
        "  data = { comments: [{ id: 'c-1', kind: 'question', author_kind: 'agent', body: 'Which option?', created_at: '2026-01-01T00:00:00Z' }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);

    const [row] = readCards(dir).value.cards;
    assert.equal(row.queue_kind, "question");
    assert.equal("kind" in row, false, "the queue row never carries a board card kind");
    assert.equal(row.card, "T-1");
    assert.equal(row.target_dir, app);
    assert.equal(row.question_id, "c-1");
    assert.equal(row.question, "Which option?");
    const argv = calls(record);
    assert.equal(
      argv.some((call) => call.includes("claim")),
      false,
      "the question lane never claims a card",
    );
  });

  it("caps the director's route lane at two dispatches per unowned card", () => {
    const dir = tempDir("tp-route-cap-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    writeLivePool(dir, { version: 2, capabilities: ["question-lane"] });
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "route-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const status = argv.includes('--status') ? argv[argv.indexOf('--status') + 1] : null;",
        "let data = { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } };",
        "if (argv.includes('list') && status === 'todo') {",
        "  data = { tasks: [{ identifier: 'T-9', project_id: 'P', kind: 'task', status: 'todo', assignee: null, updated_at: '2020-01-01T00:00:00Z' }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const args = [
      "--actor-kind", "claude", "--agent", "alice",
      "--cli", script, "--repo", dir,
      "--state", join(dir, "state.json"), "--log", join(dir, "log"),
    ];
    const env = { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir };
    const poll = () => {
      const run = runEntry("passes.mjs", args, env, "poll");
      assert.equal(run.status, 0, run.stderr);
    };
    const routeRows = () => readCards(dir).value.cards.filter((row) => row.id === "route:T-9");
    const finishRows = () => {
      const file = join(dir, "cards.queue.json");
      const value = JSON.parse(readFileSync(file, "utf8"));
      for (const row of value.cards) {
        if (row.id !== "route:T-9" || row.status === "done") continue;
        row.status = "done";
        row.completedAt = new Date().toISOString();
      }
      writeFileSync(file, JSON.stringify(value), "utf8");
    };

    poll();
    assert.equal(routeRows().length, 1, "the first window routes the card");
    finishRows();
    poll();
    assert.equal(routeRows().length, 2, "the second window dispatches once more");
    finishRows();
    poll();
    assert.equal(routeRows().length, 2, "the third window is capped");
    assert.equal(routeRows().some((row) => row.status === "pending"), false);
  });

  it("enqueues one triage row for an accepted card's required handoff", () => {
    const dir = tempDir("tp-triage-lane-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    writeLivePool(dir, { version: 2, capabilities: ["question-lane"] });
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "triage-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const status = argv.includes('--status') ? argv[argv.indexOf('--status') + 1] : null;",
        "let data = { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } };",
        "if (argv.includes('list') && status === 'done') {",
        "  data = { tasks: [{ identifier: 'T-7', project_id: 'P', kind: 'task', status: 'done', title: 'design', delivery_round: 2, status_changed_at: new Date().toISOString(), meta: { stage_handoff: 'required' } }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const args = [
      "--actor-kind", "claude", "--agent", "alice",
      "--cli", script, "--repo", dir,
      "--state", join(dir, "state.json"), "--log", join(dir, "log"),
    ];
    const env = { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir };
    const poll = () => {
      const run = runEntry("passes.mjs", args, env, "poll");
      assert.equal(run.status, 0, run.stderr);
    };
    const rows = () => readCards(dir).value.cards.filter((row) => row.id === "triage:T-7:r2");

    poll();
    const [row] = rows();
    assert.equal(rows().length, 1, "the accepted handoff is offered once");
    assert.equal(row.queue_kind, "question");
    assert.equal(row.role, "triage");
    assert.equal(row.triage, true);
    assert.equal(row.card, "T-7");
    assert.equal(row.agent, "alice");
    assert.equal(row.target_dir, app);
    assert.equal(row.round, 2);

    poll();
    assert.equal(rows().length, 1, "a second poll coalesces the same triage row");
  });

  it("does not offer a card whose worker session is still running", () => {
    const dir = tempDir("tp-poll-running-worker-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    writeLivePool(dir, {
      version: 2,
      capabilities: ["question-lane"],
      projects: { "worker:T-1:r1": { status: "running", sessionId: "sid-1" } },
    });
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "running-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "let data = { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } };",
        "if (argv.includes('candidates')) {",
        "  data = { candidates: [{ identifier: 'T-1', project: 'P', agent: 'alice', status: 'in_progress', reason: 'stale_same' }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      calls(record).some((call) => call.includes("claim")),
      false,
      "a running worker's card is not re-claimed under it",
    );
  });

  it("scans every discovered worker-lane role", () => {
    const dir = tempDir("tp-scan-roles-");
    const home = join(dir, "home");
    const roleDir = join(home, ".codex", "skills", "turing");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "SKILL.md"), "---\nname: turing\n---\n");
    writeFileSync(
      join(roleDir, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "turing", agent: "Turing", lanes: ["worker"] }),
    );
    writeLivePool(dir);
    const { script, record } = sentinelCli(dir);
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "Worker",
        "--home", home, "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        "--config", join(dir, ".env.claude"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      calls(record).some((call) => call.includes("candidates") && call.includes("Turing")),
      "a discovered role is scanned without any hand-kept list",
    );
  });

  it("does not claim a card whose role has no available carrying kind", () => {
    const dir = tempDir("tp-role-unavailable-");
    const home = join(dir, "home");
    const roleDir = join(home, ".codex", "skills", "turing");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, "SKILL.md"), "---\nname: turing\n---\n");
    writeFileSync(
      join(roleDir, "role.json"),
      JSON.stringify({ schema: "meerkat-role", id: "turing", agent: "Turing", lanes: ["worker"] }),
    );
    writeLivePool(dir);
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "candidate-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const assignee = argv.includes('--assignee') ? argv[argv.indexOf('--assignee') + 1] : null;",
        "const candidates = assignee === 'Turing'",
        "  ? [{ identifier: 'T-1', agent: 'Turing', status: 'todo', project_id: 'P', version: 1 }]",
        "  : [];",
        'process.stdout.write(`${JSON.stringify({ ok: true, data: { candidates, tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } } })}\\n`);',
      ].join("\n"),
    );
    // An empty PATH proves neither loop CLI can start; the role is installed on
    // codex only, so the poll must not claim it.
    const bin = join(dir, "empty-bin");
    mkdirSync(bin, { recursive: true });
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--home", home, "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        "--config", join(dir, ".env.claude"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir, PATH: bin },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      calls(record).some((call) => call.includes("claim")),
      false,
      "the card stays todo instead of being claimed and refused at dispatch",
    );
    assert.match(run.stdout + run.stderr, /no available kind|defer T-1/);
  });

  it("reads open questions for the stale filter but enqueues nothing when the pool predates the capability", () => {
    const dir = tempDir("tp-question-lane-old-");
    writeLivePool(dir); // version 1, no capabilities
    const { script, record } = sentinelCli(dir);
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ],
      { TP_SENTINEL: record },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(dir, "cards.queue.json")), false, "no question row for an old pool");
    assert.ok(
      calls(record).some((call) => call.includes("--status") && call.includes("in_progress")),
      "the read still guards a parked card from a stale re-claim",
    );
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

  it("does not start a stale patrol turn for a card parked on a question", () => {
    const dir = tempDir("tp-entry-patrol-parked-");
    writeLivePool(dir);
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "patrol-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const at = argv.findIndex((a) => a === 'issue' || a === 'comment' || a === 'sla');",
        "const args = at === -1 ? [] : argv.slice(at);",
        "let data = { tasks: [], candidates: [], comments: [], alerts: [], config: {} };",
        "if (args[0] === 'issue' && args.includes('list')) {",
        "  data = { tasks: [{ identifier: 'T-1', project_id: 'P', kind: 'task', status: 'in_progress', heartbeat_at: '2020-01-01T00:00:00Z', assignee: { display_name: 'alice' } }] };",
        "} else if (args[0] === 'comment') {",
        "  data = { comments: [{ id: 'q1', kind: 'question', author_kind: 'agent', body: 'Why?', created_at: '2026-01-01T00:00:00Z' }] };",
        "} else if (args[0] === 'sla') {",
        "  data = { alerts: [], config: {} };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice", "--patrol-llm",
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ],
      { TP_SENTINEL: record },
      "patrol",
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /parked on an unanswered question/);
    assert.equal(
      calls(record).some((call) => call.includes("claim")),
      false,
      "a parked question is not re-claimed by the patrol",
    );
  });

  it("workflow asks the board for the plan, and writes nothing in dry-run", () => {
    const { run, record } = runWithSentinel("workflow");
    assert.equal(run.status, 0, run.stderr);
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
    // 0038 — the loop no longer carries a policy copy or a close flag.
    assert.equal(call.includes("--auto-accept-reviews"), false, JSON.stringify(call));
    assert.equal(call.includes("--acceptance"), false, JSON.stringify(call));
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

describe("readOpenQuestions", () => {
  const claimedAt = "2025-12-31T23:00:00Z";
  const task = (identifier, extra = {}) => ({
    identifier,
    project: "P",
    kind: "task",
    status: "in_progress",
    status_changed_at: claimedAt,
    assignee: { display_name: "alice" },
    ...extra,
  });
  const tasks = [
    task("T-1"),
    task("T-2", { review_of_id: "uuid", assignee: { display_name: "jobs" } }),
    task("T-3", { kind: "epic" }),
    task("T-4"),
    task("T-5"),
    // The director released these and a poll re-claimed them: the status
    // changed after the question, so they are settled even though in_progress.
    task("T-6", { status_changed_at: "2026-01-01T00:10:00Z" }),
    task("T-7", { status_changed_at: "2026-01-01T00:10:00Z" }),
  ];
  const comments = {
    "T-1": [{ id: "q1", kind: "question", body: "Why?", created_at: "2026-01-01T00:00:00Z" }],
    "T-2": [{ id: "q2", kind: "question", body: "Why?" }],
    "T-3": [{ id: "q3", kind: "question", body: "Why?" }],
    // A director note is an answer but **not** a release: still open.
    "T-4": [
      { id: "n1", kind: "note", author_kind: "agent", body: "decision: because" },
      { id: "q4", kind: "question", body: "Why?" },
    ],
    // A human answer on an in-progress card still owes a release: open (the
    // console shows it with `answered_pending_release`).
    "T-5": [
      { id: "n2", kind: "note", author_kind: "human", body: "Because." },
      { id: "q5", kind: "question", body: "Why?" },
    ],
    "T-6": [
      { id: "n3", kind: "note", author_kind: "agent", body: "decision: because" },
      { id: "q6", kind: "question", body: "Why?", created_at: "2026-01-01T00:05:00Z" },
    ],
    "T-7": [
      { id: "n4", kind: "note", author_kind: "human", body: "Because." },
      { id: "q7", kind: "question", body: "Why?", created_at: "2026-01-01T00:05:00Z" },
    ],
  };
  const run = (_opts, _agent, args) => {
    if (args[0] === "issue") return { ok: true, data: { tasks } };
    return { ok: true, data: { comments: comments[args[2]] ?? [] } };
  };
  const opts = { agents: ["alice"], boardLimit: 500 };

  it("returns an in_progress task card whose question has not been released", () => {
    const result = readOpenQuestions(opts, () => {}, run);
    assert.deepEqual(result.rows.map((row) => row.ref), ["T-1", "T-4", "T-5"]);
    assert.equal(result.rows[0].project, "P");
    assert.equal(result.rows[0].agent, "alice");
    assert.equal(result.rows[0].question_id, "q1");
    assert.equal(result.rows[0].body, "Why?");
  });

  it("reports an unreadable board instead of throwing", () => {
    const result = readOpenQuestions(opts, () => {}, () => ({ ok: false, error: "down" }));
    assert.equal(result.ok, false);
    assert.equal(result.error, "down");
    assert.deepEqual(result.rows, []);
  });
});

describe("runQuestionTick", () => {
  const question = {
    ref: "T-1",
    project: "P",
    agent: "alice",
    question_id: "q-1",
    body: "Which option?",
    asked_at: null,
  };

  function deps(overrides = {}) {
    const rows = [];
    return {
      questions: [question],
      resolveDir: () => ({ ok: true, dir: "/work/app" }),
      enqueue: (row) => {
        rows.push(row);
        return { ok: true, coalesced: false };
      },
      dispatches: () => 0,
      log: () => {},
      rows,
      ...overrides,
    };
  }

  it("enqueues one question row for the resolved directory", () => {
    const d = deps();
    const result = runQuestionTick(d);
    assert.equal(result.enqueued, 1);
    assert.equal(d.rows[0].queue_kind, "question");
    assert.equal(d.rows[0].id, "question:T-1:q-1");
    assert.equal(d.rows[0].target_dir, "/work/app");
    assert.equal(d.rows[0].question_id, "q-1");
  });

  it("stops at the attempt cap", () => {
    const d = deps({ dispatches: () => 2 });
    assert.equal(runQuestionTick(d).enqueued, 0);
    assert.deepEqual(d.rows, []);
  });

  it("skips an unmapped project", () => {
    const d = deps({ resolveDir: () => ({ ok: false, code: "PROJECT_DIR_UNMAPPED" }) });
    const result = runQuestionTick(d);
    assert.equal(result.skipped, 1);
    assert.deepEqual(d.rows, []);
  });

  it("treats a coalesced row as skipped", () => {
    const d = deps({ enqueue: () => ({ ok: true, coalesced: true }) });
    assert.equal(runQuestionTick(d).enqueued, 0);
  });
});

describe("readCardForRedispatch", () => {
  const opts = { agents: ["alice"] };

  it("returns the live status a retry must consult", () => {
    const result = readCardForRedispatch(
      opts,
      "T-1",
      () => {},
      () => ({ ok: true, data: { task: { status: "in_review" } } }),
    );
    assert.deepEqual(result, { ok: true, status: "in_review", error: null });
  });

  it("returns an unreadable check instead of throwing", () => {
    const result = readCardForRedispatch(
      opts,
      "T-1",
      () => {},
      () => ({ ok: false, error: "down" }),
    );
    assert.deepEqual(result, { ok: false, status: null, error: "down" });
  });
});

// ---------------------------------------------------------------------------
// The resident poll dispatch — admit, then enqueue
// ---------------------------------------------------------------------------

describe("the resident poll dispatch", () => {
  function fixture(concurrency = 2) {
    const dir = tempDir("tp-poll-dispatch-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    const projectsJson = join(dir, "projects.json");
    writeFileSync(projectsJson, JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    const opts = { projectsJson, actorKind: "claude", dryRun: false };
    // Admission registers the brief watch before the claim; these cases are
    // about admission/dispatch, so the hub is a stub (no socket).
    const watchCards = () => ({ ok: true, running: true });
    return { dir, app, projectsJson, opts, concurrency, watchCards };
  }

  it("writes the worker handoff with the resolved project directory", async () => {
    const f = fixture();
    const admission = createProjectAdmission({ opts: f.opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const action = { identifier: "T-1", agent: "alice", reason: "ready" };
    const card = { id: "uuid-1", identifier: "T-1", project: "P", title: "do it" };
    assert.equal((await admission.admit(action, card)).ok, true);
    const dispatch = createQueueDispatch({
      opts: f.opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    const outcome = await dispatch(action, card);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.queued, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.card, "T-1");
    assert.equal(entry.role, "worker");
    assert.equal(entry.agent, "alice");
    assert.equal(entry.target_dir, f.app);
    assert.equal(entry.task_id, "uuid-1", "the subscriber locates the row by UUID");
    assert.equal(entry.review_of, null);
    assert.equal(entry.review_round, null);
    assert.match(entry.handoff, /^You are the worker for the P project/);
    assert.match(entry.handoff, /\.meerkat\/T-1\/card\.md/);
    assert.equal(entry.handoff.includes("/meerkat-loop"), false, "a handoff is not a continue turn");
  });

  it("carries the role's platform and an inline envelope while the supervisor keeps its own kind", async () => {
    const f = fixture();
    const turing = {
      id: "turing",
      agent: "Turing",
      lanes: ["worker"],
      title: "Verification",
      summary: "",
      responsibilities: [],
      boundaries: [],
      shapes: [],
      skillDir: "/roles/codex/turing",
      platform: "codex",
      installedOn: ["codex"],
      workflow: "/roles/codex/turing/SKILL.md",
      selfCheck: null,
      reviewerPrompt: null,
      defaultReviewer: false,
      variants: {},
    };
    const opts = {
      ...f.opts,
      roles: {
        roles: [turing],
        defaultReviewer: null,
        decisionPolicy: { path: null },
        routing: { source: "skills", text: "" },
        warnings: [],
      },
    };
    const admission = createProjectAdmission({
      opts,
      projectConcurrency: 1,
      watchCards: f.watchCards,
    });
    const action = { identifier: "T-1", agent: "Turing", reason: "ready" };
    const card = { id: "uuid-1", identifier: "T-1", project: "P", title: "x" };
    assert.equal((await admission.admit(action, card)).ok, true);
    const dispatch = createQueueDispatch({
      opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    assert.equal((await dispatch(action, card)).ok, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.actor_kind, "codex", "the row runs on the kind carrying the role");
    assert.equal(opts.actorKind, "claude", "the supervisor still claims as its own kind");
    assert.match(
      entry.handoff,
      /Flags: --agent Turing --actor-kind=codex/,
      "an inline lane gets the attribution line in the envelope, not an opener",
    );
    assert.match(entry.handoff, /Carry these Flags/);
    assert.doesNotMatch(
      entry.handoff,
      /\/roles\/codex\/turing\/SKILL\.md/,
      "the adapter loads the skill at open, so the envelope does not repeat its path",
    );
    assert.doesNotMatch(entry.handoff, /## Team role/, "the role layer is in the loaded skill");
  });

  it("refuses to enqueue when no platform carries the role", async () => {
    const f = fixture();
    const opts = {
      ...f.opts,
      kindAvailable: () => false,
      roles: {
        roles: [
          {
            id: "turing",
            agent: "Turing",
            lanes: ["worker"],
            installedOn: ["codex"],
            platform: "codex",
            skillDir: "/roles/turing",
            workflow: "/roles/turing/SKILL.md",
          },
        ],
        defaultReviewer: null,
        decisionPolicy: { path: null },
        warnings: [],
      },
    };
    const admission = createProjectAdmission({
      opts,
      projectConcurrency: 1,
      watchCards: f.watchCards,
    });
    const action = { identifier: "T-1", agent: "Turing", reason: "ready" };
    const card = { id: "uuid-1", identifier: "T-1", project: "P", title: "x" };
    await admission.admit(action, card);
    const dispatch = createQueueDispatch({
      opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    const outcome = await dispatch(action, card);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /no available platform carries role/);
    assert.equal(readCards(f.dir).value.cards.length, 0, "no row is written for an unreachable role");
  });

  it("warns once when parallel workers share a git checkout", async () => {
    const f = fixture();
    mkdirSync(join(f.app, ".git"), { recursive: true });
    assert.equal(isGitCheckout(f.app), true);

    const lines = [];
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 2,
      watchCards: f.watchCards,
      log: (line) => lines.push(line),
    });
    const admit = (ref) =>
      admission.admit({ identifier: ref, agent: "alice" }, { identifier: ref, project: "P" });
    assert.equal((await admit("T-1")).ok, true);
    assert.equal((await admit("T-2")).ok, true);
    assert.equal(
      lines.filter((line) => /shared git checkout/.test(line)).length,
      1,
      "the warning is per directory, not per card",
    );

    const singleLines = [];
    const single = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      watchCards: f.watchCards,
      log: (line) => singleLines.push(line),
    });
    await single.admit({ identifier: "T-3", agent: "alice" }, { identifier: "T-3", project: "P" });
    assert.equal(
      singleLines.filter((line) => /shared git checkout/.test(line)).length,
      0,
      "a single worker per directory needs no warning",
    );
  });

  it("routes a review card to the reviewer handoff and registers both briefs", async () => {
    const f = fixture();
    const watched = [];
    const watchCards = (cards) => {
      watched.push(cards.map((entry) => entry.ref));
      return { ok: true, running: true };
    };
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      watchCards,
    });
    const action = { identifier: "T-2", agent: "jobs", reason: "ready" };
    const card = {
      id: "uuid-2",
      identifier: "T-2",
      project: "P",
      review_of: "T-1",
      review_round: 1,
    };
    assert.equal((await admission.admit(action, card)).ok, true);
    assert.deepEqual(watched, [["T-2", "T-1"]], "one registration, the review card and its original");
    const dispatch = createQueueDispatch({
      opts: f.opts,
      config: { reviewers: ["jobs"], reviewerWorkers: [] },
      stateDir: f.dir,
      admission,
    });
    assert.equal((await dispatch(action, card)).ok, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.role, "reviewer");
    assert.equal(entry.target_dir, f.app);
    assert.equal(entry.task_id, "uuid-2");
    assert.equal(entry.review_of, "T-1");
    assert.equal(entry.review_round, 1);
    assert.match(entry.handoff, /^You are the reviewer for the P project/);
    assert.match(entry.handoff, /Review brief: \.meerkat\/T-2\/card\.md/);
    assert.match(entry.handoff, /Original brief: \.meerkat\/T-1\/card\.md/);
    assert.deepEqual(watched, [["T-2", "T-1"]], "the claim event refreshes it; no second export");
  });

  it("defers an unmapped project before the claim", async () => {
    const f = fixture();
    const admission = createProjectAdmission({ opts: f.opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const verdict = await admission.admit(
      { identifier: "T-3", agent: "alice" },
      { identifier: "T-3", project: "other" },
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /UNMAPPED|no local directory/);
    assert.equal(admission.dirFor("T-3"), null, "nothing was admitted");
  });

  it("defers a card that names no project", async () => {
    const f = fixture();
    const admission = createProjectAdmission({ opts: f.opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const verdict = await admission.admit({ identifier: "T-4", agent: "alice" }, { identifier: "T-4" });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /no project/);
  });

  it("counts live and queued work against the per-project cap", async () => {
    const f = fixture();
    const watched = [];
    const watchCards = (cards) => {
      watched.push(cards.map((entry) => entry.ref));
      return { ok: true, running: true };
    };
    const full = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      liveByDir: new Map([[f.app, 1]]),
      watchCards,
    });
    const verdict = await full.admit({ identifier: "T-5", agent: "alice" }, { identifier: "T-5", project: "P" });
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /concurrency cap/);

    const queued = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      queuedByDir: new Map([[f.app, 1]]),
      watchCards,
    });
    assert.equal(
      (await queued.admit({ identifier: "T-6", agent: "alice" }, { identifier: "T-6", project: "P" })).ok,
      false,
    );
    assert.deepEqual(watched, [], "a card at its cap is not registered");
  });

  it("admits at most the project cap within one pass", async () => {
    const f = fixture();
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      watchCards: f.watchCards,
    });
    const card = (id) => ({ identifier: id, project: "P" });
    assert.equal((await admission.admit(card("T-7"), card("T-7"))).ok, true);
    assert.equal((await admission.admit(card("T-8"), card("T-8"))).ok, false);
  });

  it("registers the brief before the claim, and defers unclaimed if it fails", async () => {
    const f = fixture();
    const order = [];
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      watchCards: (cards) => {
        order.push(`watch:${cards[0].ref}`);
        return { ok: true, running: true };
      },
    });
    const card = { id: "uuid-1", identifier: "T-1", project: "P", title: "do it" };
    const result = await runPollTick({
      agents: ["alice"],
      registry: { running: {} },
      config: {},
      readCandidates: () => [{ ...card, agent: "alice", reason: "ready" }],
      claim: async () => {
        order.push("claim");
        return { ok: true };
      },
      dispatch: async () => {
        order.push("dispatch");
        return { ok: true };
      },
      admit: admission.admit,
      now: () => "2026-10-22T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(result.claimed, 1);
    assert.deepEqual(order, ["watch:T-1", "claim", "dispatch"]);

    const failed = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      watchCards: () => ({ ok: false, error: "disk full" }),
    });
    const touched = [];
    const second = await runPollTick({
      agents: ["alice"],
      registry: { running: {} },
      config: {},
      readCandidates: () => [{ ...card, identifier: "T-9", agent: "alice" }],
      claim: async (id) => {
        touched.push(id);
        return { ok: true };
      },
      dispatch: async () => {
        touched.push("dispatch");
        return { ok: true };
      },
      admit: failed.admit,
      now: () => "2026-10-22T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(second.deferred, 1);
    assert.equal(second.claimed, 0);
    assert.deepEqual(touched, [], "no claim and no dispatch");
    assert.equal(failed.dirFor("T-9"), null, "nothing was admitted");
  });

  it("defers a card whose brief is already terminal", async () => {
    const f = fixture();
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      watchCards: () => ({ ok: true, running: false, reason: "terminal" }),
    });
    const verdict = await admission.admit(
      { identifier: "T-10", agent: "alice" },
      { identifier: "T-10", project: "P" },
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /already terminal/);
    assert.equal(admission.dirFor("T-10"), null);
  });

  it("gives the project slot back when a claim is refused", async () => {
    const f = fixture(1);
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      watchCards: () => ({ ok: true, running: true }),
      stopWatch: async () => ({ ok: true, stopped: true }),
    });
    assert.equal((await admission.admit({ identifier: "T-20", agent: "alice" }, { identifier: "T-20", project: "P" })).ok, true);
    assert.equal((await admission.admit({ identifier: "T-21", agent: "alice" }, { identifier: "T-21", project: "P" })).ok, false);
    await admission.release("T-20");
    assert.equal(
      (await admission.admit({ identifier: "T-22", agent: "alice" }, { identifier: "T-22", project: "P" })).ok,
      true,
      "the refused claim returned its slot",
    );
  });

  it("records only an owned registration for release, addressed by a registered card", async () => {
    const f = fixture();
    const stopped = [];
    const reviewPath = join(f.app, ".meerkat", "T-2", "card.md");
    const watchCards = () => ({
      ok: true,
      owned: true,
      running: true,
      registrationId: "reg-review",
      // The hub registered only the review card: the original was covered by a
      // live detached registration made when it was dispatched.
      cards: [{ ref: "T-2", identifier: "T-2", task_id: "uuid-2", status: "todo", path: reviewPath }],
    });
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      watchCards,
      stopWatch: async (target) => {
        stopped.push(target);
        return { ok: true, stopped: true };
      },
    });
    const card = { id: "uuid-2", identifier: "T-2", project: "P", review_of: "T-1", review_round: 1 };
    assert.equal((await admission.admit({ identifier: "T-2", agent: "jobs" }, card)).ok, true);
    await admission.release("T-2");
    assert.deepEqual(
      stopped,
      [{ ref: "T-2", out: reviewPath }],
      "release addresses the card the hub registered, not the covered original",
    );
  });

  it("does not release a registration this pass did not create", async () => {
    const f = fixture(1);
    const stopped = [];
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 1,
      watchCards: () => ({
        ok: true,
        owned: false,
        reused: true,
        running: true,
        reason: "covered",
        registrationId: null,
        cards: [],
      }),
      stopWatch: async (target) => {
        stopped.push(target);
        return { ok: true, stopped: true };
      },
    });
    const card = { identifier: "T-3", project: "P", review_of: "T-1" };
    assert.equal((await admission.admit({ identifier: "T-3", agent: "jobs" }, card)).ok, true);
    await admission.release("T-3");
    assert.deepEqual(stopped, [], "a covered registration belongs to another owner");
    assert.equal(
      (await admission.admit({ identifier: "T-4", agent: "alice" }, { identifier: "T-4", project: "P" })).ok,
      true,
      "release still gives the project slot back",
    );
  });

  it("admits and enqueues a review card whose original is already watched", async () => {
    const f = fixture();
    const reviewPath = join(f.app, ".meerkat", "T-5", "card.md");
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      watchCards: () => ({
        ok: true,
        owned: true,
        running: true,
        registrationId: "reg-review",
        cards: [{ ref: "T-5", identifier: "T-5", task_id: "uuid-5", status: "todo", path: reviewPath }],
      }),
    });
    const card = { id: "uuid-5", identifier: "T-5", project: "P", review_of: "T-1", review_round: 1 };
    const dispatch = createQueueDispatch({
      opts: f.opts,
      config: { reviewers: ["jobs"], reviewerWorkers: [] },
      stateDir: f.dir,
      admission,
    });
    const result = await runPollTick({
      agents: ["jobs"],
      registry: { running: {} },
      config: {},
      readCandidates: () => [{ ...card, agent: "jobs", reason: "ready" }],
      claim: async () => ({ ok: true }),
      dispatch,
      admit: admission.admit,
      now: () => "2026-10-22T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(result.claimed, 1);
    assert.equal(result.deferred, 0, "a covered original does not defer the review");
    assert.equal(result.spawned, 1);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.card, "T-5");
    assert.equal(entry.role, "reviewer");
  });

  it("releases the registration when the claim is refused", async () => {
    const released = [];
    const result = await runPollTick({
      agents: ["alice"],
      registry: { running: {} },
      config: {},
      readCandidates: () => [{ identifier: "T-11", agent: "alice", project: "P", reason: "ready" }],
      claim: async () => ({ ok: false, error: "CLAIM_CONFLICT" }),
      dispatch: async () => {
        throw new Error("a refused claim must not dispatch");
      },
      admit: async () => ({ ok: true }),
      release: async (identifier) => {
        released.push(identifier);
      },
      now: () => "2026-10-22T00:00:00.000Z",
      log: () => {},
    });
    assert.equal(result.conflicts, 1);
    assert.deepEqual(released, ["T-11"]);
  });

  it("writes nothing in dry-run", async () => {
    const f = fixture();
    const opts = { ...f.opts, dryRun: true };
    const watchCalls = [];
    const admission = createProjectAdmission({
      opts,
      projectConcurrency: f.concurrency,
      watchCards: (cards) => {
        watchCalls.push(cards);
        return { ok: true, running: true };
      },
    });
    const action = { identifier: "T-9", agent: "alice" };
    const card = { identifier: "T-9", project: "P" };
    await admission.admit(action, card);
    assert.deepEqual(watchCalls, [], "dry-run registers no watch");
    const dispatch = createQueueDispatch({ opts, config: {}, stateDir: f.dir, admission });
    const outcome = await dispatch(action, card);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.dryRun, true);
    assert.equal(readCards(f.dir).value.cards.length, 0);
  });
});

describe("the tick runs the passes in-process", () => {
  function fakeClaude(dir) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const record = join(dir, "args.txt");
    const script = join(bin, "claude");
    writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TP_FAKE_CLAUDE"\n', "utf8");
    chmodSync(script, 0o755);
    return { bin, record, env: { TP_FAKE_CLAUDE: record, PATH: `${bin}:${process.env.PATH}` } };
  }

  function tickArgs(dir, extra = []) {
    // Pin discovery to this temp home: the poll must scan the seeded role, not a
    // developer's installed skill tree.
    const home = join(dir, "home");
    seedRole(home, "claude", "worker", "Worker");
    return [
      "--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--home", home,
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", join(dir, "continue.state.json"),
      "--config", join(dir, ".env.claude"),
      ...extra,
    ];
  }

  it("runs patrol, workflow and poll and spawns no agent", () => {
    const dir = tempDir("tp-tick-inprocess-");
    const fake = fakeClaude(dir);
    const { script, record } = sentinelCli(dir);
    writeLivePool(dir);
    const run = runSupervisor(tickArgs(dir, ["--cli", script]), {
      ...fake.env,
      TP_SENTINEL: record,
    });
    assert.equal(run.status, 0, run.stderr);
    const boardCalls = calls(record).map((argv) => argv.join(" "));
    assert.ok(boardCalls.some((line) => line.includes("issue candidates")), "poll scanned");
    assert.ok(boardCalls.some((line) => line.includes("issue reconcile") || line.includes("issue list")), "workflow/patrol read");
    assert.equal(existsSync(fake.record), false, "the supervisor must not spawn an agent");
    assert.equal(existsSync(join(dir, "continue.state.json")), false, "the tick lock is released");
  });

  it("runs the tick even with --resident=no", () => {
    const dir = tempDir("tp-tick-resident-no-");
    const fake = fakeClaude(dir);
    const { script, record } = sentinelCli(dir);
    writeLivePool(dir);
    const run = runSupervisor(tickArgs(dir, ["--resident=no", "--cli", script]), {
      ...fake.env,
      TP_SENTINEL: record,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(calls(record).length > 0, "the deterministic passes still run");
  });

  it("notifies once per cadence that dispatch is paused", () => {
    const dir = tempDir("tp-tick-notify-");
    const fake = fakeClaude(dir);
    const { script } = sentinelCli(dir);
    const out = join(dir, "notify.json");
    const notifier = join(dir, "notify.mjs");
    writeFileSync(
      notifier,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'writeFileSync(process.env.TP_NOTIFY_OUT, readFileSync(0, "utf8"));',
      ].join("\n"),
      "utf8",
    );
    const run = runSupervisor(
      tickArgs(dir, ["--cli", script, "--notify", `${process.execPath} ${notifier}`]),
      { ...fake.env, TP_NOTIFY_OUT: out },
    );
    assert.equal(run.status, 0, run.stderr);
    const alert = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(alert.kind, "no_resident");
    assert.match(alert.message, /dispatch is paused/);
  });

  it("skips while a live tick holds the lock", () => {
    const dir = tempDir("tp-tick-lock-");
    const { script, record } = sentinelCli(dir);
    const lock = join(dir, "continue.state.json");
    writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }));
    const run = runSupervisor(tickArgs(dir, ["--cli", script]), { TP_SENTINEL: record });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /still running/);
    assert.deepEqual(calls(record), [], "no pass runs while another tick holds the lock");
  });
});

// ---------------------------------------------------------------------------
// The crash boundary every entry installs
// ---------------------------------------------------------------------------

describe("the loop entries install the crash boundary", () => {
  const ENTRIES = ["supervisor.mjs", "passes.mjs", "subscribe.mjs", "status.mjs", "console.mjs"];

  it("installs it inside the entry-point block, before main() can run", () => {
    for (const entry of ENTRIES) {
      const source = readFileSync(join(ROOT, "src", "orchestrator", entry), "utf8");
      assert.match(
        source,
        /import \{ installEntryCrashGuard \} from "\.\.\/foundation\/crash-guard\.mjs";/,
        `${entry} does not import the crash guard`,
      );
      const blockAt = source.indexOf("if (isEntryPoint(import.meta.url))");
      const guardAt = source.indexOf("installEntryCrashGuard(");
      const mainAt = source.indexOf("main(process.argv.slice(2)).then");
      assert.ok(blockAt !== -1, `${entry} has no entry-point block`);
      assert.ok(guardAt !== -1, `${entry} never installs the crash guard`);
      assert.ok(
        blockAt < guardAt,
        `${entry} installs the guard on import; importing an entry must change nothing`,
      );
      assert.ok(mainAt > guardAt, `${entry} runs main() before the guard is installed`);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-card worktree admission
// ---------------------------------------------------------------------------

describe("worktree admission", () => {
  function fixture() {
    const dir = tempDir("tp-worktree-admission-");
    const app = join(dir, "app");
    mkdirSync(join(app, ".git"), { recursive: true });
    const projectsJson = join(dir, "projects.json");
    writeFileSync(projectsJson, JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    return {
      dir,
      app,
      opts: { projectsJson, actorKind: "claude", dryRun: false },
      watchCards: () => ({ ok: true, running: true }),
    };
  }

  const gitRunner = (calls) => (cmd, argv) => {
    calls.push(argv);
    if (argv.includes("rev-parse")) return { status: 0, stdout: "dev\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  const admissionFor = (f, runGit) =>
    createProjectAdmission({
      opts: f.opts,
      projectConcurrency: 2,
      stateDir: f.dir,
      workspaceMode: "worktree",
      runGit,
      watchCards: f.watchCards,
    });

  it("admits a worker into its own worktree and records the lane", async () => {
    const f = fixture();
    const calls = [];
    const admission = admissionFor(f, gitRunner(calls));
    const action = { identifier: "T-1", agent: "alice" };
    const card = { id: "u1", identifier: "T-1", project: "P", delivery_round: 1 };
    assert.equal((await admission.admit(action, card)).ok, true);

    const wt = join(f.app, ".worktrees", "T-1");
    assert.equal(admission.dirFor("T-1"), wt);
    const record = findWorkspace(f.dir, { identifier: "T-1", round: 1 });
    assert.equal(record.path, wt);
    assert.equal(record.branch, "lane/T-1");
    assert.equal(record.project_dir, f.app);
    assert.ok(calls.some((argv) => argv.includes("worktree") && argv.includes("add")));

    const dispatch = createQueueDispatch({
      opts: f.opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    assert.equal((await dispatch(action, card)).ok, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.target_dir, wt, "the worker runs in the worktree");
    assert.equal(entry.project_dir, f.app, "the project checkout stays the role root");
    assert.equal(entry.workspace.branch, "lane/T-1");
    assert.equal(entry.round, 1);
  });

  it("defers instead of falling back when the worktree cannot be created", async () => {
    const f = fixture();
    const runGit = (cmd, argv) =>
      argv.includes("rev-parse")
        ? { status: 0, stdout: "dev\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "fatal: nope" };
    const admission = admissionFor(f, runGit);
    const result = await admission.admit(
      { identifier: "T-2", agent: "alice" },
      { identifier: "T-2", project: "P", delivery_round: 1 },
    );
    assert.equal(result.ok, false);
    assert.match(result.why, /WORKSPACE_CREATE_FAILED/);
    assert.equal(result.code, "WORKSPACE_CREATE_FAILED");
    assert.equal(result.accounted, true);
    assert.equal(admission.dirFor("T-2"), null);
    assert.equal(findWorkspace(f.dir, { identifier: "T-2" }), null, "nothing is registered");
  });

  it("reproduces TP-0009: a missing previous lane branch falls back and admits", async () => {
    const f = fixture();
    upsertWorkspaceRecord(f.dir, {
      identifier: "T-3",
      round: 1,
      path: join(f.app, ".worktrees", "T-3"),
      branch: "lane/T-3",
      project_dir: f.app,
    });
    const refAware = (cmd, argv) => {
      const key = argv.join(" ");
      if (key.includes("rev-parse --verify --quiet")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (key.includes("rev-parse --abbrev-ref HEAD")) {
        return { status: 0, stdout: "dev\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const admission = admissionFor(f, refAware);
    const result = await admission.admit(
      { identifier: "T-3", agent: "alice" },
      { identifier: "T-3", project: "P", delivery_round: 2 },
    );
    assert.equal(result.ok, true, "a dead previous branch no longer blocks admission");
    const record = findWorkspace(f.dir, { identifier: "T-3", round: 2 });
    assert.equal(record.base_ref, "dev", "the missing previous branch is not used");
    assert.equal(record.branch, "lane/T-3-r2");
  });

  it("fails a review admission when the original workspace is gone, never using the shared tree", async () => {
    const f = fixture();
    upsertWorkspaceRecord(f.dir, {
      identifier: "T-0",
      round: 1,
      path: join(f.app, ".worktrees", "T-0"),
      branch: "lane/T-0",
      project_dir: f.app,
    });
    const admission = admissionFor(f, gitRunner([]));
    const result = await admission.admit(
      { identifier: "R-1", agent: "alice" },
      {
        identifier: "R-1",
        project: "P",
        review_of: "T-0",
        review_round: 1,
        delivery_round: 1,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKSPACE_REVIEW_TARGET_MISSING");
    assert.equal(result.accounted, true);
    assert.equal(admission.dirFor("R-1"), null, "no shared-tree fallback");
  });

  it("routes a review into the original card's worktree", async () => {
    const f = fixture();
    const admission = admissionFor(f, gitRunner([]));
    await admission.admit(
      { identifier: "T-1", agent: "alice" },
      { identifier: "T-1", project: "P", delivery_round: 1 },
    );
    const worktree = admission.dirFor("T-1");
    // The injected git runner does not create the tree; the routing check is
    // about a usable checkout, so materialise one.
    mkdirSync(join(worktree, ".git"), { recursive: true });
    const review = await admission.admit(
      { identifier: "T-9", agent: "jobs" },
      { identifier: "T-9", project: "P", review_of: "T-1", review_round: 1 },
    );
    assert.equal(review.ok, true);
    assert.equal(admission.dirFor("T-9"), worktree, "the reviewer sees the delivered tree");
  });
});

describe("poll deferral accounting", () => {
  const card = { identifier: "T-1", project: "P", delivery_round: 2 };
  const base = (overrides = {}) => ({
    agents: ["alice"],
    registry: { running: {} },
    config: {},
    readCandidates: () => [{ ...card, agent: "alice", reason: "ready" }],
    claim: async () => ({ ok: true }),
    dispatch: async () => ({ ok: true }),
    now: () => "2026-10-22T00:00:00.000Z",
    log: () => {},
    ...overrides,
  });

  it("counts a card-scoped admission failure and clears it on success", async () => {
    const recorded = [];
    const cleared = [];
    const failing = await runPollTick(
      base({
        admit: async () => ({
          ok: false,
          why: "WORKSPACE_CREATE_FAILED: x",
          code: "WORKSPACE_CREATE_FAILED",
          accounted: true,
        }),
        recordDefer: (id, failure) => recorded.push({ id, failure }),
        clearDeferral: (id) => cleared.push(id),
      }),
    );
    assert.equal(failing.deferred, 1);
    assert.deepEqual(recorded, [
      {
        id: "T-1",
        failure: {
          code: "WORKSPACE_CREATE_FAILED",
          reason: "WORKSPACE_CREATE_FAILED: x",
          round: 2,
          version: null,
        },
      },
    ]);
    assert.deepEqual(cleared, []);

    const ok = await runPollTick(
      base({
        admit: async () => ({ ok: true }),
        recordDefer: (id, failure) => recorded.push({ id, failure }),
        clearDeferral: (id) => cleared.push(id),
      }),
    );
    assert.equal(ok.claimed, 1);
    assert.deepEqual(cleared, ["T-1"]);
  });

  it("does not count backpressure or a terminal card", async () => {
    const recorded = [];
    const defer = (admitted) =>
      runPollTick(
        base({
          admit: async () => admitted,
          recordDefer: (id, failure) => recorded.push({ id, failure }),
        }),
      );
    await defer({
      ok: false,
      why: "project P is at its concurrency cap",
      code: "ADMISSION_CONCURRENCY_CAP",
      accounted: false,
    });
    await defer({
      ok: false,
      why: "card is already terminal (terminal)",
      code: "ADMISSION_CARD_TERMINAL",
      accounted: false,
    });
    assert.deepEqual(recorded, []);
  });

  it("does not count a claim-budget defer", async () => {
    const recorded = [];
    const result = await runPollTick(
      base({
        limit: 0,
        admit: async () => {
          throw new Error("admit must not run when the budget is zero");
        },
        recordDefer: (id, failure) => recorded.push({ id, failure }),
      }),
    );
    assert.equal(result.deferred, 1);
    assert.deepEqual(recorded, []);
  });

  it("releases the reservation when dispatch fails", async () => {
    const released = [];
    const result = await runPollTick(
      base({
        admit: async () => ({ ok: true }),
        dispatch: async () => ({ ok: false, error: "spawn failed" }),
        release: async (id) => released.push(id),
      }),
    );
    assert.equal(result.failed, 1);
    assert.deepEqual(released, ["T-1"]);
  });
});
