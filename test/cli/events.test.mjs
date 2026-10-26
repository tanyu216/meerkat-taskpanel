/**
 * `events tail` — the streaming command, black-box through the CLI dispatcher.
 *
 * The point of these tests is the contract the loop binds to: NDJSON lines
 * rather than one envelope, a terminal line for every way the stream can end,
 * and a *normal* error envelope when the failure happens before the stream
 * opens.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";

import { run } from "../../src/cli/index.mjs";

const servers = [];
after(() => {
  for (const server of servers) server.closeAllConnections?.();
  for (const server of servers) server.close();
});

async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function invoke(argv, extra = {}) {
  let stdout = "";
  let stderr = "";
  const exit = await run(
    ["events", "tail", ...argv, "--actor-kind", "claude", "--agent", "tester"],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {},
      ...extra,
    },
  );
  return { exit, stdout, stderr };
}

/** Every line must be one complete JSON object. */
function lines(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

describe("taskctl events tail", () => {
  it("writes open, one event and shutdown, and quotes --after", async () => {
    let seenUrl = null;
    const { url } = await serve((req, res) => {
      seenUrl = req.url;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 12\ndata: ${JSON.stringify({ event: "task_created", task_id: "t1" })}\n\n`);
      res.write(`event: shutdown\ndata: ${JSON.stringify({ reason: "server_shutdown" })}\n\n`);
      res.end();
    });

    const { exit, stdout } = await invoke(["--url", url, "--after", "11", "--idle", "1000"]);
    assert.equal(exit, 0);
    assert.match(seenUrl, /after=11/);

    const records = lines(stdout);
    assert.deepEqual(records[0], { type: "open" });
    assert.equal(records[1].type, "event");
    assert.equal(records[1].id, 12);
    assert.equal(records[1].data.event, "task_created");
    assert.equal(records[2].type, "shutdown");
    assert.deepEqual(records[2].data, { reason: "server_shutdown" });
  });

  it("keeps a pre-open failure as the normal error envelope", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "VALIDATION_FAILED", message: "bad after", http: 400 },
        }),
      );
    });

    const { exit, stdout } = await invoke(["--url", url, "--json"]);
    assert.equal(exit, 1);
    const document = JSON.parse(stdout);
    assert.equal(document.ok, false);
    assert.equal(document.error.code, "VALIDATION_FAILED");
  });

  it("ends a broken body with an error line and exit 1", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 1\ndata: ${JSON.stringify({ event: "task_created" })}\n\n`);
      setTimeout(() => res.destroy(), 10);
    });

    const { exit, stdout } = await invoke(["--url", url, "--idle", "5000"]);
    assert.equal(exit, 1);
    const records = lines(stdout);
    assert.equal(records[0].type, "open");
    assert.equal(records[1].type, "event");
    assert.equal(records.at(-1).type, "error");
    assert.equal(records.at(-1).data.code, "CLI_IO");
  });

  it("ends a silent stream with an idle line and exit 0", async () => {
    const { url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
    });

    const { exit, stdout } = await invoke(["--url", url, "--idle", "40"]);
    assert.equal(exit, 0);
    const records = lines(stdout);
    assert.equal(records[0].type, "open");
    assert.deepEqual(records.at(-1), { type: "idle", data: { idle_ms: 40 } });
  });

  it("rejects a non-numeric or negative count as a usage error", async () => {
    const bad = await invoke(["--url", "http://127.0.0.1:1", "--after", "soon", "--json"]);
    assert.equal(bad.exit, 2);
    assert.equal(JSON.parse(bad.stdout).error.code, "CLI_USAGE");

    const negative = await invoke(["--url", "http://127.0.0.1:1", "--idle", "-1", "--json"]);
    assert.equal(negative.exit, 2);
    assert.equal(JSON.parse(negative.stdout).error.code, "CLI_USAGE");
  });
});
