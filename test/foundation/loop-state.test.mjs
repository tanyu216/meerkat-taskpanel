/**
 * The loop's state-file vocabulary and pool defaults — the names the
 * orchestrator writes and the installer's status probe reads.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  LIVE_STATUSES,
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  QUEUE_FILES,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  STATE_FILES,
  statePathsForDir,
} from "../../src/foundation/loop-state.mjs";

describe("loop-state — the loop's state vocabulary", () => {
  it("names the state siblings under one directory", () => {
    assert.deepEqual(statePathsForDir("/state"), {
      continueState: join("/state", "continue.state.json"),
      slaLedger: join("/state", "sla-ledger.json"),
      workflowLedger: join("/state", "workflow-ledger.json"),
      slaLastOk: join("/state", "loop-patrol-last-ok.json"),
    });
  });

  it("pins the queue, liveness and session constants", () => {
    assert.deepEqual(QUEUE_FILES, {
      continuePending: "continue.pending.json",
      continueProcessing: "continue.processing.json",
      cards: "cards.queue.json",
      ledger: "subagents.state.json",
      sessions: "sessions.state.json",
    });
    assert.deepEqual(LIVE_STATUSES, ["spawned", "running", "reattaching"]);
    assert.equal(SESSION_LOCK_FILE, "session.lock");
    assert.equal(STATE_FILES.runLock, "run.lock");
    assert.equal(POOL_HEARTBEAT_MS, 15_000);
    assert.equal(POOL_STALE_MS, 4 * POOL_HEARTBEAT_MS);
    assert.deepEqual(SESSION_DEFAULTS, {
      maxConcurrency: 8,
      projectConcurrency: 8,
      poolMax: 8,
      projectIdleMs: 30 * 60 * 1000,
      sessionMaxAgeMs: 24 * 60 * 60 * 1000,
      turnTimeoutMs: 30 * 60 * 1000,
      pollMs: 1000,
    });
  });
});
