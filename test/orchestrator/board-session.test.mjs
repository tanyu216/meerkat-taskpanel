/**
 * The board-visible card session row: stable segments, the one-shot command
 * shape, and the startup reconciliation's four filters.
 *
 * The CLI is the injected seam; nothing here spawns a process or talks to a
 * board.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  BOARD_SESSION_META_KIND,
  createBoardSession,
} from "../../src/orchestrator/board-session.mjs";

/** A `runCli` stand-in that records calls and answers by argv. */
function recorder(answer = () => ({ ok: true, data: {} })) {
  const calls = [];
  const run = (opts, agent, args, options) => {
    calls.push({ opts, agent, args, options });
    return answer(args);
  };
  return { run, calls };
}

const state = join("/tmp", "loop-one", "supervisor.state.json");
const loopId = resolve("/tmp/loop-one");

describe("board session writer", () => {
  it("registers a stable segment with the round and loop in meta", () => {
    const { run, calls } = recorder();
    const board = createBoardSession({ opts: { state, cliTimeoutMs: 30_000 }, run });
    assert.equal(board.loopId, loopId);
    const result = board.register({
      card: "TP-1",
      seg: "worker",
      owner: "Linus",
      ownerKind: "claude",
      phase: "worker",
      pid: 4242,
      round: 3,
      generation: 2,
      planMode: "resume",
      carry: "rekeyed_rework",
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const { opts, agent, args, options } = calls[0];
    assert.equal(agent, "Orchestrator");
    assert.equal(options.actorKind, "system");
    assert.equal(opts.cliTimeoutMs, 5000, "a board write is bounded even when the loop's CLI is not");
    assert.deepEqual(args.slice(0, 8), [
      "session", "set", "TP-1", "--seg", "worker", "--owner", "Linus", "--owner-kind",
    ]);
    const joined = args.join(" ");
    assert.match(joined, /--goal worker session for TP-1 — round 3/);
    assert.match(joined, /--phase worker/);
    assert.match(joined, /--pid 4242/);
    assert.match(joined, /kind=card-session/);
    assert.match(joined, new RegExp(`loop=${loopId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(joined, /round=3/);
    assert.match(joined, /generation=2/);
    assert.match(joined, /plan_mode=resume/);
    assert.match(joined, /carry=rekeyed_rework/);
  });

  it("skips a session with no owner and writes nothing", () => {
    const { run, calls } = recorder();
    const board = createBoardSession({ opts: { state }, run });
    const result = board.register({ card: "TP-1", seg: "worker", owner: "" });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0, "a wrong owner is worse than no row");
  });

  it("closes by the natural key and swallows a never-registered row", () => {
    const { run, calls } = recorder((args) =>
      args.includes("list")
        ? { ok: true, data: { sessions: [] } }
        : { ok: false, code: "NOT_FOUND", error: "no session" },
    );
    const warnings = [];
    const board = createBoardSession({
      opts: { state },
      run,
      log: (line, meta) => warnings.push({ line, meta }),
    });
    const result = board.close({ card: "TP-1", seg: "worker", owner: "Linus", failed: true });
    assert.equal(result.code, "NOT_FOUND");
    assert.equal(warnings.length, 0, "a NOT_FOUND close is not worth a warning");
    assert.deepEqual(calls[0].args, [
      "session", "close", "TP-1", "--seg", "worker", "--owner", "Linus", "--failed",
    ]);
  });

  it("warns once when the board is unreachable", () => {
    const { run } = recorder(() => ({ ok: false, error: "connection refused" }));
    const warnings = [];
    const board = createBoardSession({
      opts: { state },
      run,
      log: (line, meta) => warnings.push({ line, meta }),
    });
    board.register({ card: "TP-1", seg: "worker", owner: "Linus", ownerKind: "claude" });
    board.register({ card: "TP-2", seg: "worker", owner: "Linus", ownerKind: "claude" });
    assert.equal(warnings.length, 1, "same failure, one line per process");
    assert.match(warnings[0].line, /connection refused/);
    assert.equal(warnings[0].meta.level, "warn");
  });

  it("reconciles only this loop's card rows, leaving live work alone", () => {
    const closed = [];
    const rows = [
      { task_id: "t-live", seg: "worker", owner: "Linus", pid: 111, meta: { loop: loopId, kind: BOARD_SESSION_META_KIND } },
      { task_id: "t-alive", seg: "worker", owner: "Linus", pid: 222, meta: { loop: loopId, kind: BOARD_SESSION_META_KIND } },
      { task_id: "t-dead", seg: "worker", owner: "Linus", pid: 333, meta: { loop: loopId, kind: BOARD_SESSION_META_KIND } },
      { task_id: "t-other-loop", seg: "worker", owner: "Linus", pid: 444, meta: { loop: "/tmp/other", kind: BOARD_SESSION_META_KIND } },
      { task_id: "t-not-ours", seg: "manual", owner: "Linus", pid: 555, meta: { loop: loopId, kind: "other" } },
    ];
    const { run } = recorder((args) => {
      if (args.includes("list")) return { ok: true, data: { sessions: rows } };
      closed.push(args);
      return { ok: true, data: {} };
    });
    const board = createBoardSession({
      opts: { state },
      run,
      isAlive: (pid) => pid === 222,
    });
    const result = board.reconcile({
      liveKeys: new Set(["t-live|worker|Linus"]),
      deadline: Date.now() + 60_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.closed, 1, "only the dead, unowned row is closed");
    assert.equal(result.skipped, 4);
    assert.deepEqual(closed[0], [
      "session", "close", "t-dead", "--seg", "worker", "--owner", "Linus", "--failed",
    ]);
  });

  it("closes nothing when the list read fails", () => {
    const { run, calls } = recorder(() => ({ ok: false, error: "down" }));
    const board = createBoardSession({ opts: { state }, run, log: () => {} });
    const result = board.reconcile({ liveKeys: new Set(), deadline: Date.now() + 60_000 });
    assert.equal(result.ok, false);
    assert.equal(result.closed, 0);
    assert.equal(calls.length, 1, "a failed list is one read, not silently a scan");
  });

  it("stops at the deadline instead of closing the whole board", () => {
    const { run, calls } = recorder((args) => {
      if (args.includes("list")) {
        return {
          ok: true,
          data: {
            sessions: [
              { task_id: "t-1", seg: "worker", owner: "Linus", pid: 1, meta: { loop: loopId, kind: BOARD_SESSION_META_KIND } },
              { task_id: "t-2", seg: "worker", owner: "Linus", pid: 1, meta: { loop: loopId, kind: BOARD_SESSION_META_KIND } },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    });
    const board = createBoardSession({ opts: { state }, run });
    const result = board.reconcile({ liveKeys: new Set(), deadline: Date.now() - 1 });
    assert.equal(result.timedOut, true);
    assert.equal(result.closed, 0);
    assert.equal(calls.length, 1, "the list is the only call once the budget is gone");
  });

  it("does not write in a dry run", () => {
    const { run, calls } = recorder();
    const board = createBoardSession({ opts: { state, dryRun: true }, run });
    assert.equal(board.register({ card: "TP-1", seg: "worker", owner: "Linus" }).ok, true);
    assert.equal(calls.length, 0);
  });
});
