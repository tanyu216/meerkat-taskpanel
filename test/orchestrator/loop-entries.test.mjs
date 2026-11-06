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
  claimPatrolCard,
  createProjectAdmission,
  createQueueDispatch,
  isGitCheckout,
  recordPatrolAdmissionFailure,
  reassignCard,
  settlePatrolDispatchFailure,
} from "../../src/orchestrator/passes.mjs";
import { createDeferralRecorder, readDeferralLedger } from "../../src/orchestrator/deferrals.mjs";
import { holdCard, releaseCard } from "../../src/orchestrator/holds.mjs";
import { claimCards, enqueueCard, QUEUE_FILES, readCards } from "../../src/orchestrator/queue.mjs";
import { findWorkspace, upsertWorkspaceRecord } from "../../src/orchestrator/workspace.mjs";
import { runContinue, runPollTick, runQuestionTick } from "../../src/orchestrator/runners.mjs";
import {
  BOARD_UNRESPONSIVE_AFTER,
  acquireContinueLock,
  boardProbeUrl,
  loadContinueLock,
  readCardForRedispatch,
  readRouteOutcome,
  recordContinuePid,
  killWedgedPool,
  probeBoardHealth,
  releaseContinueLock,
  runCli,
  runCliAsync,
  runPingTick,
} from "../../src/orchestrator/runtime.mjs";
import {
  POOL_START_BUDGET_MS,
  killDeadlineMs,
} from "../../src/foundation/loop-state.mjs";

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

