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
  KIND_CONFIG_DIR_ENV,
  LIVE_STATUSES,
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  QUEUE_FILES,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  STATE_FILES,
  agentPaths,
  resolveKindConfigPath,
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
    assert.equal(paths.agentDir, ".claude");
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
      join("/home/op", ".claude", "skills", "meerkat", "projects.json"),
    );
    assert.equal(paths.loopSkill, join("/home/op", ".claude", "skills", "meerkat-loop"));
    assert.equal(paths.boardSkill, join("/home/op", ".claude", "skills", "meerkat"));
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

describe("resolveKindConfigPath — one config per actor kind at the program root", () => {
  it("names .env.<kind> under an injected program root", () => {
    for (const kind of ["claude", "codex", "pi"]) {
      assert.equal(
        resolveKindConfigPath({ actorKind: kind, root: "/opt/tree", env: {} }),
        join("/opt/tree", `.env.${kind}`),
      );
    }
  });

  it("lets MEERKAT_TASKPANEL_CONFIG_DIR replace the program root", () => {
    assert.equal(
      resolveKindConfigPath({
        actorKind: "codex",
        root: "/opt/tree",
        env: { [KIND_CONFIG_DIR_ENV]: "/srv/tp-config" },
      }),
      join("/srv/tp-config", ".env.codex"),
    );
  });

  it("resolves a relative override against cwd", () => {
    assert.equal(
      resolveKindConfigPath({
        actorKind: "pi",
        root: "/opt/tree",
        env: { [KIND_CONFIG_DIR_ENV]: "config" },
        cwd: "/work",
      }),
      join("/work", "config", ".env.pi"),
    );
  });

  it("accepts any safe kind token, not just the installed three", () => {
    assert.equal(
      resolveKindConfigPath({ actorKind: "system", root: "/opt/tree", env: {} }),
      join("/opt/tree", ".env.system"),
    );
    assert.equal(
      resolveKindConfigPath({ actorKind: "openclaw", root: "/opt/tree", env: {} }),
      join("/opt/tree", ".env.openclaw"),
    );
  });

  it("has no file for the human or an absent kind", () => {
    assert.equal(resolveKindConfigPath({ actorKind: "human", env: {} }), null);
    assert.equal(resolveKindConfigPath({ actorKind: "", env: {} }), null);
    assert.equal(resolveKindConfigPath({ env: {} }), null);
  });

  it("refuses a token that is not a plain file-name segment", () => {
    for (const kind of ["../escape", "a/b", "two words", "."]) {
      assert.throws(
        () => resolveKindConfigPath({ actorKind: kind, root: "/opt/tree", env: {} }),
        /invalid actor kind/,
      );
    }
  });
});
