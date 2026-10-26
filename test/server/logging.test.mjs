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
import { handleAttachmentContent } from "../../src/server/routes/attachments.mjs";

/** Poll until `predicate()` holds (the server writes its records asynchronously). */
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

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

describe("server/logging — background and stream lifecycles", () => {
  it("brackets an SSE stream with opened/closed records", async () => {
    const events = [];
    const board = await start(events);
    try {
      const controller = new AbortController();
      const response = await fetch(`${board.url}/api/v1/events`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      assert.equal(response.status, 200);
      assert.ok(await waitFor(() => events.some((event) => event.event === "sse_stream_opened")));

      controller.abort();
      assert.ok(await waitFor(() => events.some((event) => event.event === "sse_stream_closed")));

      const opened = events.find((event) => event.event === "sse_stream_opened");
      const closed = events.find((event) => event.event === "sse_stream_closed");
      assert.equal(opened.level, undefined, "severity comes from EVENT_LEVELS");
      assert.ok(opened.request_id);
      assert.equal(closed.request_id, opened.request_id, "the pair can be joined");
      assert.equal(typeof closed.duration_ms, "number");
    } finally {
      await board.close();
    }
  });

  it("records a token rotation without ever recording the token", async () => {
    const events = [];
    const board = await start(events);
    try {
      const response = await fetch(`${board.url}/api/v1/token`, { method: "POST" });
      assert.equal(response.status, 200);
      const rotated = events.find((event) => event.event === "token_rotated");
      assert.ok(rotated, "the credential event is recorded");
      assert.match(rotated.token_file, /token$/);
      assert.doesNotMatch(JSON.stringify(rotated), /td_[0-9a-f]{64}/);
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

  it("records a 5xx from the attachment bytes handler, which the router never sees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-srv-log-att-"));
    const events = [];
    const board = {
      dataDir: dir,
      repos: {
        attachments: {
          get() {
            throw new Error("the bytes row is unreadable");
          },
        },
      },
      ctx: { logger: (event) => events.push(event) },
    };
    const res = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status;
      },
      end() {
        this.writableEnded = true;
      },
    };

    await handleAttachmentContent(
      { method: "GET", headers: {} },
      res,
      board,
      "abc",
      { kind: "human", id: "local" },
    );

    assert.equal(res.statusCode, 500);
    const failed = events.find((event) => event.event === "request_failed");
    assert.ok(failed, "the handler's own 5xx is recorded");
    assert.equal(failed.level, "error");
    assert.equal(failed.status, 500);
    assert.equal(failed.path, "/api/v1/attachments/abc/content");
  });

  it("does not raise a 404 from the attachment handler to error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-srv-log-att-"));
    const events = [];
    const board = {
      dataDir: dir,
      repos: { attachments: { get: () => null } },
      ctx: { logger: (event) => events.push(event) },
    };
    const res = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status;
      },
      end() {
        this.writableEnded = true;
      },
    };
    await handleAttachmentContent(
      { method: "GET", headers: {} },
      res,
      board,
      "abc",
      { kind: "human", id: "local" },
    );
    assert.equal(res.statusCode, 404);
    assert.equal(events.some((event) => event.event === "request_failed"), false);
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
