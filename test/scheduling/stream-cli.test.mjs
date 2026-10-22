/**
 * The loop's `streamCli` seam — the only way the loop still speaks to the
 * board's live stream.
 *
 * It spawns `taskctl events tail` like any other call (same globals, token in
 * the environment) but consumes NDJSON instead of one envelope. The final case
 * runs the *real* CLI against a fake SSE server, which is the gate against the
 * producer and consumer drifting.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { streamCli } from "../../scripts/loop/runtime.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-stream-cli-"));
  dirs.push(dir);
  return dir;
}

function fakeCli(source) {
  const dir = tempDir();
  const file = join(dir, "taskctl.mjs");
  writeFileSync(file, source);
  return { file, dir };
}

function opts(cli) {
  return { cli, actorKind: "claude", envFile: null, url: null, token: "td_test" };
}

describe("loop/streamCli — argv and environment", () => {
  it("passes the CLI globals, the token in the environment, and no-autostart", async () => {
    const { file, dir } = fakeCli(`
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join("PLACEHOLDER", "record.json"))}.replace("PLACEHOLDER", process.env.RECORD_DIR), JSON.stringify({
        argv: process.argv.slice(2),
        token: process.env.TASKD_TOKEN ?? null,
        noAutostart: process.env.TASKD_NO_AUTOSTART ?? null,
      }));
      process.stdout.write('{"type":"open"}\\n');
      process.stdout.write('{"type":"eof"}\\n');
    `);
    process.env.RECORD_DIR = dir;
    try {
      const result = await streamCli(opts(file), "alice", ["events", "tail", "--idle", "1000"]);
      assert.equal(result.reason, "eof");
      const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
      assert.ok(record.argv.includes("--json"));
      assert.ok(record.argv.includes("--agent"));
      assert.equal(record.argv[record.argv.indexOf("--agent") + 1], "alice");
      assert.equal(record.argv[record.argv.indexOf("--actor-kind") + 1], "claude");
      assert.deepEqual(record.argv.slice(-4), ["events", "tail", "--idle", "1000"]);
      assert.equal(record.token, "td_test");
      assert.equal(record.noAutostart, "1");
    } finally {
      delete process.env.RECORD_DIR;
    }
  });
});

describe("loop/streamCli — the NDJSON contract", () => {
  it("reassembles lines split across chunks and maps every terminal type", async () => {
    const { file } = fakeCli(`
      const write = (text) => process.stdout.write(text);
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      await write('{"type":"op');
      await wait(5);
      await write('en"}\\n{"type":"event","id":3,"data":{"event":"task_created"}}\\n');
      await wait(5);
      await write('{"type":"shut');
      await wait(5);
      await write('down","data":{"reason":"test"}}\\n');
    `);
    const events = [];
    let opened = false;
    const result = await streamCli(opts(file), "alice", ["events", "tail"], {
      onOpen: () => {
        opened = true;
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(opened, true);
    assert.deepEqual(events, [{ id: 3, data: { event: "task_created" } }]);
    assert.equal(result.reason, "shutdown");
    assert.deepEqual(result.data, { reason: "test" });
  });

  it("maps an idle line and an error line", async () => {
    const idle = fakeCli('process.stdout.write(\'{"type":"idle","data":{"idle_ms":1}}\\n\');');
    assert.equal((await streamCli(opts(idle.file), "alice", ["events", "tail"])).reason, "idle");

    const broken = fakeCli(`
      process.stdout.write('{"type":"open"}\\n');
      process.stdout.write('{"type":"error","data":{"code":"CLI_IO","message":"boom"}}\\n');
      process.exitCode = 1;
    `);
    const result = await streamCli(opts(broken.file), "alice", ["events", "tail"]);
    assert.equal(result.reason, "error");
    assert.equal(result.error.code, "CLI_IO");
    assert.equal(result.error.message, "boom");
    assert.equal(result.exitCode, 1);
  });

  it("recovers a pre-open failure from the multi-line envelope", async () => {
    const { file } = fakeCli(`
      process.stdout.write(JSON.stringify({ ok: false, error: { code: "CLI_IO", message: "no board" } }, null, 2) + "\\n");
      process.exitCode = 1;
    `);
    const result = await streamCli(opts(file), "alice", ["events", "tail"]);
    assert.equal(result.reason, "error");
    assert.match(result.error.message, /no board/);
  });

  it("aborts the child and reports `aborted`", async () => {
    const { file } = fakeCli(`
      process.stdout.write('{"type":"open"}\\n');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await streamCli(opts(file), "alice", ["events", "tail"], {
      signal: controller.signal,
    });
    assert.equal(result.reason, "aborted");
  });
});

describe("loop/streamCli — against the real CLI", () => {
  it("consumes taskctl events tail end to end", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 7\ndata: ${JSON.stringify({ event: "task_created", task_id: "t1" })}\n\n`);
      res.write(`event: shutdown\ndata: ${JSON.stringify({ reason: "server_shutdown" })}\n\n`);
      res.end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${server.address().port}`;
    const events = [];
    let opened = false;
    try {
      const result = await streamCli(
        { ...opts(join(import.meta.dirname, "../../src/cli/index.mjs")), url },
        "alice",
        ["events", "tail", "--after", "6", "--idle", "1000"],
        {
          onOpen: () => {
            opened = true;
          },
          onEvent: (event) => events.push(event),
        },
      );
      assert.equal(opened, true);
      assert.deepEqual(events, [{ id: 7, data: { event: "task_created", task_id: "t1" } }]);
      assert.equal(result.reason, "shutdown");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
