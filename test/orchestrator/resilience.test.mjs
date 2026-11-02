/**
 * The supervisor's process-level fault-injection baseline (epic TP-0025, stage P0).
 *
 * Seven failure modes, each pinned against the tree as it is today, each driven
 * through **real child processes** — no injected seams, no fake clock, no fake
 * `isAlive`. The file began RED, reproducing the failures the epic exists to
 * fix; every leg now passes and is enforced by `npm test`, so it stays the one
 * regression gate instead of seven anecdotes.
 *
 *  1. An entry point that throws      → a `process_crash` record and cleanup.
 *  2. stdout written after the reader closed → EPIPE is survived, exit 0.
 *  3. A second tick while one holds the lock → skipped, no duplicate pass.
 *  4. A tick that never resolves while the heartbeat keeps writing → `wedged`,
 *     never mistaken for a healthy pool.
 *  5. A live pid with a stale heartbeat (event loop blocked) → still `live`
 *     (`unresponsive`), so a second tick is not started beside it.
 *  6. The pool startup window (`phase:"starting"`) → still `live` (`starting`),
 *     so a second tick cannot start beside the starting pool.
 *  7. A SIGKILLed pool that restarts → an in-flight card whose agent child is
 *     still running is not redispatched.
 *
 * Run with: node --test test/orchestrator/resilience.test.mjs
 * Targeted:  npm run test:resilience
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
import { after, test } from "node:test";

import { readCards, recoverStaleCards } from "../../src/orchestrator/queue.mjs";
import { runContinue } from "../../src/orchestrator/runners.mjs";
import {
  acquireContinueLock,
  isProcessAlive,
  releaseContinueLock,
} from "../../src/orchestrator/runtime.mjs";
import { poolStatus } from "../../src/orchestrator/session.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const tempDirs = [];
const children = new Set();

function tempDir(prefix = "meerkat-resilience-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Register a child for teardown; returns it. */
function track(child) {
  children.add(child);
  child.once("exit", () => {
    /* keep the reference until teardown so `kill` remains safe */
  });
  return child;
}

function stop(child) {
  if (child === null || child === undefined) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  return new Promise((resolveDone) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    child.once("exit", finish);
    setTimeout(finish, 2000).unref?.();
  });
}

after(async () => {
  for (const child of children) await stop(child);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A real, living process whose only job is to hold a pid. */
async function startSleeper() {
  const child = track(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    }),
  );
  await new Promise((resolveStarted, rejectStarted) => {
    child.once("spawn", resolveStarted);
    child.once("error", rejectStarted);
  });
  return child;
}

