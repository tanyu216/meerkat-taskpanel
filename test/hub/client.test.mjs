/**
 * The hub client seam: the line generator, the one-answer call, and the error
 * mapping the CLI renders.
 *
 * The server here is a hand-written socket, so each failure is injected exactly
 * where the real hub could produce it.
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, describe, it } from "node:test";

import { hubAnswer, hubError, hubRecords } from "../../src/cli/hub/client.mjs";

const servers = [];

async function listen(onData) {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onData(socket, JSON.parse(line));
      }
    });
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: server.address().port };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

describe("hub client", () => {
  it("maps a hub error payload onto the domain error", () => {
    const err = hubError({
      code: "CLI_USAGE",
      message: "bad ref",
      details: { ref: "X" },
      hint: { fix: "check it" },
    });
    assert.equal(err.code, "CLI_USAGE");
    assert.equal(err.message, "bad ref");
    assert.deepEqual(err.details, { ref: "X" });
    assert.deepEqual(err.hint, { fix: "check it" });

    const fallback = hubError(null);
    assert.equal(fallback.code, "CLI_IO");
    assert.match(fallback.message, /reported an error/);
  });

  it("refuses a pointer without a port or token before connecting", async () => {
    await assert.rejects(() => hubRecords({}, {}).next(), (err) => err.code === "CLI_IO");
    await assert.rejects(() => hubRecords({ port: 1 }, {}).next(), (err) => err.code === "CLI_IO");
  });

  it("reports a refused hello", async () => {
    const { port } = await listen((socket) => {
      socket.write('{"op":"hello","ok":false,"error":"unauthorized"}\n');
    });
    await assert.rejects(
      () => hubRecords({ port, token: "t" }, { op: "ping" }).next(),
      (err) => err.code === "CLI_IO",
    );
  });

  it("reports a malformed hub line", async () => {
    let seen = 0;
    const { port } = await listen((socket) => {
      seen += 1;
      socket.write(seen === 1 ? '{"op":"hello","ok":true}\n' : "not-json\n");
    });
    await assert.rejects(
      () => hubRecords({ port, token: "t" }, { op: "ping" }).next(),
      (err) => err.code === "CLI_IO",
    );
  });

  it("answers with a one-answer helper and surfaces an error record", async () => {
    let seen = 0;
    const { port } = await listen((socket) => {
      seen += 1;
      if (seen === 1) socket.write('{"op":"hello","ok":true}\n');
      else socket.write('{"op":"watch-status","ok":true,"running":false}\n');
    });
    const answer = await hubAnswer(
      { port, token: "t" },
      { op: "watch-status" },
      (record) => record.op === "watch-status",
    );
    assert.equal(answer.running, false);

    let call = 0;
    const { port: errorPort } = await listen((socket) => {
      call += 1;
      if (call === 1) socket.write('{"op":"hello","ok":true}\n');
      else socket.write('{"type":"error","data":{"code":"CLI_USAGE","message":"no"}}\n');
    });
    await assert.rejects(
      () => hubAnswer({ port: errorPort, token: "t" }, { op: "watch-status" }, () => true),
      (err) => err.code === "CLI_USAGE",
    );
  });

  it("skips heartbeats while waiting for an answer", async () => {
    let seen = 0;
    const { port } = await listen((socket) => {
      seen += 1;
      if (seen === 1) socket.write('{"op":"hello","ok":true}\n');
      else {
        socket.write('{"type":"heartbeat"}\n');
        socket.write('{"op":"watch-status","ok":true,"running":true}\n');
      }
    });
    const answer = await hubAnswer(
      { port, token: "t" },
      { op: "watch-status" },
      (record) => record.op === "watch-status",
    );
    assert.equal(answer.running, true);
  });

  it("surfaces an op-level error and a premature close", async () => {
    let call = 0;
    const { port } = await listen((socket) => {
      call += 1;
      if (call === 1) socket.write('{"op":"hello","ok":true}\n');
      else socket.write('{"op":"error","ok":false,"error":{"code":"CLI_USAGE","message":"unknown"}}\n');
    });
    await assert.rejects(
      () => hubAnswer({ port, token: "t" }, { op: "nope" }, () => true),
      (err) => err.code === "CLI_USAGE",
    );

    let closed = 0;
    const { port: closePort } = await listen((socket) => {
      closed += 1;
      if (closed === 1) socket.write('{"op":"hello","ok":true}\n');
      else socket.end();
    });
    await assert.rejects(
      () => hubAnswer({ port: closePort, token: "t" }, { op: "watch-status" }, () => true),
      (err) => err.code === "CLI_IO",
    );
  });

  it("ends a silent stream at the caller's idle bound", async () => {
    let seen = 0;
    const { port } = await listen((socket) => {
      seen += 1;
      if (seen === 1) socket.write('{"op":"hello","ok":true}\n');
    });
    await assert.rejects(
      async () => {
        for await (const _record of hubRecords({ port, token: "t" }, { op: "follow" }, { idleMs: 50 })) {
          /* the hub sends nothing */
        }
      },
      (err) => err?.details?.reason === "idle",
    );
  });

  it("reports a connection failure as a domain error", async () => {
    const { server, port } = await listen(() => {});
    await new Promise((done) => server.close(done));
    await assert.rejects(
      () => hubRecords({ port, token: "t" }, { op: "ping" }).next(),
      (err) => err.code === "CLI_IO",
    );
  });
});
