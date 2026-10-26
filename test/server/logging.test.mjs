/**
 * The server's operational log: one `request` record per call, a correlation id
 * echoed to the client, and `request_failed` only where a failure is the
 * server's (a 5xx or an unmapped throw).
 *
 * The injected logger is a plain function, the way every other server test uses
 * the seam: it receives the raw event object, so these tests assert the record,
 * not the rendered line.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { createTaskd } from "../../src/server/index.mjs";

async function start(events, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tp-srv-log-"));
  const board = await createTaskd({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    // An empty root: static hosting answers nothing, which is what the
    // non-API/debug leg below needs without depending on a web build.
    staticDir: join(dir, "no-static"),
    logger: (event) => events.push(event),
    ...options,
  });
  return board;
}

const requests = (events) => events.filter((event) => event.event === "request");

describe("server/logging — the request record", () => {
  it("records board_opened when a logger is supplied", async () => {
    const events = [];
    const board = await start(events);
    try {
      const opened = events.find((event) => event.event === "board_opened");
      assert.ok(opened, "the board announces itself once");
      assert.ok(opened.migrations_applied > 0, "a fresh board is migrated on open");
      assert.equal(opened.schema_ok, true);
    } finally {
      await board.close();
    }
  });

  it("echoes a supplied x-request-id and generates one when absent", async () => {
    const events = [];
    const board = await start(events);
    try {
      const supplied = await fetch(`${board.url}/api/v1/tasks`, {
        headers: { "x-request-id": "req-abc.123" },
      });
      assert.equal(supplied.headers.get("x-request-id"), "req-abc.123");
      const generated = await fetch(`${board.url}/api/v1/tasks`);
      const id = generated.headers.get("x-request-id");
      assert.match(id, /^[0-9a-f-]{36}$/, "a generated id is a UUID");
      assert.deepEqual(
        requests(events).map((event) => event.request_id),
        ["req-abc.123", id],
      );
    } finally {
      await board.close();
    }
  });

  it("ignores an unusable x-request-id rather than echoing it", async () => {
    const events = [];
    const board = await start(events);
    try {
      const response = await fetch(`${board.url}/api/v1/tasks`, {
        headers: { "x-request-id": "bad id with spaces" },
      });
      assert.notEqual(response.headers.get("x-request-id"), "bad id with spaces");
      assert.match(requests(events)[0].request_id, /^[0-9a-f-]{36}$/);
    } finally {
      await board.close();
    }
  });

  it("records method, path, status, duration, actor and request_id", async () => {
    const events = [];
    const board = await start(events);
    try {
      await fetch(`${board.url}/api/v1/tasks`, {
        headers: { "x-taskctl-actor": JSON.stringify({ kind: "agent", id: "linus" }) },
      });
      const [record] = requests(events);
      assert.equal(record.event, "request");
      assert.equal(record.level, "info");
      assert.equal(record.method, "GET");
      assert.equal(record.path, "/api/v1/tasks");
      assert.equal(record.status, 200);
      assert.equal(record.actor, "agent:linus");
      assert.equal(typeof record.duration_ms, "number");
      assert.ok(record.duration_ms >= 0);
      assert.ok(record.request_id);
    } finally {
      await board.close();
    }
  });

  it("keeps /health and non-API traffic at debug, API traffic at info", async () => {
    const events = [];
    const board = await start(events);
    try {
      await fetch(`${board.url}/health`);
      await fetch(`${board.url}/index.html`); // no static root → 404, still non-API
      await fetch(`${board.url}/api/v1/tasks`);
      assert.deepEqual(
        requests(events).map((event) => [event.path, event.level]),
        [
          ["/health", "debug"],
          ["/index.html", "debug"],
          ["/api/v1/tasks", "info"],
        ],
      );
    } finally {
      await board.close();
    }
  });
});

describe("server/logging — failures", () => {
  it("does not raise a 4xx refusal to error", async () => {
    const events = [];
    const board = await start(events);
    try {
      const response = await fetch(`${board.url}/api/v1/no-such-route`);
      assert.equal(response.status, 404);
      assert.equal(events.some((event) => event.event === "request_failed"), false);
      const [record] = requests(events);
      assert.equal(record.status, 404);
      assert.equal(record.level, "info", "the request line still says what happened");
    } finally {
      await board.close();
    }
  });

  it("records an unmapped failure as request_failed at error", async () => {
    const events = [];
    const board = await start(events, {
      authorize: () => {
        throw new Error("authorize exploded");
      },
    });
    try {
      const response = await fetch(`${board.url}/api/v1/tasks`);
      assert.equal(response.status, 500);
      const failed = events.find((event) => event.event === "request_failed");
      assert.ok(failed, "the failure is recorded");
      assert.equal(failed.level, "error");
      assert.equal(failed.status, 500);
      assert.equal(failed.code, "VALIDATION_FAILED");
      assert.equal(failed.method, "GET");
      assert.equal(failed.path, "/api/v1/tasks");
      assert.ok(failed.request_id, "a failure carries the request it belongs to");
      assert.doesNotMatch(failed.message, /Check constraint failed/, "no engine text on the log");
    } finally {
      await board.close();
    }
  });
});
