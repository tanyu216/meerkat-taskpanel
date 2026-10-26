/**
 * The hub's single board stream: frame decoding, the reconnect ladder, the
 * replay ring, and a clean stop.
 *
 * The board is a fake async generator, so these legs isolate the stream's own
 * decisions from HTTP and from the server.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBoardStream } from "../../src/cli/hub/stream.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(fn, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

/** One SSE frame, exactly as the board writes it. */
function frame(id, data) {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A generator that yields the given frames and then waits for the abort. */
async function* held(frames, signal) {
  for (const text of frames) yield text;
  await new Promise((done) => {
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
}

describe("hub board stream", () => {
  it("decodes frames, tracks the cursor and replays from the ring", async () => {
    const events = [];
    const states = [];
    const stream = createBoardStream({
      client: {
        stream: async (_path, { signal } = {}) => held([
          frame(1, { event: "task_created", task_id: "t1" }),
          frame(2, { event: "comment_added", task_id: "t1" }),
        ], signal),
      },
      onEvent: (event) => events.push(event),
      onState: (state) => states.push(state.state),
      retryMinMs: 5,
      retryMaxMs: 10,
    });

    void stream.start();
    await waitFor(() => events.length === 2);
    assert.deepEqual(events.map((event) => event.id), [1, 2]);
    assert.equal(stream.revision, 2);
    assert.deepEqual(stream.since(0).events.map((event) => event.id), [1, 2]);
    assert.deepEqual(stream.since(2).events, []);
    assert.equal(states.includes("open"), true);

    await stream.stop();
    assert.equal(states.includes("closed"), false); // an abort is not a board close
  });

  it("reconnects and keeps feeding both streams", async () => {
    const events = [];
    let calls = 0;
    const stream = createBoardStream({
      client: {
        stream: async (_path, { signal } = {}) => {
          calls += 1;
          if (calls === 1) {
            // The first connection ends: the loop must reconnect.
            return (async function* first() {
              yield frame(1, { event: "task_created", task_id: "t1" });
            })();
          }
          return held([frame(2, { event: "task_moved", task_id: "t1" })], signal);
        },
      },
      onEvent: (event) => events.push(event.id),
      retryMinMs: 5,
      retryMaxMs: 10,
    });

    void stream.start();
    await waitFor(() => events.includes(2));
    assert.ok(calls >= 2, "the stream must reconnect after a break");
    assert.deepEqual(events, [1, 2]);
    assert.deepEqual(stream.since(1).events.map((event) => event.id), [2]);

    await stream.stop();
  });

  it("marks a cursor older than the ring as a gap", async () => {
    const stream = createBoardStream({
      client: {
        stream: async (_path, { signal } = {}) => held([
          frame(5, { event: "a" }),
          frame(6, { event: "b" }),
        ], signal),
      },
      ringSize: 2,
      onEvent: () => {},
      retryMinMs: 5,
      retryMaxMs: 10,
    });

    void stream.start();
    await waitFor(() => stream.retained === 2);
    assert.equal(stream.since(3).gap, true);
    assert.deepEqual(stream.since(4).events.map((event) => event.id), [5, 6]);
    assert.deepEqual(stream.since(6).events, []);

    await stream.stop();
  });

  it("survives an event handler that throws", async () => {
    let handled = 0;
    const stream = createBoardStream({
      client: { stream: async (_path, { signal } = {}) => held([frame(1, { event: "a" })], signal) },
      onEvent: () => {
        handled += 1;
        throw new Error("boom");
      },
      retryMinMs: 5,
    });
    void stream.start();
    await waitFor(() => stream.retained === 1);
    assert.equal(handled, 1);
    await stream.stop();
  });

  it("reports a stream error and reconnects", async () => {
    const states = [];
    let calls = 0;
    const stream = createBoardStream({
      client: {
        stream: async (_path, { signal } = {}) => {
          calls += 1;
          if (calls === 1) throw new Error("refused");
          return held([frame(1, { event: "a" })], signal);
        },
      },
      onEvent: () => {},
      onState: (state) => states.push(state.state),
      retryMinMs: 5,
      retryMaxMs: 10,
    });
    void stream.start();
    await waitFor(() => states.includes("error"));
    await waitFor(() => states.includes("open"));
    await stream.stop();
  });

  it("stops before it starts and treats an empty ring as no replay", async () => {
    const stream = createBoardStream({
      client: { stream: async (_path, { signal } = {}) => held([], signal) },
      onEvent: () => {},
    });
    assert.deepEqual(stream.since(0), { gap: false, events: [] });
    await stream.stop();
  });

  it("stops a quiet stream without waiting for a frame", async () => {
    const stream = createBoardStream({
      client: { stream: async (_path, { signal } = {}) => held([], signal) },
      onEvent: () => {},
      retryMinMs: 5,
    });

    void stream.start();
    await waitFor(() => stream.retained === 0);
    await stream.stop();
  });
});
