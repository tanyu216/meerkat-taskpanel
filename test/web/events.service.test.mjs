/**
 * `services/events.js` — the SSE shell (F4), browser-free.
 *
 * `lib/events.test.mjs` already pins the *pure* half (cursor, targets, resync
 * query); this file pins the shell that owns the `EventSource`: the URL it
 * builds, the status it surfaces, the cursor it keeps, and the reconnect /
 * resync behaviour. `EventSource` is the external boundary, so it is injected
 * (`EventSourceImpl`) and driven by hand — the module's own logic runs for real.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createEventClient } from "../../web/src/services/events.js";

/** A hand-driven stand-in for the browser's `EventSource`. */
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeEventSource.instances.push(this);
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
}

/** Fresh fake per test, plus a recorded status trace. */
function harness() {
  FakeEventSource.instances = [];
  const statuses = [];
  const activities = [];
  const client = createEventClient({
    EventSourceImpl: FakeEventSource,
    onStatus: (status) => statuses.push(status),
    onActivity: (activity, revision) => activities.push({ activity, revision }),
  });
  const source = () => FakeEventSource.instances.at(-1);
  return { client, statuses, activities, source };
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
  it("onerror re-enters connecting without closing (Last-Event-ID goes with the retry)", () => {
    const { client, statuses, source } = harness();
    client.connect();
    source().open();
    source().emit(9, JSON.stringify({ event: "task_updated", task_id: "td_1" }));
    source().fail();
    assert.deepEqual(statuses, ["connecting", "open", "connecting"]);
    assert.equal(source().closed, false);
    assert.equal(client.cursor, 9);
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
