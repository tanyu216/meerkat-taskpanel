/**
 * `services/events.js` — the SSE shell (F4), browser-free.
 *
 * `lib/events.test.mjs` already pins the *pure* half (cursor, targets, resync
 * query, the backoff ladder); this file pins the shell that owns the
 * `EventSource`: the URL it builds, the status it surfaces, the cursor it keeps,
 * and the reconnect / resync behaviour. `EventSource` is the external boundary,
 * so it is injected (`EventSourceImpl`) and driven by hand — the module's own
 * logic runs for real. The *clock* is the second boundary (T-20261014-213238
 * gave the client a reconnect ladder of its own), so it is injected too and a
 * test takes a step by calling `clock.tick()` rather than sleeping.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { RECONNECT_BASE_MS, SHUTDOWN_EVENT } from "../../web/src/lib/events.js";
import { createEventClient } from "../../web/src/services/events.js";

/** A hand-driven stand-in for the browser's `EventSource`. */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, handler) {
    this.listeners.set(name, handler);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.({ type: "error" });
  }
  emit(id, data) {
    this.onmessage?.({ lastEventId: id === null ? "" : String(id), data });
  }
  /** Dispatch a *named* frame — the server's deliberate stop (`SHUTDOWN_EVENT`). */
  named(name, data) {
    this.listeners.get(name)?.({ type: name, data });
  }
}

/**
 * A hand-driven clock, so the reconnect ladder is asserted instead of slept
 * through: `schedule` records every delay, `tick` is "that delay elapsed".
 */
