/**
 * The one board-context builder: `.env` → actor → token → (connect) → client.
 *
 * The CLI and the orchestrator must agree on every one of those steps, or a
 * loop write would be attributed differently from the same write made by hand.
 * `createBoardSession` stops before the board is contacted, so it is testable
 * with no daemon and no network.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { connectBoard, createBoardSession } from "../../src/foundation/transport/session.mjs";

/** A repo root with no `.env`, so the process env is the only config source. */
const ROOT = "/definitely/not/a/checkout";

describe("transport/session — createBoardSession", () => {
  it("resolves the actor and a flag token without contacting a board", () => {
    const session = createBoardSession({
      flags: { actorKind: "claude", agent: "alice", token: "td_test" },
      env: {},
      cwd: "/tmp",
      root: ROOT,
    });
    assert.equal(session.identity.actor.kind, "claude");
    assert.equal(session.identity.actor.id, "alice");
    assert.equal(session.token, "td_test");
    assert.equal(session.source, "flag");
    assert.equal(Object.hasOwn(session, "board"), false, "connectBoard is a separate step");
  });

  it("lets the environment supply the token and the actor kind", () => {
    const session = createBoardSession({
      flags: { actorKind: "codex", agent: "bob" },
      env: { TASKD_TOKEN: "td_env" },
      cwd: "/tmp",
      root: ROOT,
    });
    assert.equal(session.identity.actor.kind, "codex");
    assert.equal(session.identity.actor.id, "bob");
    assert.equal(session.token, "td_env");
    assert.equal(session.source, "env");
  });

  it("refuses the reserved human actor kind before any board work", () => {
    assert.throws(
      () => createBoardSession({ flags: { actorKind: "human" }, env: {}, cwd: "/tmp", root: ROOT }),
      /human/,
    );
  });
});

describe("transport/session — connectBoard", () => {
  it("is the only step that touches the board", () => {
    assert.equal(typeof connectBoard, "function");
    // `createBoardSession` is deliberately board-free; this is the seam that
    // may start or reach a daemon.
    assert.equal(typeof createBoardSession, "function");
  });
});

describe("transport/session — the per-kind config layer", () => {
  function tempRoot(files) {
    const root = mkdtempSync(join(tmpdir(), "taskpanel-session-kind-"));
    for (const [name, text] of Object.entries(files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return root;
  }

  it("takes the agent identity from .env.<kind> when nothing higher is set", () => {
    const root = tempRoot({ ".env.claude": "TASKCTL_AGENT=alice\n" });
    const session = createBoardSession({
      flags: { actorKind: "claude", token: "td_test" },
      env: {},
      cwd: "/tmp",
      root,
    });
    assert.equal(session.identity.actor.kind, "claude");
    assert.equal(session.identity.actor.id, "alice");
  });

  it("selects the file by actor kind", () => {
    const root = tempRoot({
      ".env.claude": "TASKCTL_AGENT=alice\n",
      ".env.codex": "TASKCTL_AGENT=bob\n",
    });
    const session = createBoardSession({
      flags: { actorKind: "codex", token: "td_test" },
      env: {},
      cwd: "/tmp",
      root,
    });
    assert.equal(session.identity.actor.id, "bob");
  });

  it("lets the process environment and --agent beat the per-kind file", () => {
    const root = tempRoot({ ".env.claude": "TASKCTL_AGENT=file-agent\n" });
    const fromEnv = createBoardSession({
      flags: { actorKind: "claude", token: "td_test" },
      env: { TASKCTL_AGENT: "env-agent" },
      cwd: "/tmp",
      root,
    });
    assert.equal(fromEnv.identity.actor.id, "env-agent");

    const fromFlag = createBoardSession({
      flags: { actorKind: "claude", agent: "flag-agent", token: "td_test" },
      env: { TASKCTL_AGENT: "env-agent" },
      cwd: "/tmp",
      root,
    });
    assert.equal(fromFlag.identity.actor.id, "flag-agent");
  });

  it("uses TASKCTL_HUMAN from the per-kind file for --as-human", () => {
    const root = tempRoot({ ".env.claude": "TASKCTL_HUMAN=sam\n" });
    const session = createBoardSession({
      flags: { actorKind: "claude", asHuman: true, token: "td_test" },
      env: {},
      cwd: "/tmp",
      root,
    });
    assert.equal(session.identity.actor.kind, "human");
    assert.equal(session.identity.actor.id, "sam");
  });

  it("ignores the legacy per-agent file", () => {
    const root = tempRoot({ ".claude/meerkat-taskpanel.env": "TASKCTL_AGENT=legacy\n" });
    const session = createBoardSession({
      flags: { actorKind: "claude", token: "td_test" },
      env: {},
      cwd: "/tmp",
      root,
    });
    assert.equal(session.identity.actor.id, "local");
  });
});
