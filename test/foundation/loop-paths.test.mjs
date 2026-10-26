/**
 * The loop's host-side vocabulary: agent directories, state-file names and the
 * session defaults. Shared by the orchestrator, the installer and the status
 * probe, so a rename cannot leave one of them reading a file nobody writes.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import {
  AGENT_DIRS,
  LIVE_STATUSES,
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  QUEUE_FILES,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  STATE_FILES,
  agentPaths,
  statePathsForDir,
} from "../../src/foundation/loop-paths.mjs";

describe("loop-paths — the loop's host-side vocabulary", () => {
  it("names the three agent directories", () => {
    assert.deepEqual(AGENT_DIRS, {
      claude: ".claude",
      codex: ".codex",
      pi: ".agents",
    });
  });

  it("derives one agent's paths from its home", () => {
    const paths = agentPaths("/home/op", "claude");
    assert.equal(paths.config, join("/home/op", ".claude", "meerkat-taskpanel.env"));
    assert.equal(
      paths.state,
      join("/home/op", ".claude", "meerkat-taskpanel", "supervisor.state.json"),
    );
    assert.equal(
      paths.log,
      join("/home/op", ".claude", "meerkat-taskpanel", "supervisor.log"),
    );
    assert.equal(
      paths.projectsJson,
      join("/home/op", ".claude", "skills", "meerkat-taskpanel", "projects.json"),
    );
    assert.equal(paths.loopSkill, join("/home/op", ".claude", "skills", "meerkat-loop"));
    assert.equal(paths.boardSkill, join("/home/op", ".claude", "skills", "meerkat-taskpanel"));
    assert.equal(paths.stateDir, join("/home/op", ".claude", "meerkat-taskpanel"));
  });

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
