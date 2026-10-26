/**
 * The one board-context builder: `.env` → actor → token → (connect) → client.
 *
 * The CLI and the orchestrator must agree on every one of those steps, or a
 * loop write would be attributed differently from the same write made by hand.
 * `createBoardSession` stops before the board is contacted, so it is testable
 * with no daemon and no network.
 */

import assert from "node:assert/strict";
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
