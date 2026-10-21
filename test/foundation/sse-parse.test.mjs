/**
 * The Server-Sent Events frame parser.
 *
 * It is transport-free on purpose: split chunks, multi-line `data:` values and
 * `retry:` lines are proven without a socket. The streaming client that feeds
 * it is tested at the CLI layer (`test/cli/events.test.mjs`) and at the loop's
 * `streamCli` seam (`test/scheduling/stream-cli.test.mjs`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSseParser } from "../../src/foundation/sse-parse.mjs";

describe("foundation/sse-parse — the frame parser", () => {
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
