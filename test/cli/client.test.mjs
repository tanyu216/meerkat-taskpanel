/**
 * Step 9, in detail: the transport seam (`shared/transport/http.mjs`) and the
 * runtime locator (`shared/transport/runtime.mjs`, `shared/transport/autostart.mjs`).
 *
 * These are the modules whose *unhappy* paths matter most — a board that is
 * unreachable, an envelope that is malformed, a pointer left behind by a dead
 * process — and the ones a black-box CLI test cannot reach without a lot of
 * contrivance. So they are driven directly, against a live board where a live
 * board is needed and against fakes where the failure is the point.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, describe, it } from "node:test";

import { createBoardClient } from "../../src/foundation/transport/client.mjs";
import {
  domainErrorFromPayload,
  requestBytes,
  requestJson,
  requestStream,
  withQuery,
} from "../../src/foundation/transport/http.mjs";
import { probeHealth, repoRoot, serverEntry, spawnTaskd, waitForPointer } from "../../src/foundation/transport/autostart.mjs";
import { ensureBoard, readPointer } from "../../src/foundation/transport/runtime.mjs";
import { ERROR_CODES, isDomainError } from "../../src/foundation/errors.mjs";
import { baseEnv, cleanupTempDirs, makeTempDir, startTaskd } from "./helpers/cli-harness.mjs";

const tempDirs = [];
after(() => {
  cleanupTempDirs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-client-"));
  tempDirs.push(dir);
  return dir;
};

describe("shared/transport/http — query strings", () => {
  it("builds a query string, skipping empty values and repeating arrays", () => {
    assert.equal(withQuery("/a", undefined), "/a");
    assert.equal(withQuery("/a", { x: undefined, y: null, z: "" }), "/a");
    assert.equal(withQuery("/a", { x: 1, y: "two" }), "/a?x=1&y=two");
    assert.equal(withQuery("/a?b=1", { c: "3" }), "/a?b=1&c=3");
    assert.equal(withQuery("/a", { status: ["todo", "blocked"] }), "/a?status=todo&status=blocked");
  });
});

describe("shared/transport/http — the event stream", () => {
  /** A one-shot HTTP server; the caller closes it through `closeAllConnections`. */
  async function serve(handler) {
    const server = createServer(handler);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  }

  it("carries the same token, actor and session headers as a JSON call", async () => {
    let seen = null;
    const { server, url } = await serve((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {}\n\n");
    });
    try {
      const stream = await requestStream({
        url,
        path: "/api/v1/events",
        token: "td_secret",
        actor: { kind: "claude", id: "jobs" },
        session: "sid-1",
        seg: "seg-2",
      });
      for await (const _chunk of stream) { /* drain */ }
      assert.equal(seen.accept, "text/event-stream");
      assert.equal(seen.authorization, "Bearer td_secret");
      assert.equal(seen["x-taskctl-actor"], JSON.stringify({ kind: "claude", id: "jobs" }));
      assert.equal(seen["x-taskctl-session"], "sid-1");
      assert.equal(seen["x-taskctl-seg"], "seg-2");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("yields chunks as they arrive", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("id: 1\ndata: {\"event\":\"a\"}\n\n");
      setTimeout(() => res.end("id: 2\ndata: {\"event\":\"b\"}\n\n"), 10);
    });
    try {
      const stream = await requestStream({ url, path: "/api/v1/events" });
      let text = "";
      for await (const chunk of stream) text += chunk;
      assert.match(text, /"event":"a"/);
      assert.match(text, /"event":"b"/);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("rebuilds a non-2xx JSON envelope as the board's DomainError", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "VALIDATION_FAILED", message: "bad after", http: 400 } }));
    });
    try {
      await assert.rejects(
        () => requestStream({ url, path: "/api/v1/events" }),
        (err) => err.code === "VALIDATION_FAILED" && err.http === 400,
      );
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("refuses a response that is not an event stream", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      await assert.rejects(
        () => requestStream({ url, path: "/api/v1/events" }),
        (err) => err.code === "CLI_IO" && err.details.reason === "content-type",
      );
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("aborts a silent body and tags it `idle`", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
    });
    try {
      const stream = await requestStream({ url, path: "/api/v1/events", idleMs: 40 });
      await assert.rejects(
        async () => {
          for await (const _chunk of stream) { /* drain */ }
        },
        (err) => err.code === "CLI_IO" && err.details.reason === "idle",
      );
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("resets the idle timer on every chunk (no overall body deadline)", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        if (n > 6) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`data: ${n}\n\n`);
      }, 20);
    });
    try {
      const stream = await requestStream({ url, path: "/api/v1/events", idleMs: 60 });
      let chunks = 0;
      for await (const _chunk of stream) chunks += 1;
      assert.ok(chunks > 0, "the stream should deliver chunks past the first idle window");
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("tags a caller abort as `aborted`", async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
    });
    const controller = new AbortController();
    try {
      // Abort *after* the headers are up: the body phase is the interesting one.
      // A timer racing the connect turns this into a header-phase abort on a slow
      // machine, which is a different (and already deterministic) path.
      const stream = await requestStream({
        url,
        path: "/api/v1/events",
        signal: controller.signal,
        idleMs: 5_000,
      });
      controller.abort();
      await assert.rejects(
        async () => {
          for await (const _chunk of stream) { /* drain */ }
        },
        (err) => err.code === "CLI_IO" && err.details.reason === "aborted",
      );
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("refuses a signal that was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => requestStream({ url: "http://127.0.0.1:1", path: "/api/v1/events", signal: controller.signal }),
      (err) => err.code === "CLI_IO" && err.details.reason === "aborted",
    );
  });
});

