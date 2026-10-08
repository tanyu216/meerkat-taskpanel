/**
 * Step 9, in detail: the transport seam (`client/http.mjs`) and the runtime
 * locator (`runtime.mjs`, `client/autostart.mjs`).
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

import { createBoardClient } from "../../src/cli/client/index.mjs";
import { domainErrorFromPayload, requestJson, withQuery } from "../../src/cli/client/http.mjs";
import { probeHealth, repoRoot, serverEntry, spawnTaskd, waitForPointer } from "../../src/cli/client/autostart.mjs";
import { ensureBoard, readPointer } from "../../src/cli/runtime.mjs";
import { ERROR_CODES, isDomainError } from "../../src/shared/errors.mjs";
import { baseEnv, cleanupTempDirs, makeTempDir, startTaskd } from "./helpers/cli-harness.mjs";

const tempDirs = [];
after(() => {
  cleanupTempDirs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "taskpanel-client-"));
  tempDirs.push(dir);
  return dir;
};

describe("cli/client/http — query strings", () => {
  it("builds a query string, skipping empty values and repeating arrays", () => {
    assert.equal(withQuery("/a", undefined), "/a");
    assert.equal(withQuery("/a", { x: undefined, y: null, z: "" }), "/a");
    assert.equal(withQuery("/a", { x: 1, y: "two" }), "/a?x=1&y=two");
    assert.equal(withQuery("/a?b=1", { c: "3" }), "/a?b=1&c=3");
    assert.equal(withQuery("/a", { status: ["todo", "blocked"] }), "/a?status=todo&status=blocked");
  });
});

describe("cli/client/http — turning a payload back into a DomainError", () => {
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

describe("cli/client/http — over a real board", () => {
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
      body: { id: "c1", name: "C", workspace_path: tempDir() },
    });
    assert.equal(project.project.id, "c1");
    const task = await requestJson({
      url,
      method: "POST",
      path: "/api/v1/tasks",
      body: { project_id: "c1", title: "T" },
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
    assert.equal(commented.comment.author_id, "linus");
    assert.equal(commented.comment.agent_session, "session-1");
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

describe("cli/runtime — the pointer", () => {
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

describe("cli/client/autostart — the spawn path", () => {
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