describe("the ping's one kill authority", () => {
  const NOW = Date.parse("2026-01-01T02:00:00.000Z");
  const TURN = 30 * 60 * 1_000;
  const iso = (ms) => new Date(ms).toISOString();
  const liveState = (extra = {}) => ({
    poolPid: 4242,
    poolPidStart: "token-1",
    phase: "running",
    tickStartedAt: iso(NOW - (killDeadlineMs(TURN) + 1_000)),
    turnTimeoutMs: TURN,
    ...extra,
  });
  const harness = (extra = {}) => {
    const kills = [];
    const markers = [];
    const logs = [];
    return {
      kills,
      markers,
      logs,
      run: (input = {}) =>
        killWedgedPool({
          state: liveState(),
          marker: null,
          isAlive: () => true,
          now: () => NOW,
          kill: (pid, signal) => kills.push([pid, signal]),
          saveMarker: (marker) => markers.push(marker),
          log: (line, meta) => logs.push({ line, ...meta }),
          ...extra,
          ...input,
        }),
    };
  };

  it("does nothing while a phase is inside its own deadline", () => {
    const h = harness();
    const starting = h.run({
      state: liveState({
        phase: "starting",
        startStartedAt: iso(NOW - (POOL_START_BUDGET_MS - 1)),
      }),
    });
    assert.equal(starting.acted, false);
    assert.deepEqual(h.kills, []);
    assert.deepEqual(h.markers, []);
  });

  it("SIGTERMs a wedged pool once, records wedgedKillAt and logs pool_killed", () => {
    const h = harness();
    const first = h.run();
    assert.equal(first.acted, true);
    assert.equal(first.signal, "SIGTERM");
    assert.deepEqual(h.kills, [[4242, "SIGTERM"]]);
    assert.equal(h.markers[0].wedgedKillAt, iso(NOW));
    assert.equal(h.logs[0].event, "pool_killed");
    assert.equal(h.logs[0].level, "error");
    assert.match(h.logs[0].line, /SIGTERM/);
  });

  it("does not act twice in one ping cadence", () => {
    const h = harness();
    const first = h.run();
    const second = h.run({ marker: h.markers[0] });
    assert.equal(first.acted, true);
    assert.equal(second.acted, false);
    assert.deepEqual(h.kills, [[4242, "SIGTERM"]], "one action per wedge per ping");
  });

  it("SIGKILLs a pool that survives on a later ping, once", () => {
    const h = harness();
    h.run();
    const later = h.run({ marker: h.markers[0], now: () => NOW + 60_000 });
    assert.equal(later.acted, true);
    assert.equal(later.signal, "SIGKILL");
    assert.equal(h.markers[1].wedgedSigkillAt, iso(NOW + 60_000));
    const after = h.run({ marker: h.markers[1], now: () => NOW + 120_000 });
    assert.equal(after.acted, false);
    assert.deepEqual(h.kills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
  });

  it("never kills on lastTickOkAt's age", () => {
    const h = harness();
    const result = h.run({
      state: liveState({ tickStartedAt: null, lastTickOkAt: iso(NOW - 6 * 60 * 60 * 1_000) }),
    });
    assert.equal(result.acted, false);
    assert.deepEqual(h.kills, []);
  });

  it("writes no marker and logs one error when the signal throws", () => {
    const h = harness({
      kill: () => {
        throw new Error("EPERM");
      },
    });
    const result = h.run();
    assert.equal(result.acted, false);
    assert.equal(result.error, "EPERM");
    assert.deepEqual(h.markers, [], "no marker for a signal that did not go out");
    assert.equal(h.logs[0].level, "error");
    assert.match(h.logs[0].line, /EPERM/);
  });
});

describe("the ping's board /health probe", () => {
  const NOW = Date.parse("2026-01-01T02:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();

  /** Drive the streak the way the one-shot ping does: one call per minute. */
  function sequence(outcomes) {
    const logs = [];
    const saves = [];
    let state = null;
    let minute = 0;
    return {
      logs,
      saves,
      run: async () => {
        const probes = [];
        const result = await probeBoardHealth({
          url: "http://127.0.0.1:9527",
          state,
          now: () => NOW + minute * 60_000,
          probe: async () => {
            probes.push(minute);
            return outcomes[minute++] !== false;
          },
          save: (record) => saves.push(record),
          log: (line, meta) => logs.push({ line, ...meta }),
        });
        state = result;
        return result;
      },
    };
  }

  it("logs board_unresponsive once the third consecutive probe fails", async () => {
    const run = sequence([false, false, false, false]);
    const first = await run.run();
    const second = await run.run();
    const third = await run.run();
    assert.equal(first.failures, 1);
    assert.equal(second.failures, 2);
    assert.equal(third.failures, 3);
    assert.equal(third.unresponsive, true);
    assert.equal(run.logs.length, 1, "one record, not one per minute");
    assert.equal(run.logs[0].event, "board_unresponsive");
    assert.equal(run.logs[0].level, "error");
    assert.equal(run.logs[0].failures, BOARD_UNRESPONSIVE_AFTER);
    assert.equal(run.logs[0].url, "http://127.0.0.1:9527");

    // Staying down does not repeat the record for the same episode.
    const fourth = await run.run();
    assert.equal(fourth.failures, 4);
    assert.equal(fourth.unresponsive, true);
    assert.equal(run.logs.length, 1);
    assert.equal(run.saves.length, 4, "the streak is durable for the next one-shot ping");
  });

  it("a successful probe resets the streak and arms the next episode", async () => {
    const run = sequence([false, false, true, false, false, false]);
    await run.run();
    await run.run();
    const recovered = await run.run();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.failures, 0);
    assert.equal(recovered.unresponsive, false);
    assert.equal(recovered.lastOkAt, iso(NOW + 2 * 60_000));
    assert.equal(run.logs.length, 0);

    await run.run();
    await run.run();
    const again = await run.run();
    assert.equal(again.failures, 3);
    assert.equal(run.logs.length, 1, "a second episode is reported again");
  });

  it("treats a missing or throwing probe as a failed health read", async () => {
    let state = null;
    const result = await probeBoardHealth({
      url: null,
      state,
      now: () => NOW,
      probe: async () => {
        throw new Error("should not be called");
      },
      save: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures, 1);

    state = result;
    const broken = await probeBoardHealth({
      url: "http://127.0.0.1:9527",
      state,
      now: () => NOW,
      probe: async () => {
        throw new Error("EHOSTUNREACH");
      },
      save: () => {},
    });
    assert.equal(broken.ok, false);
    assert.equal(broken.failures, 2);
  });

  it("never kills: the probe has no process or kill seam at all", async () => {
    // The one kill authority is `killWedgedPool`, tested above. This probe is
    // observability, so its result deliberately carries no pid, signal or kill
    // action — a failed /health read cannot stop the board (single writer + data
    // safety leave that to the guard/operator).
    const result = await probeBoardHealth({
      url: null,
      state: null,
      now: () => NOW,
      save: () => {},
      log: () => {},
    });
    assert.equal(Object.hasOwn(result, "pid"), false);
    assert.equal(Object.hasOwn(result, "kill"), false);
    assert.equal(Object.hasOwn(result, "signal"), false);
    assert.equal(result.ok, false);
  });

  it("resolves the board URL from the flag, then the environment, then the pointer", () => {
    const pointer = () => ({ url: "http://127.0.0.1:7000" });
    assert.equal(boardProbeUrl({ opts: { url: "http://127.0.0.1:9000" }, env: {}, pointer }), "http://127.0.0.1:9000");
    assert.equal(
      boardProbeUrl({ opts: {}, env: { TASKD_URL: "http://127.0.0.1:8000" }, pointer }),
      "http://127.0.0.1:8000",
    );
    assert.equal(boardProbeUrl({ opts: {}, env: {}, pointer }), "http://127.0.0.1:7000");
    assert.equal(boardProbeUrl({ opts: {}, env: {}, pointer: () => null }), null);
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

  it("reads a successful async taskctl call without blocking the event loop", async () => {
    const dir = tempDir("tp-cli-async-");
    const cli = join(dir, "async-cli.mjs");
    writeFileSync(
      cli,
      'process.stdout.write(JSON.stringify({ ok: true, data: { task: { status: "todo" } } }) + "\\n");\n',
    );
    const result = await runCliAsync({ cli }, "alice", ["issue", "get", "T-1"], {
      actorKind: "claude",
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.task.status, "todo");
  });

  it("carries a refusal's code, details and hint on the async path", async () => {
    const dir = tempDir("tp-cli-async-refuse-");
    const cli = join(dir, "refuse-cli.mjs");
    writeFileSync(
      cli,
      [
        "process.stdout.write(JSON.stringify({",
        '  ok: false,',
        '  error: { code: "EXECUTION_ACTIVE", message: "not the holder",',
        '    details: { claimed_by: "someone-else" }, hint: { command: "issue get T-1" } },',
        '}) + "\\n");',
      ].join("\n"),
    );
    const result = await runCliAsync({ cli }, "alice", ["issue", "heartbeat", "T-1"], {
      actorKind: "claude",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "EXECUTION_ACTIVE");
    assert.equal(result.error, "not the holder");
    assert.deepEqual(result.details, { claimed_by: "someone-else" });
    assert.deepEqual(result.hint, { command: "issue get T-1" });
  });

  it("kills an async taskctl at its own bound", async () => {
    const dir = tempDir("tp-cli-async-timeout-");
    const cli = join(dir, "hang-async-cli.mjs");
    writeFileSync(cli, "setInterval(() => {}, 1000);\n");
    const started = Date.now();
    const result = await runCliAsync({ cli }, "alice", ["issue", "list"], {
      actorKind: "claude",
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
    assert.ok(Date.now() - started < 5_000, "the child's bound releases the caller");
  });

  it("reports non-JSON output as a failure, not a crash", async () => {
    const dir = tempDir("tp-cli-async-garbage-");
    const cli = join(dir, "garbage-cli.mjs");
    writeFileSync(cli, 'process.stdout.write("not json\\n"); process.stderr.write("board down\\n");\n');
    const result = await runCliAsync({ cli }, "alice", ["issue", "list"], { actorKind: "claude" });
    assert.equal(result.ok, false);
    assert.match(result.error, /board down/);
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

  it("treats starting and unresponsive as a live pool — the shared verdict gates the tick", async () => {
    const dir = tempDir("tp-require-pool-live-");
    const stateFile = join(dir, "sessions.state.json");
    const cases = [
      // No heartbeat yet: the startup window is published before start().
      { phase: "starting", startStartedAt: new Date().toISOString(), heartbeatAt: null },
      // A blocked event loop: stale heartbeat, live pid.
      { phase: "running", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    ];
    for (const fields of cases) {
      writeFileSync(
        stateFile,
        JSON.stringify({ version: 3, poolPid: process.pid, projects: {}, ...fields }),
      );
      const ran = [];
      let acquired = 0;
      const code = await runContinue(opts(dir), {
        requirePool: true,
        runPatrol: async () => ran.push("patrol"),
        runWorkflow: async () => ran.push("workflow"),
        runPoll: async () => ran.push("poll"),
        onAcquired: () => {
          acquired += 1;
        },
        log: () => {},
      });
      assert.equal(code, 0);
      assert.deepEqual(ran, ["patrol", "workflow", "poll"], `${fields.phase} is a live pool`);
      assert.equal(acquired, 1, `${fields.phase}: the tick lock is taken, and only one`);
    }

    // The same real state file with a dead pid is absent: no tick, no lock.
    writeFileSync(stateFile, JSON.stringify({ version: 3, poolPid: 2147483646, projects: {} }));
    const ran = [];
    let acquired = 0;
    const code = await runContinue(opts(dir), {
      requirePool: true,
      runPatrol: async () => ran.push("patrol"),
      runWorkflow: async () => ran.push("workflow"),
      runPoll: async () => ran.push("poll"),
      onAcquired: () => {
        acquired += 1;
      },
      log: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(ran, [], "a gone pool buys no tick");
    assert.equal(acquired, 0);
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

  it("logs board_unresponsive after three failed /health probes and keeps a streak on disk", () => {
    const dir = tempDir("tp-entry-ping-health-");
    const state = join(dir, "state.json");
    const log = join(dir, "log");
    writeFileSync(state, JSON.stringify({ version: 1, running: {} }));
    // A dead board: connection refused is immediate, so the 1 s probe bound is
    // not what this test spends time on.
    const env = { ...process.env, HOME: dir, TASKD_URL: "http://127.0.0.1:1" };
    const argv = [
      join(ROOT, "src", "orchestrator", "supervisor.mjs"),
      "--actor-kind", "claude", "--agent", "alice", "--ping-only", "--once",
      "--state", state, "--log", log,
    ];
    const ping = () => spawnSync(process.execPath, argv, { encoding: "utf8", env });

    for (let pass = 0; pass < 2; pass += 1) {
      assert.equal(ping().status, 0);
      assert.equal(readFileSync(log, "utf8").includes("event=board_unresponsive"), false);
    }
    assert.equal(ping().status, 0, "the third failed probe is the news");
    assert.match(readFileSync(log, "utf8"), /event=board_unresponsive/);

    const record = JSON.parse(readFileSync(join(dir, "board-health.json"), "utf8"));
    assert.equal(record.failures, 3);
    assert.equal(record.unresponsive, true);
    assert.equal(typeof record.lastFailureAt, "string");
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
    assert.equal(
      args.some((call) => call.includes("project") && call[call.indexOf("project") + 1] === "list"),
      false,
      "no project override read: discovered roles are the routing",
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
    // Same isolation as the closed-record case: the scan set is the discovered
    // Worker role, never whatever the host happens to have installed.
    const home = join(dir, "home");
    seedRole(home, "claude", "worker", "Worker");
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
        "  data = { candidates: [{ identifier: 'T-1', project: 'P', agent: 'alice', assignee: 'alice', assignee_kind: 'agent', status: 'in_progress', reason: 'stale_same' }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--home", home,
        "--cli", script, "--repo", dir,
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        "--config", join(dir, ".env.claude"),
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

  it("offers a card whose worker record was closed while it still says running", () => {
    const dir = tempDir("tp-poll-closed-worker-");
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ project: "P", local_path: app }] }));
    // Older pools stamped `closedAt` without resetting the mid-turn `running`
    // status. A closed conversation is not running, so the stale re-claim must
    // see the card.
    writeLivePool(dir, {
      version: 2,
      capabilities: ["question-lane"],
      projects: {
        "worker:T-1:r1": {
          status: "running",
          sessionId: "sid-1",
          closedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    // The scan set is the discovered Worker role: seed a temp home so a
    // developer's installed skills cannot answer for the test, and the
    // container's empty home cannot make the poll scan nothing.
    const home = join(dir, "home");
    seedRole(home, "claude", "worker", "Worker");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "closed-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "let data = { candidates: [], tasks: [], actions: [], comments: [], reports: [], workflow: { alerts: [], actions: [], changes: [], summary: {} } };",
        "if (argv.includes('candidates')) {",
        "  data = { candidates: [{ identifier: 'T-1', project: 'P', agent: 'alice', assignee: 'alice', assignee_kind: 'agent', status: 'in_progress', reason: 'stale_same' }] };",
        "}",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
    );
    const run = runEntry(
      "passes.mjs",
      [
        "--actor-kind", "claude", "--agent", "alice",
        "--home", home,
        "--cli", script, "--repo", dir, "--workspace", "shared",
        "--state", join(dir, "state.json"), "--log", join(dir, "log"),
        // Keep a developer's installed per-kind config out of the scan set.
        "--config", join(dir, ".env.claude"),
      ],
      { TP_SENTINEL: record, MEERKAT_TASKPANEL_CONFIG_DIR: dir },
      "poll",
    );
    assert.equal(run.status, 0, run.stderr);
    // The card reaches the claim path: either it is claimed, or admission
    // defers it. Before the fix it was filtered out and never offered at all.
    const offered =
      calls(record).some((call) => call.includes("claim")) ||
      /defer T-1/.test(readFileSync(join(dir, "log"), "utf8"));
    assert.ok(
      offered,
      "a closed worker record does not keep the card out of the stale re-claim",
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

  it("reassigns a stale card to Worker under the orchestrator's identity, and comments why (ADR 0015)", () => {
    const dir = tempDir("tp-worker-fallback-");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "fallback-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const at = argv.indexOf('assign');",
        "let data = { candidates: [], tasks: [], actions: [], comments: [] };",
        "if (at !== -1) data = { task: { identifier: 'T-1', version: 4 } };",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    // Node itself parses `--env-file`, so the file must exist (the loop always
    // points at a real per-kind config).
    const envFile = join(dir, ".env.codex");
    writeFileSync(envFile, "");
    const result = reassignCard(
      { cli: script, actorKind: "codex", envFile, cliEnv: { TP_SENTINEL: record } },
      () => {},
      "T-1",
      "Worker",
      { reason: "stale reclaim: assignee Ghost is not installed; reassigned to Worker.", ifVersion: 3 },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.version, 4, "the post-assign version is handed to the claim");

    const all = calls(record);
    const assign = all.find((call) => call.includes("assign"));
    assert.ok(assign, "the route is rewritten first");
    assert.equal(assign[assign.indexOf("--assignee") + 1], "Worker");
    assert.equal(assign[assign.indexOf("--if-version") + 1], "3", "the scan's version guards the reassignment");
    assert.equal(assign[assign.indexOf("--agent") + 1], "Orchestrator");
    assert.equal(assign[assign.indexOf("--actor-kind") + 1], "system");

    const comment = all.find((call) => call.includes("comment") && call.includes("add"));
    assert.ok(comment, "the fallback is auditable");
    assert.equal(comment[comment.indexOf("--kind") + 1], "change");
    assert.match(comment.join(" "), /Ghost/);
    assert.match(comment.join(" "), /not installed/);
    assert.equal(comment[comment.indexOf("--agent") + 1], "Orchestrator");
  });

  it("claims a stale patrol card as the planned assignee, never the holder", () => {
    const dir = tempDir("tp-patrol-claim-");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "claim-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        'process.stdout.write(`${JSON.stringify({ ok: true, data: {} })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    const result = claimPatrolCard(
      { cli: script, actorKind: "claude", cliEnv: { TP_SENTINEL: record } },
      () => {},
      "T-1",
      { kind: "claim", agent: "Linus" },
      { ifVersion: 3 },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const all = calls(record);
    assert.equal(all.length, 1, "a plain claim is one board call");
    const claim = all[0];
    assert.equal(claim[claim.indexOf("--agent") + 1], "Linus", "the assignee's role claims, not the holder");
    assert.equal(claim.includes("--if-version"), false, "no reassignment, so no version guard");
  });

  it("re-routes to Worker before a patrol claim, with the version chain (ADR 0015)", () => {
    const dir = tempDir("tp-patrol-fallback-");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "fallback-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const at = argv.indexOf('assign');",
        "let data = {};",
        "if (at !== -1) data = { task: { identifier: 'T-1', version: 4 } };",
        'process.stdout.write(`${JSON.stringify({ ok: true, data })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    const envFile = join(dir, ".env.codex");
    writeFileSync(envFile, "");
    const result = claimPatrolCard(
      { cli: script, actorKind: "codex", envFile, cliEnv: { TP_SENTINEL: record } },
      () => {},
      "T-1",
      {
        kind: "claim",
        agent: "Worker",
        reassign: { from: "Ghost", to: "Worker", reason: "stale reclaim: Ghost is not installed" },
      },
      { ifVersion: 3 },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    const all = calls(record);
    const assignAt = all.findIndex((call) => call.includes("assign"));
    const commentAt = all.findIndex((call) => call.includes("comment") && call.includes("add"));
    const claimAt = all.findIndex((call) => call.includes("claim"));
    assert.ok(assignAt !== -1 && commentAt !== -1 && claimAt !== -1, "all three writes ran");
    assert.ok(assignAt < claimAt, "the route is rewritten before the claim");
    assert.equal(all[assignAt][all[assignAt].indexOf("--if-version") + 1], "3");
    assert.equal(all[claimAt][all[claimAt].indexOf("--agent") + 1], "Worker");
    assert.equal(
      all[claimAt][all[claimAt].indexOf("--if-version") + 1],
      "4",
      "the post-assign version guards the claim",
    );
  });

  it("does not claim when the patrol's Worker reassignment is refused", () => {
    const dir = tempDir("tp-patrol-refused-");
    const record = join(dir, "calls.jsonl");
    const script = join(dir, "refuse-cli.mjs");
    writeFileSync(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const argv = process.argv.slice(2);",
        "appendFileSync(process.env.TP_SENTINEL, `${JSON.stringify(argv)}\\n`);",
        "const at = argv.indexOf('assign');",
        "if (at !== -1) { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'changed' } })}\\n`); }",
        "else process.stdout.write(`${JSON.stringify({ ok: true, data: {} })}\\n`);",
      ].join("\n"),
      "utf8",
    );
    const result = claimPatrolCard(
      { cli: script, actorKind: "claude", cliEnv: { TP_SENTINEL: record } },
      () => {},
      "T-1",
      { kind: "claim", agent: "Worker", reassign: { from: "Ghost", to: "Worker", reason: "x" } },
      { ifVersion: 3 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.phase, "reassign");
    assert.equal(calls(record).some((call) => call.includes("claim")), false);
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
    assert.equal(
      args.some((call) => call.includes("project") && call[call.indexOf("project") + 1] === "list"),
      false,
      "no project override read: the role catalog owns the default assignee",
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

  it("reuses the rejected round's worktree and branch for a rework", async () => {
    const f = fixture();
    mkdirSync(join(f.app, ".git"), { recursive: true });
    const lane = join(f.dir, "app-lane");
    mkdirSync(join(lane, ".git"), { recursive: true });
    const createdAt = "2026-01-01T00:00:00.000Z";
    const original = {
      identifier: "T-1",
      round: 1,
      path: lane,
      branch: "lane/T-1",
      project_dir: f.app,
      created_at: createdAt,
    };
    upsertWorkspaceRecord(f.dir, original);
    const runGit = (cmd, argv) =>
      argv.join(" ").includes("rev-parse --verify --quiet")
        ? { status: 0, stdout: "abc\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" };
    const admission = createProjectAdmission({
      opts: f.opts,
      projectConcurrency: f.concurrency,
      stateDir: f.dir,
      workspaceMode: "worktree",
      runGit,
      watchCards: f.watchCards,
    });
    const action = { identifier: "T-1", agent: "alice", reason: "ready" };
    const card = {
      id: "uuid-1",
      identifier: "T-1",
      project: "P",
      title: "do it",
      delivery_round: 2,
      meta: { rework_round: "2" },
    };
    assert.equal((await admission.admit(action, card)).ok, true);
    assert.equal(admission.contextFor("T-1")?.targetDir, lane, "the rework runs in the rejected tree");
    const moved = findWorkspace(f.dir, { identifier: "T-1", round: 2 });
    assert.equal(moved.path, lane);
    assert.equal(moved.branch, "lane/T-1");
    assert.equal(moved.created_at, createdAt, "the workspace identity did not change");
    assert.equal(
      findWorkspace(f.dir, { identifier: "T-1", round: 1 }).path,
      lane,
      "the rejected round's record is kept for its reviewer and merge",
    );
  });

  it("marks a rework round and carries the previous round", async () => {
    const f = fixture();
    const admission = createProjectAdmission({ opts: f.opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const action = { identifier: "T-1", agent: "alice", reason: "ready" };
    const card = {
      id: "uuid-1",
      identifier: "T-1",
      project: "P",
      title: "do it",
      delivery_round: 2,
      meta: { rework_round: "2" },
    };
    assert.equal((await admission.admit(action, card)).ok, true);
    const dispatch = createQueueDispatch({
      opts: f.opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    assert.equal((await dispatch(action, card)).ok, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.rework, true);
    assert.equal(entry.carry_from_round, 1);
    assert.equal(entry.force_fresh, false);
  });

  it("forces one fresh conversation and clears the one-shot marker", async () => {
    const f = fixture();
    const { script, record } = sentinelCli(f.dir);
    const opts = { ...f.opts, cli: script, cliEnv: { TP_SENTINEL: record } };
    const admission = createProjectAdmission({ opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const action = { identifier: "T-1", agent: "alice", reason: "ready" };
    const card = {
      id: "uuid-1",
      identifier: "T-1",
      project: "P",
      title: "do it",
      delivery_round: 2,
      meta: { rework_round: "2", session_reset: "yes" },
    };
    assert.equal((await admission.admit(action, card)).ok, true);
    const dispatch = createQueueDispatch({ opts, config: { reviewers: [] }, stateDir: f.dir, admission });
    assert.equal((await dispatch(action, card)).ok, true);
    const [entry] = readCards(f.dir).value.cards;
    assert.equal(entry.rework, true, "the workspace still follows the rework rule");
    assert.equal(entry.force_fresh, true);
    const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(
      calls.some(
        (argv) =>
          argv.includes("issue") &&
          argv.includes("meta") &&
          argv.includes("T-1") &&
          argv.includes("session_reset=no"),
      ),
      `the one-shot marker is cleared after enqueue; calls: ${JSON.stringify(calls)}`,
    );
  });

  it("leaves the reset marker for the next round when a processing row refuses it", async () => {
    const f = fixture();
    const { script, record } = sentinelCli(f.dir);
    const opts = { ...f.opts, cli: script, cliEnv: { TP_SENTINEL: record } };
    const admission = createProjectAdmission({ opts, projectConcurrency: f.concurrency, watchCards: f.watchCards });
    const action = { identifier: "T-1", agent: "alice", reason: "ready" };
    const card = { id: "uuid-1", identifier: "T-1", project: "P", title: "do it" };
    assert.equal((await admission.admit(action, card)).ok, true);
    enqueueCard(f.dir, { card: "T-1", role: "worker", target_dir: f.dir });
    claimCards(f.dir, { claimedBy: "other-pool", pid: process.pid, limit: 1 });
    const dispatch = createQueueDispatch({ opts, config: { reviewers: [] }, stateDir: f.dir, admission });
    const reset = { ...card, delivery_round: 2, meta: { rework_round: "2", session_reset: "yes" } };
    assert.equal((await dispatch(action, reset)).ok, true);
    assert.equal(
      existsSync(record) ? readFileSync(record, "utf8").includes("session_reset=no") : false,
      false,
      "an in-flight turn did not take the flag, so the marker stays",
    );
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
    const reviewer = {
      id: "reviewer",
      agent: "Reviewer",
      nativeAgent: "reviewer",
      lanes: ["reviewer"],
      title: "Independent reviewer",
      installedOn: ["claude"],
      platform: "claude",
      skillDir: "/roles/reviewer",
      workflow: "/roles/reviewer/SKILL.md",
      selfCheck: null,
      reviewerPrompt: null,
      variants: {},
    };
    const opts = {
      ...f.opts,
      roles: { roles: [reviewer], defaultReviewer: null, decisionPolicy: { path: null }, warnings: [] },
    };
    const admission = createProjectAdmission({
      opts,
      projectConcurrency: f.concurrency,
      watchCards,
    });
    const action = { identifier: "T-2", agent: "Reviewer", reason: "ready" };
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
      opts,
      config: { reviewers: [] },
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
    assert.match(entry.handoff, /^Review card: T-2; card under review: T-1 \(round 1\)\./);
    assert.match(entry.handoff, /Step 0 — the review_not_ready check/);
    assert.match(entry.handoff, /taskctl issue get T-1 --json <flags>/);
    assert.match(entry.handoff, /taskctl issue deliver T-2 --report-file - <flags>/);
    assert.match(entry.handoff, /VERDICT: APPROVE/);
    assert.doesNotMatch(entry.handoff, /Review brief:|Original brief:/);
    assert.deepEqual(watched, [["T-2", "T-1"]], "the claim event refreshes it; no second export");
  });

  it("refuses a review card whose assignee is not a reviewer-lane role", async () => {
    const f = fixture();
    const jobs = {
      id: "jobs",
      agent: "Jobs",
      nativeAgent: "jobs",
      lanes: ["worker"],
      title: "Product design",
      installedOn: ["claude"],
      platform: "claude",
      skillDir: "/roles/jobs",
      workflow: "/roles/jobs/SKILL.md",
      selfCheck: null,
      reviewerPrompt: null,
      variants: {},
    };
    const opts = {
      ...f.opts,
      roles: { roles: [jobs], defaultReviewer: null, decisionPolicy: { path: null }, warnings: [] },
    };
    const admission = createProjectAdmission({
      opts,
      projectConcurrency: f.concurrency,
      watchCards: f.watchCards,
    });
    const action = { identifier: "T-3", agent: "Jobs", reason: "ready" };
    const card = {
      id: "uuid-3",
      identifier: "T-3",
      project: "P",
      review_of: "T-1",
      review_round: 1,
    };
    assert.equal((await admission.admit(action, card)).ok, true);
    const dispatch = createQueueDispatch({
      opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    const result = await dispatch(action, card);
    assert.equal(result.ok, false);
    assert.match(result.error, /reviewer-lane/);
    assert.equal(readCards(f.dir).value.cards.length, 0, "nothing was queued");
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
    const reviewer = {
      id: "reviewer",
      agent: "Reviewer",
      nativeAgent: "reviewer",
      lanes: ["reviewer"],
      title: "Independent reviewer",
      installedOn: ["claude"],
      platform: "claude",
      skillDir: "/roles/reviewer",
      workflow: "/roles/reviewer/SKILL.md",
      selfCheck: null,
      reviewerPrompt: null,
      variants: {},
    };
    const opts = {
      ...f.opts,
      roles: { roles: [reviewer], defaultReviewer: null, decisionPolicy: { path: null }, warnings: [] },
    };
    const admission = createProjectAdmission({
      opts,
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
      opts,
      config: { reviewers: [] },
      stateDir: f.dir,
      admission,
    });
    const result = await runPollTick({
      agents: ["Reviewer"],
      registry: { running: {} },
      config: {},
      readCandidates: () => [{ ...card, agent: "Reviewer", reason: "ready" }],
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
    const card = { id: "u1", identifier: "T-1", project: "P", delivery_round: 1, title: "Fix the rail" };
    assert.equal((await admission.admit(action, card)).ok, true);

    const wt = join(f.app, ".worktrees", "T-1-fix-the-rail");
    assert.equal(admission.dirFor("T-1"), wt);
    const record = findWorkspace(f.dir, { identifier: "T-1", round: 1 });
    assert.equal(record.path, wt);
    assert.equal(record.branch, "lane/T-1-fix-the-rail");
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
    assert.equal(entry.workspace.branch, "lane/T-1-fix-the-rail");
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

  it("parks a dispatch failure at three, while an admission failure waits for five", async () => {
    const held = [];
    const runFor = (code, count) =>
      runPollTick(
        base({
          admit: async () => ({ ok: false, why: "x", code, accounted: true }),
          recordDefer: () => ({ count, code, reason: "x" }),
          holdCard: async (id, payload) => {
            held.push({ id, code: payload.code });
            return { ok: true };
          },
          clearDeferral: () => {},
        }),
      );
    await runFor("DISPATCH_FAILED", 3);
    assert.deepEqual(
      held,
      [{ id: "T-1", code: "DISPATCH_FAILED" }],
      "the documented dispatch-failure bound is three",
    );
    await runFor("ADMISSION_FAILED", 3);
    assert.equal(held.length, 1, "an admission streak at three keeps retrying");
    await runFor("ADMISSION_FAILED", 5);
    assert.equal(held.length, 2, "admission holds at five");
  });

  // TP-0146 P0.5: a refused Worker fallback reassignment used to be retried
  // forever with no counter behind it.
  it("counts a refused Worker reassignment and parks at five", async () => {
    const recorded = [];
    const held = [];
    const refused = (count) =>
      runPollTick(
        base({
          readCandidates: () => [
            {
              identifier: "T-1",
              project: "P",
              delivery_round: 2,
              agent: "alice",
              reason: "ready",
              reassign: { to: "bob", reason: "Worker fallback" },
            },
          ],
          admit: async () => ({ ok: true }),
          reassign: async () => ({ ok: false, error: "VERSION_CONFLICT" }),
          release: async () => {},
          recordDefer: (id, failure) => {
            recorded.push({ id, failure });
            return { count, code: failure.code, reason: failure.reason };
          },
          holdCard: async (id, payload) => {
            held.push({ id, code: payload.code });
            return { ok: true };
          },
          clearDeferral: () => {},
        }),
      );
    await refused(4);
    assert.deepEqual(held, [], "four refusals keep retrying");
    assert.equal(recorded[0].failure.code, "REASSIGN_FAILED");
    await refused(5);
    assert.deepEqual(held, [{ id: "T-1", code: "REASSIGN_FAILED" }]);
  });

  // TP-0146 P0.6: a claim whose hand-back fails is still `in_progress`; the
  // loop must park it rather than leave an ownerless claim behind.
  it("holds the card when the claim cannot be handed back", async () => {
    const held = [];
    const recorded = [];
    await runPollTick(
      base({
        admit: async () => ({ ok: true }),
        dispatch: async () => ({ ok: false, error: "spawn failed" }),
        release: async () => {},
        moveBack: async () => ({ ok: false, error: "board unavailable" }),
        recordDefer: (id, failure) => {
          recorded.push({ id, failure });
          return { count: 1, code: failure.code, reason: failure.reason };
        },
        holdCard: async (id, payload) => {
          held.push({ id, code: payload.code });
          return { ok: true };
        },
      }),
    );
    assert.deepEqual(held, [{ id: "T-1", code: "CLAIM_RELEASE_FAILED" }]);
    assert.deepEqual(recorded[0].failure, {
      code: "CLAIM_RELEASE_FAILED",
      reason: "board unavailable",
      round: 2,
      version: null,
    });
  });

  // TP-0146 P0.7: a hold write that fails must stay visible in the deferral
  // ledger without changing the bound that produced it.
  it("records a hold-write failure and alerts instead of dropping it", async () => {
    const recorded = [];
    const lines = [];
    const first = { count: 3, code: "DISPATCH_FAILED", reason: "spawn failed", round: 2, version: null };
    await runPollTick(
      base({
        admit: async () => ({ ok: true }),
        dispatch: async () => ({ ok: false, error: "spawn failed" }),
        release: async () => {},
        moveBack: async () => ({ ok: true }),
        recordDefer: (id, failure) => {
          recorded.push({ id, failure });
          return recorded.length === 1 ? first : { count: 4, code: failure.code, reason: failure.reason };
        },
        holdCard: async () => ({ ok: false, error: "move refused" }),
        log: (line) => lines.push(line),
      }),
    );
    assert.equal(recorded.length, 2, "the failed hold is recorded, not dropped");
    assert.deepEqual(recorded[1].failure, {
      code: "DISPATCH_FAILED",
      reason: "hold failed: move refused",
      round: 2,
      version: null,
    });
    assert.ok(lines.some((line) => /could not park the card/.test(line)));
  });

  // TP-0146 P0.8: losing a claim CAS is ordinary competition. It is counted on
  // its own field so it cannot advance the shared failure streak toward a hold.
  it("counts claim refusals without touching the handoff streak", async () => {
    const refusals = [];
    const recorded = [];
    const held = [];
    const result = await runPollTick(
      base({
        admit: async () => ({ ok: true }),
        claim: async () => ({ ok: false, error: "VERSION_CONFLICT" }),
        release: async () => {},
        recordDefer: (id, failure) => {
          recorded.push({ id, failure });
          return { count: 1, code: failure.code };
        },
        recordClaimRefusal: (id, failure) => refusals.push({ id, failure }),
        holdCard: async () => {
          held.push(1);
          return { ok: true };
        },
      }),
    );
    assert.equal(result.conflicts, 1);
    assert.deepEqual(recorded, [], "a refusal is not a handoff failure");
    assert.deepEqual(refusals, [
      { id: "T-1", failure: { reason: "VERSION_CONFLICT", round: 2, version: null } },
    ]);
    assert.deepEqual(held, [], "competition never holds a card");
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

// ---------------------------------------------------------------------------
// Patrol — the second admission site
// ---------------------------------------------------------------------------

describe("patrol admission settlement", () => {
  /**
   * A real deferral recorder plus the real board writes against a sentinel CLI:
   * the argv sequence is the evidence, the ledger is the count.
   */
  function settlementFixture() {
    const dir = tempDir("tp-patrol-settle-");
    const { script, record } = sentinelCli(dir);
    const opts = { cli: script, actorKind: "system", dryRun: false, cliEnv: { TP_SENTINEL: record } };
    const log = () => {};
    const stopped = [];
    const discarded = [];
    const deferrals = createDeferralRecorder({
      stateDir: dir,
      postComment: () => ({ ok: true }),
      log,
    });
    const input = {
      stateDir: dir,
      log,
      deferrals,
      hold: (id, payload) => holdCard(opts, log, id, payload),
      release: (id, payload) => releaseCard(opts, log, id, payload),
      stopWatch: async (owned) => { stopped.push(owned); },
      discard: (workspace) => { discarded.push(workspace); },
    };
    return { dir, record, input, stopped, discarded };
  }

  /** The board moves this fixture made, as the argv tail from `issue`. */
  function moves(record) {
    return calls(record)
      .filter((call) => call.includes("issue") && call.includes("move"))
      .map((call) => call.slice(call.indexOf("issue")));
  }

  it("hands the claim back when a patrol dispatch is refused after the claim", async () => {
    const f = settlementFixture();
    const result = await settlePatrolDispatchFailure(f.input, {
      identifier: "T-1",
      reason: "no reviewer-lane executor",
      round: 1,
      owned: { ref: "T-1", out: "/tmp/T-1.md" },
      workspace: { identifier: "T-1", round: 1 },
      workspaceCreated: true,
    });
    assert.deepEqual(result, { ok: false });
    assert.deepEqual(moves(f.record), [
      ["issue", "move", "T-1", "todo", "--reason", "no reviewer-lane executor"],
    ]);
    assert.equal(readDeferralLedger(f.dir).value.cards["T-1"].count, 1);
    assert.deepEqual(f.stopped, [{ ref: "T-1", out: "/tmp/T-1.md" }], "the watch is released");
    assert.deepEqual(f.discarded, [{ identifier: "T-1", round: 1 }], "the workspace is released");
  });

  it("parks a patrol card at the third post-claim dispatch failure", async () => {
    const f = settlementFixture();
    const settle = () =>
      settlePatrolDispatchFailure(f.input, { identifier: "T-1", reason: "still refused", round: 2 });
    await settle();
    await settle();
    assert.deepEqual(
      moves(f.record).map((call) => call[3]),
      ["todo", "todo"],
      "the first two failures hand the claim back",
    );
    await settle();
    const held = moves(f.record).at(-1);
    assert.deepEqual(held.slice(0, 6), [
      "issue", "move", "T-1", "blocked", "--blocked-reason", "resource",
    ]);
    assert.equal(
      readDeferralLedger(f.dir).value.cards["T-1"],
      undefined,
      "a successful hold clears the streak",
    );
  });

  it("keeps the streak when the claim cannot be released and the hold also fails", async () => {
    const f = settlementFixture();
    const errors = [];
    const input = {
      ...f.input,
      log: (line, meta) => { if (meta?.level === "error") errors.push(line); },
      hold: async () => ({ ok: false, error: "move refused" }),
      release: async () => ({ ok: false, error: "board unavailable" }),
    };
    await settlePatrolDispatchFailure(input, {
      identifier: "T-1",
      reason: "denied",
      round: 1,
    });
    assert.match(errors.at(-1), /release and hold both failed for T-1/);
    // The release failure itself is a dispatch failure: the streak survives so
    // the next pass tries the hold again instead of restarting at one.
    const entry = readDeferralLedger(f.dir).value.cards["T-1"];
    assert.equal(entry.count, 1);
    assert.equal(entry.code, "DISPATCH_FAILED");
  });

  it("parks a patrol admission failure at five, not five hundred", async () => {
    const f = settlementFixture();
    const record = (n) =>
      recordPatrolAdmissionFailure(f.input, {
        identifier: "T-2",
        code: "ADMISSION_FAILED",
        reason: "workspace create failed",
        round: 1,
        version: 7,
        blockedReason: "external",
      });
    for (let n = 1; n <= 4; n += 1) {
      const result = await record(n);
      assert.equal(result.held, false, `attempt ${n} keeps retrying`);
    }
    assert.deepEqual(moves(f.record), [], "an admission failure never moves the card");
    const fifth = await record(5);
    assert.equal(fifth.held, true);
    assert.deepEqual(moves(f.record).at(-1).slice(0, 6), [
      "issue", "move", "T-2", "blocked", "--blocked-reason", "external",
    ]);
    assert.equal(readDeferralLedger(f.dir).value.cards["T-2"], undefined);
  });
});