describe("shared/transport/http — turning a payload back into a DomainError", () => {
  it("preserves a known code, its details, hint and the server's status", () => {
    const err = domainErrorFromPayload({
      code: "REPORT_REQUIRED",
      message: "no report for round 2",
      http: 422,
      details: { round: 2 },
      hint: { command: "taskctl issue deliver X --report-file -" },
    });
    assert.equal(isDomainError(err), true);
    assert.equal(err.code, "REPORT_REQUIRED");
    assert.equal(err.http, 422);
    assert.deepEqual(err.details, { round: 2 });
    assert.match(err.hint.command, /issue deliver/);
  });

  it("keeps a code this client does not know, rather than flattening it", () => {
    const err = domainErrorFromPayload({ code: "SOMETHING_NEW", message: "from the future", http: 418 });
    assert.equal(err.code, "SOMETHING_NEW");
    assert.equal(err.http, 418);
    assert.equal(err.message, "from the future");
    assert.equal(isDomainError(err), false, "not ours, but still addressable by code");
  });

  it("copes with a payload that is not even error-shaped", () => {
    const err = domainErrorFromPayload(null);
    assert.equal(err.code, "CLI_IO");
    assert.equal(err.http, 500);
    assert.equal(domainErrorFromPayload({ code: 42 }).code, "CLI_IO");
  });
});

