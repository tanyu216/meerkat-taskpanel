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
import { runContinue, runPollTick, runQuestionTick } from "../../src/orchestrator/runners.mjs";
import {
  acquireContinueLock,
  loadContinueLock,
  readCardForRedispatch,
  recordContinuePid,
  releaseContinueLock,
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
    assert.equal(logs.some((line) => /no resident session pool/.test(line)), true);
    assert.equal(logs.some((line) => /would run:/.test(line)), true);
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

  it("continue dry-run prints the prompt and spawns nothing", () => {
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
    assert.match(run.stderr, /component=supervisor msg="\/meerkat-loop Continue/);
    assert.match(run.stderr, /continue: would run: claude/);
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
    const { script, record } = sentinelCli(dir);
    const run = runEntry("passes.mjs", [
      "--actor-kind", "claude", "--agent", "alice", "--dry-run",
      "--cli", script, "--repo", dir,
      "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      ...extra,
    ], { TP_SENTINEL: record }, pass);
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

  it("poll with no team list still scans the public pool as the default agent", () => {
    // setup-meerkat may never have run, so MEERKAT_TASKPANEL_AGENTS is absent.
    // The fallback identity must still reach the scan, and the public pool must
    // be requested — otherwise an empty-assignee card is never picked up.
    const dir = tempDir("tp-entry-poll-unset-");
    writeLivePool(dir);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
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
        MEERKAT_TASKPANEL_AGENTS: "",
        TASKCTL_AGENT: "",
        USER: "pollbot",
        LOGNAME: "",
      },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    const candidateCall = calls(record).find((call) => call.includes("candidates"));
    assert.ok(candidateCall, "the fallback identity must still scan");
    assert.deepEqual(candidateCall.slice(candidateCall.indexOf("issue")), [
      "issue",
      "candidates",
      "--assignee",
      "pollbot",
      "--include-unassigned",
      "--stale",
    ]);
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
        "  data = { tasks: [{ identifier: 'T-1', project: 'P', kind: 'task', status: 'in_progress', assignee: { display_name: 'alice' } }] };",
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

  it("does not use the question lane when the pool predates the capability", () => {
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
    assert.equal(
      calls(record).some((call) => call.includes("--status") && call.includes("in_progress")),
      false,
      "the question read is not made at all",
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
  const tasks = [
    { identifier: "T-1", project: "P", kind: "task", assignee: { display_name: "alice" } },
    { identifier: "T-2", project: "P", kind: "task", review_of_id: "uuid", assignee: { display_name: "jobs" } },
    { identifier: "T-3", project: "P", kind: "epic" },
    { identifier: "T-4", project: "P", kind: "task", assignee: { display_name: "alice" } },
    { identifier: "T-5", project: "P", kind: "task", assignee: { display_name: "alice" } },
  ];
  const comments = {
    "T-1": [{ id: "q1", kind: "question", body: "Why?", created_at: "2026-01-01T00:00:00Z" }],
    "T-2": [{ id: "q2", kind: "question", body: "Why?" }],
    "T-3": [{ id: "q3", kind: "question", body: "Why?" }],
    // Newer project-session note: settled by the middle rung.
    "T-4": [
      { id: "n1", kind: "note", author_kind: "agent", body: "decision: because" },
      { id: "q4", kind: "question", body: "Why?" },
    ],
    // Newer human comment: settled by the person.
    "T-5": [
      { id: "n2", kind: "note", author_kind: "human", body: "Because." },
      { id: "q5", kind: "question", body: "Why?" },
    ],
  };
  const run = (_opts, _agent, args) => {
    if (args[0] === "issue") return { ok: true, data: { tasks } };
    return { ok: true, data: { comments: comments[args[2]] ?? [] } };
  };
  const opts = { agents: ["alice"], boardLimit: 500 };

  it("returns only an in_progress task card whose newest question is unsettled", () => {
    const result = readOpenQuestions(opts, () => {}, run);
    assert.deepEqual(result.rows.map((row) => row.ref), ["T-1"]);
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
    assert.match(entry.handoff, /^You are a worker subagent of the P project session/);
    assert.match(entry.handoff, /\.meerkat\/T-1\/card\.md/);
    assert.equal(entry.handoff.includes("/meerkat-loop"), false, "a handoff is not a continue turn");
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
    assert.match(entry.handoff, /^You are a reviewer subagent of the P project session/);
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

  it("starts the agent with -p and a prompt that begins with /meerkat-loop", () => {
    const dir = tempDir("tp-continue-spawn-");
    const fake = fakeClaude(dir);
    const state = join(dir, "state.json");
    const lock = join(dir, "continue.state.json");
    const run = runSupervisor(["--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", state, "--log", join(dir, "log"),
      "--continue-state", lock,
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(waitFor(fake.record), "the fake agent was not started");
    const argv = readFileSync(fake.record, "utf8").split("\n");
    const text = argv.slice(1).join("\n");
    assert.equal(argv[0], "-p");
    assert.ok(argv[1].startsWith("/meerkat-loop Continue"), argv[1].slice(0, 48));
    assert.doesNotMatch(text, /--project\b|TP_PROJECT/);
    // No pool: the turn runs patrol + workflow only, and says why.
    assert.doesNotMatch(text, /passes\.mjs poll/);
    assert.match(text, /No resident session pool is running/);
    // The one-shot turn runs the same prompt: its pass names the bare
    // interpreter, which is what the control lane's allowlist permits.
    const patrolLine = text.split("\n").find((line) => line.includes("loop patrol"));
    assert.match(patrolLine, /^\s+1\) node \S*\.mjs .*loop patrol\b/);
    const boardLine = text.split("\n").find((line) => line.includes("issue list --status in_progress"));
    assert.match(boardLine, /^\s+node \S*\.mjs --actor-kind claude --agent alice issue list --status in_progress --json$/);
    const held = loadContinueLock(lock);
    assert.ok(Number.isInteger(held.pid) && held.pid > 0, "the lock holds the child pid");
  });

  it("enqueues the turn for a resident pool instead of spawning an agent", () => {
    const dir = tempDir("tp-continue-resident-");
    const fake = fakeClaude(dir);
    writeLivePool(dir);
    const run = runSupervisor(["--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", join(dir, "continue.state.json"),
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    const pending = JSON.parse(readFileSync(join(dir, "continue.pending.json"), "utf8"));
    assert.equal(pending.reason, "timer");
    assert.equal(existsSync(fake.record), false, "the one-shot process must not start an agent");
    assert.equal(existsSync(join(dir, "continue.state.json")), false, "no spawn lock is taken");
  });

  it("treats --resident=no as no pool even when the state file looks live", () => {
    const dir = tempDir("tp-continue-resident-no-");
    const fake = fakeClaude(dir);
    writeLivePool(dir);
    const run = runSupervisor(["--continue-only", "--once", "--resident=no",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", join(dir, "continue.state.json"),
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(dir, "continue.pending.json")), false, "nothing is queued");
    assert.ok(waitFor(fake.record), "the fallback one-shot turn still runs");
  });

  it("notifies once per cadence that dispatch is paused", () => {
    const dir = tempDir("tp-continue-notify-");
    const fake = fakeClaude(dir);
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
    const run = runSupervisor(["--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", join(dir, "continue.state.json"),
      "--notify", `${process.execPath} ${notifier}`,
    ], { ...fake.env, TP_NOTIFY_OUT: out });
    assert.equal(run.status, 0, run.stderr);
    const alert = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(alert.kind, "no_resident");
    assert.match(alert.message, /dispatch is paused/);
    assert.match(alert.reason, /no session state/);
  });

  it("skips while a live turn holds the lock", () => {
    const dir = tempDir("tp-continue-lock-");
    const fake = fakeClaude(dir);
    const lock = join(dir, "continue.state.json");
    writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }));
    const run = runSupervisor(["--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", lock,
    ], fake.env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /still running/);
    assert.equal(existsSync(fake.record), false, "no second LLM turn");
  });

  it("releases the lock and exits 1 when the agent cannot start", () => {
    const dir = tempDir("tp-continue-fail-");
    const emptyBin = join(dir, "empty");
    mkdirSync(emptyBin, { recursive: true });
    const lock = join(dir, "continue.state.json");
    const run = runSupervisor(["--continue-only", "--once",
      "--actor-kind", "claude", "--agent", "alice",
      "--repo", dir, "--state", join(dir, "state.json"), "--log", join(dir, "log"),
      "--continue-state", lock,
    ], { PATH: emptyBin });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(existsSync(lock), false, "a failed spawn leaves no lock behind");
  });
});
