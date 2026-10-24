/**
 * A fake board for the hub suites: a mutable card set, an export endpoint and a
 * held-open SSE stream. `emit` writes an SSE frame to every connected stream —
 * in a correct deployment the hub is the only client.
 */

import { createServer } from "node:http";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      try {
        done(JSON.parse(text === "" ? "{}" : text));
      } catch (err) {
        fail(err);
      }
    });
    req.on("error", fail);
  });
}

/**
 * A board with a mutable card set and a held-open event stream. `emit` writes
 * an SSE frame to every connected hub; the hub is the only client that should
 * ever be connected.
 */
export async function fakeBoard() {
  const cards = new Map();
  const streams = new Set();
  const state = { connections: 0, revision: 0 };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/meta") {
        sendJson(res, 200, { ok: true, data: { revision: state.revision } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/export") {
        const body = await readBody(req);
        const card = cards.get(body.ref);
        if (card === undefined) {
          sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "no card", http: 404 } });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            cards: [
              {
                identifier: card.identifier,
                task_id: card.task_id,
                status: card.status,
                markdown: card.markdown,
              },
            ],
          },
        });
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/v1/events")) {
        state.connections += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders?.();
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "no route", http: 404 } });
    })().catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: "CLI_IO", message: String(err) } });
      else res.destroy();
    });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    add(identifier, taskId, markdown, status = "todo") {
      const card = { identifier, task_id: taskId, markdown, status };
      cards.set(identifier, card);
      cards.set(taskId, card);
    },
    update(identifier, patch) {
      const card = cards.get(identifier);
      if (card === undefined) throw new Error(`no such card: ${identifier}`);
      if (patch.markdown !== undefined) card.markdown = patch.markdown;
      if (patch.status !== undefined) card.status = patch.status;
    },
    emit(taskId, event = "comment_added") {
      state.revision += 1;
      const frame = `id: ${state.revision}\ndata: ${JSON.stringify({ event, task_id: taskId, changes: { fields: ["body"] } })}\n\n`;
      for (const res of streams) {
        try {
          res.write(frame);
        } catch {
          /* the hub connection is going away */
        }
      }
    },
    connections() {
      return state.connections;
    },
    /** Drop every open SSE response, simulating a board stream restart. */
    dropStreams() {
      for (const res of streams) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      streams.clear();
    },
    async close() {
      for (const res of streams) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

