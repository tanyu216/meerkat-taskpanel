/**
 * The loop's SSE parser and client.
 *
 * The parser is pure and covers the grammar's awkward edges; the client is
 * exercised against a real HTTP server so the chunked-read path, the query
 * string, the idle timeout and the named shutdown frame are real.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, describe, it } from "node:test";

import { createSseParser } from "../../scripts/loop/sse-parse.mjs";
import { connectSse, nextBackoff } from "../../scripts/loop/sse-client.mjs";

const servers = [];

after(() => {
  for (const server of servers) server.closeAllConnections?.();
  for (const server of servers) server.close();
});

/** A one-shot HTTP server that runs `handler(req, res)`. */
async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe("loop/sse — the frame parser", () => {
  it("joins multi-line data and dispatches on a blank line", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push("data: one\ndata: two\n\n"), [
      { id: null, event: "message", data: "one\ntwo" },
    ]);
  });

  it("ignores comments and the retry hint, and names an event", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push(": ping 1\n\nretry: 3000\n\n"), []);
    assert.equal(parser.retry(), 3000);
    assert.deepEqual(parser.push("event: shutdown\ndata: {\"reason\":\"server_shutdown\"}\n\n"), [
      { id: null, event: "shutdown", data: "{\"reason\":\"server_shutdown\"}" },
    ]);
  });

  it("carries the id, including a CRLF split across chunks", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push("id: 7\r"), []);
    assert.deepEqual(parser.push("\ndata: x\r"), []);
    assert.deepEqual(parser.push("\n\r\n"), [{ id: "7", event: "message", data: "x" }]);
  });

  it("does not dispatch a blank line with no data or event", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push("\n\n: comment\n\n"), []);
  });

  it("refuses a frame past the buffer ceiling", () => {
    const parser = createSseParser({ maxBuffer: 10 });
    assert.throws(() => parser.push("x".repeat(11)), /exceeded 10 bytes/);
  });

  it("drops an incomplete trailing frame at end()", () => {
    const parser = createSseParser();
    assert.deepEqual(parser.push("data: unfinished\n"), []);
    parser.end();
    assert.deepEqual(parser.push("\n"), []);
  });
});

describe("loop/sse — the client", () => {
  it("connects with ?after and ?token, and delivers a frame", async () => {
    let seenUrl = null;
    const base = await serve((req, res) => {
      seenUrl = req.url;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("id: 12\ndata: {\"event\":\"task_created\",\"task_id\":\"t1\"}\n\n");
      res.end();
    });
    const frames = [];
    const result = await connectSse({
      url: base,
      after: 11,
      token: "td_test",
      onFrame: (frame) => frames.push(frame),
    });
    assert.equal(result.reason, "eof");
    assert.match(seenUrl, /^\/api\/v1\/events\?/);
    assert.match(seenUrl, /after=11/);
    assert.match(seenUrl, /token=td_test/);
    assert.deepEqual(frames, [
      { id: "12", event: "message", data: "{\"event\":\"task_created\",\"task_id\":\"t1\"}" },
    ]);
  });

  it("returns a named shutdown without treating it as a frame", async () => {
    const base = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: shutdown\ndata: {\"reason\":\"server_shutdown\"}\n\n");
    });
    const frames = [];
    const result = await connectSse({ url: base, onFrame: (frame) => frames.push(frame) });
    assert.equal(result.reason, "shutdown");
    assert.deepEqual(result.data, { reason: "server_shutdown" });
    assert.deepEqual(frames, [], "the shutdown frame is not an activity");
  });

  it("aborts a silent stream after the idle timeout", async () => {
    const base = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      // ...and nothing else.
    });
    const started = Date.now();
    const result = await connectSse({ url: base, idleMs: 40 });
    assert.equal(result.reason, "idle");
    assert.ok(Date.now() - started < 2_000);
  });

  it("returns `aborted` when the caller's signal fires", async () => {
    const base = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await connectSse({ url: base, signal: controller.signal, idleMs: 5_000 });
    assert.equal(result.reason, "aborted");
  });

  it("reports a non-2xx response as an error", async () => {
    const base = await serve((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
    });
    const result = await connectSse({ url: base });
    assert.equal(result.reason, "error");
    assert.match(result.error.message, /HTTP 401/);
  });
});

describe("loop/sse — the reconnect ladder", () => {
  it("goes 1s, 2s, 4s … capped at 30s", () => {
    let delay = 0;
    const ladder = [];
    for (let i = 0; i < 8; i += 1) {
      delay = nextBackoff(delay);
      ladder.push(delay);
    }
    assert.deepEqual(ladder, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
