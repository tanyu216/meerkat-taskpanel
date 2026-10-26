/**
 * The CLI's one activity-stream adapter.
 *
 * `events tail` and `export watch` are covered end-to-end elsewhere; these
 * cases pin the frame rules they now share — the cursor fallback, the named
 * shutdown frame, and what a malformed payload does.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { activityFrames, streamFailure } from "../../src/cli/activity-stream.mjs";

async function* chunks(...parts) {
  for (const part of parts) yield part;
}

async function collect(parts) {
  const out = [];
  for await (const frame of activityFrames(chunks(...parts))) out.push(frame);
  return out;
}

/** One SSE frame; `id === null` omits the `id:` line. */
function frame(id, data) {
  return `${id === null ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
}

describe("cli/activity-stream — the shared frame rules", () => {
  it("passes the frame id through and derives the revision from it", async () => {
    const [only] = await collect([frame(7, { event: "task_created", task_id: "t" })]);
    assert.deepEqual(only, {
      type: "frame",
      id: 7,
      revision: 7,
      data: { event: "task_created", task_id: "t" },
    });
  });

  it("falls back to data.revision when the frame has no id", async () => {
    const [only] = await collect([frame(null, { event: "task_created", revision: 9 })]);
    assert.equal(only.id, null);
    assert.equal(only.revision, 9);
  });

  it("skips a frame that is not JSON and keeps reading", async () => {
    const out = await collect(["data: not json\n\n", frame(3, { event: "task_moved" })]);
    assert.deepEqual(out.map((entry) => entry.type), ["frame", "eof"]);
    assert.equal(out[0].id, 3);
  });

  it("stops at the named shutdown frame", async () => {
    const out = await collect([
      'event: shutdown\ndata: {"reason":"server_shutdown"}\n\n',
      frame(4, { event: "task_moved" }),
    ]);
    assert.deepEqual(out, [{ type: "shutdown", data: { reason: "server_shutdown" } }]);
  });

  it("tolerates a malformed shutdown payload", async () => {
    const [only] = await collect(["event: shutdown\ndata: oops\n\n"]);
    assert.deepEqual(only, { type: "shutdown", data: null });
  });

  it("ends with eof when the transport ends", async () => {
    const out = await collect([frame(1, { event: "task_created" })]);
    assert.deepEqual(out.map((entry) => entry.type), ["frame", "eof"]);
  });

  it("classifies a stream failure by the transport's own reason", () => {
    assert.equal(streamFailure({ details: { reason: "aborted" } }), "aborted");
    assert.equal(streamFailure({ details: { reason: "idle" } }), "idle");
    assert.equal(streamFailure({ details: { reason: "http" } }), "error");
    assert.equal(streamFailure(null), "error");
  });
});