describe("shared/transport/http — over a real board", () => {
  let taskd;
  let url;
  before(async () => {
    taskd = await startTaskd();
    url = taskd.url;
  });
  after(async () => {
    if (taskd) await taskd.close();
  });

  it("returns the data half of a success envelope", async () => {
    const data = await requestJson({ url, path: "/health" });
    assert.equal(data.status, "ok");
  });

  it("throws the domain error a refusal carried", async () => {
    await assert.rejects(
      () => requestJson({ url, path: "/api/v1/tasks/NOPE-0001" }),
      (err) => {
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.http, 404);
        return true;
      },
    );
  });

  it("carries the actor, session and segment as headers", async () => {
    // The server reads them; the easiest way to observe them is to write a
    // comment and read the author back.
    const project = await requestJson({
      url,
      method: "POST",
      path: "/api/v1/projects",
      body: { id: "c1", name: "C" },
    });
    assert.equal(project.project.id, "c1");
    const task = await requestJson({
      url,
      method: "POST",
      path: "/api/v1/tasks",
      // 0031 — an agent creating a card in an `optional` project states the
      // review decision; this test is about headers, so it says "no review".
      body: { project_id: "c1", title: "T", review_required: false },
      actor: { kind: "agent", id: "linus" },
    });
    const commented = await requestJson({
      url,
      method: "POST",
      path: `/api/v1/tasks/${task.task.identifier}/comments`,
      body: { body: "hi" },
      actor: { kind: "agent", id: "linus" },
      session: "session-1",
      seg: "seg-2",
    });
    // author_id is an actor id since 0020; the wire's ref carries the name.
    assert.equal(commented.comment.author.display_name, "linus");
    assert.equal(commented.comment.agent_session, "session-1");
  });

  it("returns attachment bytes verbatim and rebuilds the envelope on failure", async () => {
    const project = await requestJson({
      url,
      method: "POST",
      path: "/api/v1/projects",
      body: { id: "bytes", name: "Bytes" },
    });
    assert.equal(project.project.id, "bytes");
    const task = await requestJson({
      url,
      method: "POST",
      path: "/api/v1/tasks",
      body: { project_id: "bytes", title: "Bytes", review_required: false },
    });
    const bytes = new TextEncoder().encode("hello\n");
    const created = await requestJson({
      url,
      method: "POST",
      path: `/api/v1/tasks/${task.task.identifier}/attachments`,
      body: { filename: "hello.txt", content_type: "text/plain", size: bytes.length },
    });
    const id = created.attachment.id;
    await requestJson({
      url,
      method: "PUT",
      path: `/api/v1/attachments/${id}/content`,
      rawBody: bytes,
      contentType: "text/plain",
    });

    const downloaded = await requestBytes({ url, path: `/api/v1/attachments/${id}/content` });
    assert.equal(Buffer.from(downloaded.bytes).toString("utf8"), "hello\n");
    assert.match(downloaded.contentType, /^text\/plain/);

    await assert.rejects(
      () => requestBytes({ url, path: "/api/v1/attachments/nope/content" }),
      (err) => {
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  });

  it("reports a connection that never happens as CLI_IO", async () => {
    const { closedPortUrl } = await import("./helpers/cli-harness.mjs");
    const dead = await closedPortUrl();
    await assert.rejects(
      () => requestJson({ url: dead, path: "/health" }),
      (err) => {
        assert.equal(err.code, "CLI_IO");
        assert.match(err.message, /cannot reach the board/);
        assert.match(err.hint.fix, /--url/);
        return true;
      },
    );
  });

  it("reports a timeout as CLI_IO instead of hanging", async () => {
    // A server that accepts and then says nothing, forever.
    const silent = createServer(() => {});
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = silent.address().port;
    try {
      await assert.rejects(
        () => requestJson({ url: `http://127.0.0.1:${port}`, path: "/health", timeoutMs: 100 }),
        (err) => {
          assert.equal(err.code, "CLI_IO");
          assert.match(err.message, /did not answer within 100ms/);
          return true;
        },
      );
    } finally {
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("refuses an answer that is not JSON, and one with no envelope", async () => {
    const weird = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>hello</html>");
    });
    await new Promise((resolve) => weird.listen(0, "127.0.0.1", resolve));
    const port = weird.address().port;
    try {
      await assert.rejects(
        () => requestJson({ url: `http://127.0.0.1:${port}`, path: "/x" }),
        (err) => err.code === "CLI_IO" && /not JSON/.test(err.message),
      );
    } finally {
      await new Promise((resolve) => weird.close(resolve));
    }

    const bare = createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "boom" }));
    });
    await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const barePort = bare.address().port;
    try {
      await assert.rejects(
        () => requestJson({ url: `http://127.0.0.1:${barePort}`, path: "/x" }),
        (err) => err.code === "CLI_IO" && /HTTP 500/.test(err.message),
      );
    } finally {
      await new Promise((resolve) => bare.close(resolve));
    }

    const wrongEnvelope = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: 1 }));
    });
    await new Promise((resolve) => wrongEnvelope.listen(0, "127.0.0.1", resolve));
    const wrongPort = wrongEnvelope.address().port;
    try {
      await assert.rejects(
        () => requestJson({ url: `http://127.0.0.1:${wrongPort}`, path: "/x" }),
        (err) => err.code === "CLI_IO" && /envelope this client does not understand/.test(err.message),
      );
    } finally {
      await new Promise((resolve) => wrongEnvelope.close(resolve));
    }
  });

  it("exposes the same seam through the board client", async () => {
    const client = createBoardClient({ url, actor: { kind: "agent", id: "linus" } });
    assert.equal((await client.get("/health")).status, "ok");
    await assert.rejects(() => client.get("/api/v1/tasks/NOPE-0001"), (err) => err.code === "NOT_FOUND");
    await assert.rejects(
      () => client.post("/api/v1/tasks", { project_id: "c1", title: "" }),
      (err) => err.code === "VALIDATION_FAILED",
    );
    assert.ok(Object.keys(ERROR_CODES).includes("CLI_IO"));
  });
});

