/**
 * `openEventStream` without a socket.
 *
 * `test/server/events.test.mjs` proves the wire contract over a real socket;
 * these cases drive the engine's three failure paths deterministically — a read
 * that throws, a socket that stops accepting writes, and a replay longer than
 * one page. None of them needs wall-clock time: the poll/heartbeat timers are
 * parked far in the future and the page yield is a `setImmediate`.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { describe, it } from "node:test";

import { openEventStream } from "../../src/server/sse.mjs";

/** A `ServerResponse` with just the surface the stream touches. */
class FakeRes extends EventEmitter {
  /**
   * @param {{
   *   throwOn?: (text: string, n: number) => boolean,
   *   falseOn?: (text: string, n: number) => boolean,
   * }} [hooks]
   */
  constructor({ throwOn = null, falseOn = null } = {}) {
    super();
    this.chunks = [];
    this.writeCount = 0;
    this.ended = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.throwOn = throwOn;
    this.falseOn = falseOn;
  }

  writeHead() {}

  write(text) {
    this.writeCount += 1;
    if (this.throwOn?.(text, this.writeCount)) throw new Error("peer vanished");
    this.chunks.push(text);
    return this.falseOn?.(text, this.writeCount) ? false : true;
  }

  end() {
    this.ended = true;
    this.writableEnded = true;
  }
}

/** One activity, revision = id. */
function activity(n) {
  return {
    id: n,
    taskId: "t",
    actorKind: "agent",
    actorId: "linus",
    event: "task_created",
    changes: {},
    revision: n,
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}

/** A cursor reader over a fixed set of rows, honouring the filter it is given. */
function fakeBoard(rows, seen = []) {
  return {
    db: {},
    repos: {
      activities: {
        list(filter = {}) {
          seen.push(filter);
          const after = filter.afterRevision ?? -Infinity;
          return rows.filter((row) => row.revision > after).slice(0, filter.limit ?? 500);
        },
      },
    },
  };
}

/** The frame ids the stream has written, in order. */
function idsOf(res) {
  return res.chunks
    .filter((chunk) => chunk.startsWith("id: "))
    .map((chunk) => Number.parseInt(chunk.slice(4), 10));
}

/** Let pending `setImmediate` pages and microtasks run. */
async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Wait for a predicate, driven by real (1 ms) timers. */
async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the stream");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const PARKED = 1e9;

describe("server/sse-stream — the engine's failure paths", () => {
  it("logs a read failure and closes the stream instead of throwing in the timer", async () => {
    const errors = [];
    const res = new FakeRes();
    const board = {
      db: {},
      repos: {
        activities: {
          list() {
            throw new Error("database is gone");
          },
        },
      },
    };

    const stream = openEventStream({
      res,
      board,
      after: 0,
      pollMs: PARKED,
      heartbeatMs: PARKED,
      onError: (err) => errors.push(err),
    });

    await settle(2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "database is gone");
    assert.equal(res.ended, true, "the response is ended, not left open");
    stream.close();
  });

  it("pauses on backpressure and resumes on drain without dropping or duplicating a frame", async () => {
    const res = new FakeRes({ falseOn: (text) => text.startsWith("id: 2") });
    const stream = openEventStream({
      res,
      board: fakeBoard([activity(1), activity(2), activity(3)]),
      after: 0,
      pollMs: PARKED,
      heartbeatMs: PARKED,
    });

    await waitFor(() => idsOf(res).length >= 2);
    assert.deepEqual(idsOf(res), [1, 2], "the frame that filled the buffer was accepted");

    await settle(2);
    assert.deepEqual(idsOf(res), [1, 2], "no further frame is written while paused");

    res.emit("drain");
    await waitFor(() => idsOf(res).length === 3);
    assert.deepEqual(idsOf(res), [1, 2, 3], "the resumed page neither drops nor repeats a row");
    stream.close();
  });

  it("replays more than one page in order, yielding between pages", async () => {
    const seen = [];
    const res = new FakeRes();
    const stream = openEventStream({
      res,
      board: fakeBoard([1, 2, 3, 4, 5].map(activity), seen),
      after: 0,
      replayLimit: 2,
      pollMs: PARKED,
      heartbeatMs: PARKED,
    });

    await waitFor(() => idsOf(res).length === 5);
    assert.deepEqual(idsOf(res), [1, 2, 3, 4, 5]);
    assert.ok(seen.length >= 3, `a 5-row replay is three pages, saw ${seen.length}`);
    assert.ok(seen.every((filter) => filter.order === "revision"), "the cursor column drives the order");
    stream.close();
  });

  it("closes rather than pausing when a write throws", async () => {
    const res = new FakeRes({ throwOn: (text) => text.startsWith("id: 2") });
    const stream = openEventStream({
      res,
      board: fakeBoard([activity(1), activity(2), activity(3)]),
      after: 0,
      pollMs: PARKED,
      heartbeatMs: PARKED,
    });

    await settle(3);
    assert.equal(res.ended, true, "a vanished peer ends the stream");
    assert.deepEqual(idsOf(res), [1], "the throwing frame was not recorded");
    stream.close();
  });
});