function clock() {
  const queue = [];
  let nextId = 0;
  return {
    delays: [],
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      queue.push({ id, fn, ms });
      this.delays.push(ms);
      return id;
    },
    cancel(id) {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index !== -1) queue.splice(index, 1);
    },
    tick() {
      const entry = queue.shift();
      if (entry === undefined) return false;
      entry.fn();
      return true;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/** Fresh fake per test, plus a recorded status trace and a driven clock. */
function harness() {
  FakeEventSource.instances = [];
  const statuses = [];
  const activities = [];
  const timer = clock();
  const client = createEventClient({
    EventSourceImpl: FakeEventSource,
    onStatus: (status) => statuses.push(status),
    onActivity: (activity, revision) => activities.push({ activity, revision }),
    schedule: (fn, ms) => timer.schedule(fn, ms),
    cancel: (id) => timer.cancel(id),
  });
  const source = () => FakeEventSource.instances.at(-1);
  return { client, statuses, activities, source, clock: timer };
}

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("web/events.service — connect", () => {
  it("opens /api/v1/events and reports connecting → open", () => {
    const { client, statuses, source } = harness();
    client.connect();
    assert.deepEqual(statuses, ["connecting"]);
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(source().url, "/api/v1/events");
    source().open();
    assert.deepEqual(statuses, ["connecting", "open"]);
  });

  it("seeds the cursor from a revision and replays it as ?after=", () => {
    const { client, source } = harness();
    client.seed(41);
    assert.equal(client.cursor, 41);
    client.connect();
    assert.equal(source().url, "/api/v1/events?after=41");
  });

  it("seeding never moves the cursor backwards", () => {
    const { client } = harness();
    client.seed(41);
    client.seed(9);
    assert.equal(client.cursor, 41);
  });

  it("a second connect supersedes the first socket (no leak)", () => {
    const { client, source } = harness();
    client.connect();
    const first = source();
    client.connect();
    assert.equal(first.closed, true);
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(source().closed, false);
  });

  it("reports closed and opens no socket when the host has no EventSource", () => {
    const had = globalThis.EventSource;
    delete globalThis.EventSource;
    try {
      const statuses = [];
      const client = createEventClient({ onStatus: (s) => statuses.push(s) });
      assert.equal(FakeEventSource.instances.length, 0);
      client.connect();
      assert.deepEqual(statuses, ["closed"]);
    } finally {
      if (had !== undefined) globalThis.EventSource = had;
    }
  });
});

describe("web/events.service — cursor handling", () => {
  it("advances the cursor to the frame id and forwards the parsed activity", () => {
    const { client, activities, source } = harness();
    client.connect();
    source().emit(12, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    assert.equal(client.cursor, 12);
    assert.deepEqual(activities, [{ activity: { event: "task_updated", task_id: "td_1" }, revision: 12 }]);
  });

  it("takes the max lastEventId — the cursor never moves backwards on a replay", () => {
    const { client, activities, source } = harness();
    client.connect();
    source().emit(12, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    source().emit(7, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    assert.equal(client.cursor, 12);
    // The stale frame is still delivered (the board decides), but the cursor holds.
    assert.equal(activities[1].revision, 7);
  });

  it("ignores a non-numeric id and falls back to the cursor for the revision", () => {
    const { client, activities, source } = harness();
    client.connect();
    source().emit(5, JSON.stringify({ event: "ping" }));
    source().emit("not-a-number", JSON.stringify({ event: "ping" }));
    assert.equal(client.cursor, 5);
    assert.equal(activities[1].revision, 5);
  });

  it("swallows a malformed JSON frame (the stream must not throw)", () => {
    const { client, activities, source } = harness();
    client.connect();
    source().emit(6, "{ not json");
    assert.equal(client.cursor, 6);
    assert.deepEqual(activities, [{ activity: null, revision: 6 }]);
  });
});

describe("web/events.service — reconnect & resync", () => {
  it("onerror takes the socket down and arms our own retry, from the cursor", () => {
    const { client, statuses, source, clock } = harness();
    client.connect();
    source().open();
    source().emit(9, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    source().fail();
    assert.deepEqual(statuses, ["connecting", "open", "connecting"]);
    assert.equal(source().closed, true, "the browser's built-in retry is taken out of the loop");
    assert.equal(client.cursor, 9);
    assert.deepEqual(clock.delays, [RECONNECT_BASE_MS], "one retry is armed, at the base delay");
    assert.equal(FakeEventSource.instances.length, 1, "no socket is opened before the delay elapses");

    clock.tick();
    assert.equal(FakeEventSource.instances.length, 2);
    assert.equal(source().url, "/api/v1/events?after=9", "the cursor goes with the retry");
    assert.equal(source().closed, false);
  });

  it("doubles the delay on each failure and holds at the cap", () => {
    const { client, source, clock } = harness();
    client.connect();
    source().open();
    for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      source().fail();
      assert.equal(clock.delays.at(-1), expected, `attempt ${clock.delays.length} waits ${expected}ms`);
      clock.tick();
    }
    assert.equal(FakeEventSource.instances.length, 8, "every tick opened exactly one socket");
  });

  it("a successful open resets the ladder, so a blip costs the base delay again", () => {
    const { client, source, clock } = harness();
    client.connect();
    source().open();
    source().fail();
    clock.tick();
    source().fail();
    assert.deepEqual(clock.delays, [RECONNECT_BASE_MS, 2 * RECONNECT_BASE_MS]);

    clock.tick();
    source().open(); // back on the air
    source().fail();
    assert.equal(clock.delays.at(-1), RECONNECT_BASE_MS, "the ladder starts over after a recovery");
  });

  it("a shutdown frame is a deliberate stop: the ladder starts over", () => {
    const { client, statuses, source, clock } = harness();
    client.connect();
    source().open();
    source().emit(8, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    source().fail();
    clock.tick();
    source().fail();
    clock.tick();
    assert.equal(clock.delays.at(-1), 2 * RECONNECT_BASE_MS, "the ladder had climbed");

    const live = source();
    live.open();
    live.named(SHUTDOWN_EVENT, JSON.stringify({ reason: "server_shutdown" }));
    assert.equal(live.closed, true, "the socket is closed rather than left to the browser");
    assert.equal(clock.delays.at(-1), RECONNECT_BASE_MS, "a restart is not a failure");
    assert.deepEqual(
      statuses,
      ["connecting", "open", "connecting", "open", "connecting"],
      "a recover then a deliberate stop is still 'connecting'",
    );
    clock.tick();
    assert.equal(source().url, "/api/v1/events?after=8", "the cursor rides through the restart");
  });

  it("a superseded socket's late error does not arm a second retry", () => {
    const { client, source, clock } = harness();
    client.connect();
    const first = source();
    first.open();
    client.connect();
    const second = source();
    first.fail();
    assert.deepEqual(clock.delays, [], "the abandoned socket must not steer the ladder");
    assert.equal(second.closed, false);
    assert.equal(FakeEventSource.instances.length, 2);
  });

  it("close() cancels a waiting retry and reports closed", () => {
    const { client, statuses, source, clock } = harness();
    client.connect();
    source().open();
    source().fail();
    assert.equal(clock.waiting, 1);

    client.close();
    assert.equal(clock.waiting, 0, "no retry is left armed");
    assert.deepEqual(statuses, ["connecting", "open", "connecting", "closed"]);
    assert.equal(clock.tick(), false);
    assert.equal(FakeEventSource.instances.length, 1, "a closed client does not come back on its own");
  });

  it("resync tears down the socket and reconnects from the cursor", () => {
    const { client, statuses, source } = harness();
    client.connect();
    const first = source();
    first.open();
    first.emit(8, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    client.resync();
    assert.equal(first.closed, true);
    assert.equal(source().url, "/api/v1/events?after=8");
    assert.deepEqual(statuses, ["connecting", "open", "closed", "connecting"]);
  });

  it("resync before any frame opens a socket with no after cursor", () => {
    const { client, source } = harness();
    client.resync();
    assert.equal(source().url, "/api/v1/events");
  });

  it("close() shuts the socket and reports closed, keeping the cursor", () => {
    const { client, statuses, source } = harness();
    client.connect();
    source().emit(4, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    client.close();
    assert.equal(source().closed, true);
    assert.deepEqual(statuses, ["connecting", "closed"]);
    assert.equal(client.cursor, 4);
  });
});