describe("shared/transport/runtime — the pointer", () => {
  it("reads a pointer, and treats missing or junk as none", () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    assert.equal(readPointer({ env: {}, path }), null);

    writeFileSync(path, "{not json");
    assert.equal(readPointer({ env: {}, path }), null);

    writeFileSync(path, JSON.stringify(["not", "an", "object"]));
    assert.equal(readPointer({ env: {}, path }), null);

    writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:1", port: 1 }));
    assert.deepEqual(readPointer({ env: {}, path }), { url: "http://127.0.0.1:1", port: 1, path });
  });

  it("falls back to the per-user pointer path when none is given", () => {
    const env = { TASKD_RUNTIME_POINTER: join(tempDir(), "p.json") };
    assert.equal(readPointer({ env }), null, "nothing there yet, and no throw");
  });

  it("probes health honestly: a dead address is false, a live one is true", async () => {
    assert.equal(await probeHealth("http://127.0.0.1:1", { timeoutMs: 100 }), false);
    const taskd = await startTaskd();
    try {
      assert.equal(await probeHealth(taskd.url), true);
      assert.equal(await probeHealth(`${taskd.url}/`), true, "a trailing slash is tolerated");
    } finally {
      await taskd.close();
    }
  });

  it("uses an explicit --url and never spawns anything", async () => {
    const resolved = await ensureBoard({ url: "http://127.0.0.1:12345/", env: {} });
    assert.deepEqual(resolved, { url: "http://127.0.0.1:12345", autostarted: false, pointer: null });
  });

  it("believes a pointer only after /health answers", async () => {
    // A live board, and a *different* pointer file — so the stale address below
    // is judged on its own merits, not mixed up with the real board's pointer.
    const taskd = await startTaskd();
    const path = join(tempDir(), "runtime.json");
    try {
      writeFileSync(path, JSON.stringify({ url: "http://127.0.0.1:1", port: 1, pid: 999999 }));
      // Dead address + no autostart ⇒ a clear refusal rather than a hang.
      await assert.rejects(
        () => ensureBoard({ env: { TASKD_NO_AUTOSTART: "1" }, pointerPath: path }),
        (err) => {
          assert.equal(err.code, "CLI_IO");
          assert.match(err.message, /not answering/);
          assert.match(err.hint.fix, /TASKD_NO_AUTOSTART/);
          // M3fix D3: this payload is surfaced to callers — the pointer's host
          // path stays out of it, in every field.
          assert.equal(err.message.includes(path), false, "the message must not name the pointer's host path");
          assert.equal(JSON.stringify(err.details).includes(path), false, "details must not name it either");
          assert.equal(JSON.stringify(err.hint).includes(path), false);
          return true;
        },
      );

      // Alive address ⇒ used, not started.
      writeFileSync(path, JSON.stringify({ url: taskd.url, port: taskd.port, pid: taskd.pid }));
      const resolved = await ensureBoard({ env: {}, pointerPath: path });
      assert.equal(resolved.url, taskd.url);
      assert.equal(resolved.autostarted, false);
      assert.equal(resolved.pointer.pid, taskd.pid);
    } finally {
      await taskd.close();
    }
  });

  it("refuses to autostart with a clear hint when the pointer names nothing live", async () => {
    const dir = tempDir();
    await assert.rejects(
      () => ensureBoard({ env: { TASKD_NO_AUTOSTART: "true" }, pointerPath: join(dir, "missing.json") }),
      (err) => {
        assert.equal(err.details.noAutostart, true);
        assert.equal(err.details.pointer, null);
        assert.match(err.message, /no board is running/);
        return true;
      },
    );
  });
});

describe("shared/transport/autostart — the spawn path", () => {
  it("knows where the daemon program is", () => {
    // The repository is `/app` inside the verification image, so the root is not
    // assumed to have any particular name.
    assert.equal(repoRoot(), resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
    assert.equal(serverEntry(), join(repoRoot(), "src", "server", "main.mjs"));
  });

  it("reports a spawn that cannot happen instead of throwing raw", async () => {
    const dir = tempDir();
    await assert.rejects(
      () =>
        spawnTaskd({
          env: { ...baseEnv(), TASKD_DATA_DIR: dir },
          pointerPath: join(dir, "runtime.json"),
          spawnFn: () => {
            throw new Error("spawn EACCES");
          },
        }),
      (err) => {
        assert.equal(err.code, "CLI_IO");
        assert.match(err.message, /could not start taskd/);
        assert.match(err.hint.fix, /src\/server\/main\.mjs/);
        return true;
      },
    );
  });

  it("gives up with the log path when the daemon never writes a pointer", async () => {
    const dir = tempDir();
    await assert.rejects(
      () =>
        spawnTaskd({
          env: { ...baseEnv(), TASKD_DATA_DIR: dir },
          pointerPath: join(dir, "runtime.json"),
          waitMs: 80,
          // A "process" that starts and does nothing.
          spawnFn: () => ({ pid: 4242, unref() {} }),
        }),
      (err) => {
        assert.equal(err.code, "CLI_IO");
        assert.match(err.message, /never answered \/health/);
        assert.match(err.details.logFile, /logs\/taskd\.log$/);
        assert.match(err.hint.fix, /read /);
        return true;
      },
    );
  });

  it("waits for a pointer with a matching pid, and tolerates junk on the way", async () => {
    const dir = tempDir();
    const path = join(dir, "runtime.json");
    writeFileSync(path, "garbage");

    let ticks = 0;
    const pointer = await waitForPointer({
      pointerPath: path,
      timeoutMs: 1_000,
      pollMs: 1,
      pid: 7,
      readFile: (file) => {
        ticks += 1;
        if (ticks === 1) return "still not json";
        return JSON.stringify({ url: "http://127.0.0.1:9", pid: 7 });
      },
      sleep: async () => {},
    });
    assert.equal(pointer.pid, 7);
    assert.equal(pointer.url, "http://127.0.0.1:9");
  });
});