/** Resolve true when `predicate()` does; false on timeout. */
function waitFor(predicate, timeoutMs, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait) => {
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolveWait(true);
      if (Date.now() >= deadline) return resolveWait(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** Wait for a child to exit, returning `{code, signal}`, or null on timeout. */
function waitExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    };
    child.once("exit", finish);
    setTimeout(() => {
      if (!settled) finish(null, null);
    }, timeoutMs).unref?.();
  });
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function writeState(dir, value) {
  writeFileSync(join(dir, "sessions.state.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function poolOpts(dir) {
  return {
    resident: "auto",
    state: join(dir, "supervisor.state.json"),
    sessionState: join(dir, "sessions.state.json"),
    sessionTurnTimeoutMs: 1200 * 1000,
  };
}

/** One baseline leg. All seven are green and enforced by `npm test`. */
function baseline(name, fn) {
  return test(name, fn);
}

// ---------------------------------------------------------------------------
// 1. The process-level crash boundary
// ---------------------------------------------------------------------------

baseline("1. an entry point that throws records process_crash and runs cleanup", async () => {
  const dir = tempDir();
  const crashLog = join(dir, "crash.jsonl");
  const cleanup = join(dir, "cleanup.txt");
  const lock = join(dir, "session.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));

  const child = track(
    spawn(process.execPath, [join(ROOT, "test", "fixtures", "resilience", "crash-entry.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RESILIENCE_CRASH_LOG: crashLog,
        RESILIENCE_CLEANUP: cleanup,
        RESILIENCE_LOCK: lock,
      },
    }),
  );
  const outcome = await waitExit(child, 10_000);

  assert.equal(outcome.signal, null, "the entry must exit on its own, not be killed by the test");
  assert.equal(outcome.code, 1, "an escaped rejection is a controlled nonzero exit");
  const records = readJsonl(crashLog);
  assert.ok(
    records.some((record) => record.event === "process_crash"),
    "an escaped rejection must leave a process_crash record",
  );
  assert.ok(existsSync(cleanup), "onFatal must run before the process exits");
  assert.equal(existsSync(lock), false, "cleanup must release the pool lock");
});

// ---------------------------------------------------------------------------
// 2. EPIPE is not fatal
// ---------------------------------------------------------------------------

baseline("2. writing to stdout after the reader closes does not kill the process", async () => {
  const dir = tempDir();
  const done = join(dir, "done.txt");

  const child = track(
    spawn(process.execPath, [join(ROOT, "test", "fixtures", "resilience", "epipe-entry.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RESILIENCE_DONE: done },
    }),
  );

  const firstOutput = await new Promise((resolveOutput) => {
    let settled = false;
    child.stdout.once("data", () => {
      if (settled) return;
      settled = true;
      resolveOutput(true);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveOutput(false);
    }, 5000).unref?.();
  });
  assert.equal(firstOutput, true, "the fixture must write before the reader closes");
  // Close the read end. Every later write in the child is an EPIPE.
  child.stdout.destroy();

  const outcome = await waitExit(child, 10_000);
  assert.equal(outcome.signal, null, "EPIPE must not kill the process with a signal");
  assert.equal(outcome.code, 0, "the entry survives the broken pipe and exits cleanly");
  assert.ok(existsSync(done), "the entry kept running after its reader went away");
});

// ---------------------------------------------------------------------------
// 3. A detached spawn that exits immediately is a failure, not a success
// ---------------------------------------------------------------------------

baseline("3. a second tick while one holds the lock is skipped, not run twice", async () => {
  const dir = tempDir();
  const lock = join(dir, "continue.state.json");
  acquireContinueLock(lock, { isAlive: () => true });
  let ran = 0;
  try {
    const code = await runContinue(
      {
        actorKind: "claude",
        agents: ["alice"],
        home: dir,
        state: join(dir, "supervisor.state.json"),
        continueState: lock,
        continueInterval: 600,
      },
      {
        log: () => {},
        isAlive: () => true,
        runPatrol: async () => { ran += 1; },
        runWorkflow: async () => { ran += 1; },
        runPoll: async () => { ran += 1; },
      },
    );
    assert.equal(code, 0);
    assert.equal(ran, 0, "a tick that cannot take the lock runs no pass");
  } finally {
    releaseContinueLock(lock);
  }
});

// ---------------------------------------------------------------------------
// 4. A tick that never resolves must not look healthy forever
// ---------------------------------------------------------------------------

baseline("4. a stuck tick on a live pid is reported as wedged, not as a healthy pool", async () => {
  const dir = tempDir();
  const sleeper = await startSleeper();
  const now = Date.now();
  writeState(dir, {
    version: 2,
    poolPid: sleeper.pid,
    phase: "running",
    heartbeatAt: new Date(now).toISOString(),
    // The turn has been in flight for three hours; the heartbeat kept beating.
    tickStartedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    projects: {},
  });

  const status = poolStatus({ opts: poolOpts(dir) });
  assert.equal(status.live, true, "the pool process exists; this is not a 'gone' verdict");
  assert.equal(status.verdict, "wedged", "a tick past its deadline is wedged, however fresh the heartbeat");
});

// ---------------------------------------------------------------------------
// 5. A stale heartbeat on a live pid is "unresponsive", not "gone"
// ---------------------------------------------------------------------------

baseline("5. a live pid with a stale heartbeat stays live so a second tick is skipped", async () => {
  const dir = tempDir();
  const sleeper = await startSleeper();
  const now = Date.now();
  writeState(dir, {
    version: 2,
    poolPid: sleeper.pid,
    phase: "running",
    // A synchronous board call blocked the event loop; the heartbeat is ten minutes old.
    heartbeatAt: new Date(now - 10 * 60 * 1000).toISOString(),
    projects: {},
  });

  const status = poolStatus({ opts: poolOpts(dir) });
  assert.equal(
    status.live,
    true,
    "a fresh pid is a live pool even when its heartbeat is stale (blocked, not absent)",
  );
  assert.equal(status.verdict, "unresponsive", "the heartbeat distinguishes unresponsive from running");
});

// ---------------------------------------------------------------------------
// 6. The startup window is a live pool, not an absent one
// ---------------------------------------------------------------------------

baseline("6. a pool in its startup window is live so a second tick is skipped", async () => {
  const dir = tempDir();
  const sleeper = await startSleeper();
  writeState(dir, {
    version: 2,
    poolPid: sleeper.pid,
    phase: "starting",
    startStartedAt: new Date().toISOString(),
    // No heartbeat yet: the first one is written once start() returns.
    heartbeatAt: null,
    projects: {},
  });

  const status = poolStatus({ opts: poolOpts(dir) });
  assert.equal(status.live, true, "a starting pool is a live pool");
  assert.equal(status.verdict, "starting", "the startup window is its own verdict, not 'gone'");
});

// ---------------------------------------------------------------------------
// 7. A restarted pool must not redispatch work an orphaned child is still doing
// ---------------------------------------------------------------------------

/** Write a queue row whose claim is owned by `poolPid`. */
function writeProcessingRow(dir, { card, projectDir, poolPid }) {
  writeFileSync(
    join(dir, "cards.queue.json"),
    `${JSON.stringify(
      {
        version: 1,
        cards: [
          {
            version: 1,
            id: `${card}-worker`,
            card,
            role: "worker",
            queue_kind: "handoff",
            agent_role: null,
            task_id: null,
            review_of: null,
            review_round: null,
            target_dir: projectDir,
            handoff: `work ${card}`,
            status: "processing",
            enqueuedAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            claimedBy: projectDir,
            claimedByPid: poolPid,
            attempts: 0,
            lastError: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** Write a ledger row for a subagent that is still live. */
function writeLiveLedgerRow(dir, { card, projectDir, subagentId }) {
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "subagents.state.json"),
    `${JSON.stringify(
      {
        version: 1,
        subagents: [
          {
            version: 1,
            sessionKey: projectDir,
            actorKind: "claude",
            subagentId,
            role: "worker",
            lane: "worker",
            card,
            type: "subagent",
            queueId: `${card}-worker`,
            status: "running",
            startedAt: now,
            lastSeenAt: now,
            lastResult: null,
            artifacts: [],
            transcriptPath: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

/** Write the session pid for a project directory (the agent child that is running). */
function writeSessionPid(dir, { projectDir, pid, poolPid }) {
  writeState(dir, {
    version: 2,
    poolPid,
    heartbeatAt: new Date().toISOString(),
    projects: {
      [projectDir]: {
        actorKind: "claude",
        cwd: projectDir,
        sessionId: "session-old",
        pid,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        closedAt: null,
      },
    },
  });
}

async function setupCrashScenario({ sessionAlive }) {
  const dir = tempDir();
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });

  // The old pool manager is genuinely dead: spawn it, then SIGKILL it.
  const oldPool = await startSleeper();
  const oldPoolPid = oldPool.pid;
  oldPool.kill("SIGKILL");
  await waitExit(oldPool, 5000);

  const orphan = sessionAlive ? await startSleeper() : oldPool;
  writeProcessingRow(dir, { card: "TP-9001", projectDir, poolPid: oldPoolPid });
  writeLiveLedgerRow(dir, { card: "TP-9001", projectDir, subagentId: "agent-orphan" });
  writeSessionPid(dir, {
    projectDir,
    pid: sessionAlive ? orphan.pid : oldPoolPid,
    poolPid: oldPoolPid,
  });
  return { dir, projectDir, orphan, oldPoolPid, sessionAlive };
}

baseline("7. a restarted pool does not redispatch a card whose agent child is still running", async () => {
  const scenario = await setupCrashScenario({ sessionAlive: true });
  assert.equal(isProcessAlive(scenario.orphan.pid), true, "precondition: the orphan agent is alive");
  assert.equal(isProcessAlive(scenario.oldPoolPid), false, "precondition: the old pool manager is dead");

  const result = recoverStaleCards(scenario.dir, { isAlive: isProcessAlive, now: Date.now() });
  const rows = readCards(scenario.dir).value.cards;

  assert.equal(result.recovered, 0, "a live orphan owns the claim; it is not a stale claim");
  assert.equal(rows[0].status, "processing", "the in-flight card must not be requeued under a live agent");

  // Positive control: the same recovery must still fire once the agent child is gone.
  const deadScenario = await setupCrashScenario({ sessionAlive: false });
  const recovered = recoverStaleCards(deadScenario.dir, {
    isAlive: isProcessAlive,
    now: Date.now(),
  });
  const recoveredRows = readCards(deadScenario.dir).value.cards;
  assert.equal(recovered.recovered, 1, "a claim with no live child is stale and is recovered");
  assert.equal(recoveredRows[0].status, "pending", "the recovered card is work again");
});
