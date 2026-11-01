/**
 * `issue wait` — the worker's bounded in-turn hold.
 *
 * The command is a pure client of the board: it reads the card and its trail,
 * never claims, moves or comments, and only pulses the caller's own heartbeat.
 * The fake client here keeps the test deterministic; the real route is covered
 * by the CLI contract snapshot and the board's own tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMANDS } from "../../src/cli/commands/issue.mjs";

const waitCommand = COMMANDS.find((command) => command.name === "wait");

const question = (createdAt = "2026-01-01T00:00:00Z") => ({
  id: "q1",
  kind: "question",
  author_kind: "agent",
  body: "Which option?",
  created_at: createdAt,
});
const humanNote = (id = "h1", extra = {}) => ({
  id,
  kind: "discuss",
  author_kind: "human",
  body: "Use B.",
  created_at: "2026-01-01T00:05:00Z",
  ...extra,
});
const agentNote = (id = "n1") => ({
  id,
  kind: "note",
  author_kind: "agent",
  body: "decision: use B",
  created_at: "2026-01-01T00:05:00Z",
});

function scripted({ tasks, comments, onHeartbeat, failGet = 0 }) {
  let reads = 0;
  let heartbeats = 0;
  return {
    get reads() {
      return reads;
    },
    get heartbeats() {
      return heartbeats;
    },
    async get(path) {
      if (reads < failGet) throw new Error("board down");
      if (path.endsWith("/comments")) return { comments: typeof comments === "function" ? comments(reads) : comments };
      const task = typeof tasks === "function" ? tasks(reads) : tasks;
      reads += 1;
      return { task };
    },
    async post() {
      heartbeats += 1;
      onHeartbeat?.();
      return { task: {} };
    },
  };
}

const ctxFor = (client, flags = {}) => ({
  client,
  args: { ref: "T-1" },
  flags: { timeout: 200, interval: 1, heartbeat: 0, ...flags },
  identity: { id: "alice", actor: { kind: "claude", id: "alice" } },
});

const exitOf = (result) => result.exit ?? 0;

describe("cli/issue wait — the worker's bounded hold", () => {
  it("answers as soon as the director releases the card", async () => {
    const client = scripted({
      tasks: { status: "todo", claimed_by_actor: null },
      comments: [agentNote(), question()],
    });
    const result = await waitCommand.run(ctxFor(client));
    assert.equal(result.data.outcome, "answered");
    assert.equal(result.data.status, "todo");
    assert.equal(result.data.question_id, "q1");
    assert.match(result.data.answer, /decision: use B/);
    assert.equal(exitOf(result), 0);
  });

  it("answers on a director note even before the release", async () => {
    const client = scripted({
      tasks: { status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z", claimed_by_actor: { display_name: "alice" } },
      comments: [agentNote(), question()],
    });
    const result = await waitCommand.run(ctxFor(client));
    assert.equal(result.data.outcome, "answered");
    assert.equal(result.data.status, "in_progress");
  });

  it("answers on a newer human comment of any kind", async () => {
    const client = scripted({
      tasks: { status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z", claimed_by_actor: { display_name: "alice" } },
      comments: [humanNote("h1", { kind: "question" }), question()],
    });
    const result = await waitCommand.run(ctxFor(client));
    assert.equal(result.data.outcome, "answered");
    assert.match(result.data.answer, /\[human\] Use B\./);
  });

  it("does not treat an older human comment as the answer", async () => {
    const client = scripted({
      tasks: { status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z", claimed_by_actor: { display_name: "alice" } },
      // Newest first: the question is newer than the human note.
      comments: [question(), humanNote("old", { created_at: "2025-12-31T00:00:00Z" })],
    });
    const result = await waitCommand.run(ctxFor(client, { timeout: 20 }));
    assert.equal(result.data.outcome, "timeout");
    assert.equal(exitOf(result), 3);
  });

  it("escalates immediately when the director parks the card for a human", async () => {
    const client = scripted({
      tasks: { status: "awaiting", awaiting_reason: "E3" },
      comments: [humanNote("h1"), question()],
    });
    const result = await waitCommand.run(ctxFor(client));
    assert.equal(result.data.outcome, "escalated");
    assert.equal(result.data.status, "awaiting");
    assert.equal(exitOf(result), 3);
  });

  it("stops when the card leaves the work states", async () => {
    for (const status of ["in_review", "done", "canceled", "blocked"]) {
      const client = scripted({ tasks: { status }, comments: [question()] });
      const result = await waitCommand.run(ctxFor(client));
      assert.equal(result.data.outcome, "moved", status);
      assert.equal(exitOf(result), 3);
    }
  });

  it("stops when another actor owns the claim", async () => {
    const client = scripted({
      tasks: { status: "in_progress", claimed_by_actor: { display_name: "bob" } },
      comments: [question()],
    });
    const result = await waitCommand.run(ctxFor(client));
    assert.equal(result.data.outcome, "moved");
    assert.match(result.human, /bob/);
  });

  it("times out with the card still in progress", async () => {
    const client = scripted({
      tasks: { status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z", claimed_by_actor: { display_name: "alice" } },
      comments: [question()],
    });
    const result = await waitCommand.run(ctxFor(client, { timeout: 20 }));
    assert.equal(result.data.outcome, "timeout");
    assert.equal(result.data.status, "in_progress");
    assert.equal(exitOf(result), 3);
  });

  it("pulses the caller's heartbeat while it waits", async () => {
    const client = scripted({
      tasks: { status: "in_progress", status_changed_at: "2025-12-31T23:00:00Z", claimed_by_actor: { display_name: "alice" } },
      comments: [question()],
    });
    const result = await waitCommand.run(ctxFor(client, { timeout: 40, interval: 1, heartbeat: 0.001 }));
    assert.equal(result.data.outcome, "timeout");
    assert.ok(client.heartbeats > 0, "the hold must keep the claim fresh");
  });

  it("reports an unreadable board rather than calling it an answer", async () => {
    const client = scripted({ tasks: {}, comments: [], failGet: 3 });
    const result = await waitCommand.run(ctxFor(client, { timeout: 100, interval: 1 }));
    assert.equal(result.data.outcome, "error");
    assert.equal(exitOf(result), 1);
  });

  it("refuses when there is no question to wait on", async () => {
    const client = scripted({ tasks: { status: "in_progress" }, comments: [] });
    await assert.rejects(
      () => waitCommand.run(ctxFor(client)),
      (err) => {
        assert.equal(err.code, "CLI_USAGE");
        return true;
      },
    );
  });

  it("refuses an explicit question id that is not on the card", async () => {
    const client = scripted({
      tasks: { status: "in_progress" },
      comments: [question()],
    });
    await assert.rejects(
      () => waitCommand.run(ctxFor(client, { question: "missing" })),
      (err) => {
        assert.equal(err.code, "CLI_USAGE");
        return true;
      },
    );
  });
});
