/**
 * M6a — `GET /api/v1/events`, the SSE stream (§4.3 / §5.4).
 *
 * Driven over a **real socket** with `fetch`: the point of these cases is the
 * transport (chunked, long-lived, flush-per-write) as much as the payload, and a
 * mocked `res` would test neither. The board runs with a 10 ms poll so a test is
 * fast without the stream being special-cased for tests.
 *
 * What is asserted, and why each one matters:
 *   * a write made *in-process* (not over HTTP) still arrives — the stream is a
 *     cursor over `task_activities`, not a hook on the write routes;
 *   * `?after=<rev>` replays exactly the increments missed while away;
 *   * `task_heartbeat` is filtered out (§4.3: "排除纯心跳");
 *   * a garbage `after` is a 400, not a silent replay from zero.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";
import { formatEvent, isNoiseActivity, revisionFromRequest } from "../../src/server/sse.mjs";

const AGENT = { kind: "agent", id: "linus" };
const tempDirs = [];
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-sse-"));
  tempDirs.push(dir);
  taskd = await createTaskd({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    env: {},
    eventsPollMs: 10,
    eventsHeartbeatMs: 50,
  });
  base = taskd.url;
  taskd.board.commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/p", actor: AGENT });
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A minimal SSE reader: open a stream, collect `data:` payloads until a
 * predicate is satisfied (or the timeout fires and the test fails loudly).
 */
async function subscribe(path = "/api/v1/events") {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  const raw = [];

  const next = async (predicate, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!frames.some(predicate)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for an event; saw ${JSON.stringify(frames)}`);
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false, idle: true }), Math.min(remaining, 100))),
      ]);
      if (done) break;
      if (value === undefined) continue;
      const text = decoder.decode(value, { stream: true });
      raw.push(text);
      buffer += text;
      let split;
      // Frames are separated by a blank line.
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (raw.startsWith(":")) continue; // a comment / heartbeat ping
        const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine !== undefined) frames.push(JSON.parse(dataLine.slice("data: ".length)));
      }
    }
    return frames.find(predicate);
  };

  return {
    status: response.status,
    headers: response.headers,
    frames,
    raw,
    next,
    close: () => controller.abort(),
  };
}

const revision = async () => (await (await fetch(`${base}/health`)).json()).data.revision;

describe("server/events — the unit rules", () => {
  it("names heartbeat-only activities as noise", () => {
    assert.equal(isNoiseActivity({ event: "task_heartbeat" }), true);
    assert.equal(isNoiseActivity({ event: "task_moved" }), false);
    assert.equal(isNoiseActivity(null), false);
  });

  it("formats a frame with an id and an unnamed data payload", () => {
    const frame = formatEvent({ id: 3, revision: 12, event: "task_created", taskId: "t", changes: {}, createdAt: "2026-01-01T00:00:00.000Z" });
    assert.match(frame, /^id: 12\ndata: \{/);
    assert.match(frame, /"event":"task_created"/);
    assert.match(frame, /\n\n$/);
    assert.equal(frame.includes("event: task_created\n"), false, "names live in the JSON, so onmessage fires");
  });

  it("reads ?after= and Last-Event-ID, and refuses anything else", () => {
    const url = (q) => new URL(`http://x/api/v1/events${q}`);
    assert.equal(revisionFromRequest(url("?after=41"), { headers: {} }), 41);
    assert.equal(revisionFromRequest(url(""), { headers: { "last-event-id": "7" } }), 7);
    assert.equal(revisionFromRequest(url("?after=9"), { headers: { "last-event-id": "7" } }), 9, "the query wins");
    assert.equal(revisionFromRequest(url(""), { headers: {} }), null);
    assert.throws(() => revisionFromRequest(url("?after=later"), { headers: {} }), (err) => err.code === "VALIDATION_FAILED");
  });
});

describe("server/events — increments over a real socket", () => {
  it("streams a change made in-process, without going through an HTTP write", async () => {
    const stream = await subscribe();
    try {
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type"), /text\/event-stream/);

      // Written straight through the command layer — no route involved. If the
      // stream were hooked on the request path, this event would never arrive.
      const created = taskd.board.commands.createTask({ projectId: "proj", title: "streamed", actor: AGENT });
      const event = await stream.next((frame) => frame.event === "task_created");
      assert.equal(event.task_id, created.id);
      assert.equal(typeof event.revision, "number");
      assert.equal(event.actor_id, "linus");
      assert.equal(event.changes.identifier, created.identifier);
    } finally {
      stream.close();
    }
  });

  it("replays exactly the increments missed while disconnected", async () => {
    const { commands } = taskd.board;
    const seen = commands.createTask({ projectId: "proj", title: "already seen", actor: AGENT });
    const cursor = await revision();
    assert.ok(cursor > 0);

    // Written while nobody is listening.
    const missedA = commands.createTask({ projectId: "proj", title: "missed A", actor: AGENT });
    const missedB = commands.createTask({ projectId: "proj", title: "missed B", actor: AGENT });

    const stream = await subscribe(`/api/v1/events?after=${cursor}`);
    try {
      const second = await stream.next((frame) => frame.task_id === missedB.id);
      const first = stream.frames.find((frame) => frame.task_id === missedA.id);
      assert.ok(first, "the first missed increment was replayed");
      assert.ok(first.revision <= second.revision, "replayed in order");
      assert.equal(
        stream.frames.some((frame) => frame.task_id === seen.id),
        false,
        "nothing at or below the cursor is replayed",
      );
    } finally {
      stream.close();
    }
  });

  it("filters pure heartbeats but keeps the claim that preceded them", async () => {
    const { commands } = taskd.board;
    const task = commands.createTask({ projectId: "proj", title: "pulse", actor: AGENT });

    // Subscribe *before* the writes, or the claim would be older than the cursor.
    const stream = await subscribe();
    try {
      commands.claim({ id: task.id, actor: AGENT });
      const claimed = await stream.next((frame) => frame.event === "task_claimed");
      assert.equal(claimed.task_id, task.id);

      // A heartbeat bumps the revision but changes nothing a board renders.
      commands.heartbeat({ id: task.id, actor: AGENT });
      // ...and a real event after it proves the stream kept flowing past the noise.
      const comment = commands.addComment({ taskId: task.id, body: "still here", actor: AGENT });
      await stream.next((frame) => frame.event === "comment_added");

      assert.equal(
        stream.frames.some((frame) => frame.event === "task_heartbeat"),
        false,
        "heartbeats are noise (§4.3) and must not be streamed",
      );
      assert.equal(stream.frames.some((frame) => frame.task_id === comment.taskId), true);
    } finally {
      stream.close();
    }
  });

  it("keeps the connection alive with a comment ping, with no board write at all", async () => {
    const stream = await subscribe();
    try {
      // The reader discards comments, so prove liveness on the raw bytes: with a
      // 50 ms heartbeat and nothing else happening, a `: ping` must still arrive.
      await stream.next(() => false, 150).catch(() => {});
      assert.match(stream.raw.join(""), /: ping \d+/);
      assert.deepEqual(stream.frames, [], "a ping is not an increment");
    } finally {
      stream.close();
    }
  });

  it("answers 400 for a malformed ?after instead of silently resyncing", async () => {
    const response = await fetch(`${base}/api/v1/events?after=nope`);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "VALIDATION_FAILED");
    assert.equal(body.error.details.field, "after");
  });
});
