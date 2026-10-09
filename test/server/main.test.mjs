/**
 * Step 8: the daemon's own edges — port parsing and shutdown.
 *
 * `createShutdown` exists because the promise "SIGTERM closes the board *and*
 * removes the pointer" is what the CLI's autostart relies on, and a promise that
 * can only be observed by signalling a live process is one nobody checks.
 * Extracting it makes the interesting part — including the double-signal guard —
 * a plain function.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  boardUrl,
  createTaskd,
  labelGcIntervalMs,
  labelGcTtlDays,
  startLabelGc,
} from "../../src/server/index.mjs";
import { createShutdown, main, portFromEnv } from "../../src/server/main.mjs";
import { readRuntimePointer } from "../../src/core/index.mjs";
import {
  DEFAULT_PORT,
  LABEL_GC_INTERVAL_MS,
  LABEL_TTL_DAYS_DEFAULT,
} from "../../src/shared/constants.mjs";

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-main-"));
  tempDirs.push(dir);
  return dir;
};

describe("server/main — TASKD_PORT", () => {
  it("parses a port, and treats unset/blank as 'use the default'", () => {
    assert.equal(portFromEnv({}), undefined);
    assert.equal(portFromEnv({ TASKD_PORT: "" }), undefined);
    assert.equal(portFromEnv({ TASKD_PORT: "0" }), 0, "0 is a port (ephemeral), not 'unset'");
    assert.equal(portFromEnv({ TASKD_PORT: "8080" }), 8080);
    assert.equal(portFromEnv({ TASKD_PORT: String(DEFAULT_PORT) }), DEFAULT_PORT);
  });

  it("refuses nonsense rather than binding something arbitrary", () => {
    for (const value of ["abc", "-1", "70000", "12.5"]) {
      assert.equal(portFromEnv({ TASKD_PORT: value }), undefined, value);
    }
  });
});

describe("server/main — shutdown", () => {
  it("closes the board, removes the pointer and exits 0", async () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:1" }));

    const closed = [];
    const exits = [];
    const written = [];
    const shutdown = createShutdown({
      taskd: { close: async () => closed.push(true) },
      pointerOptions: { path: pointerPath },
      exit: (code) => exits.push(code),
      write: (text) => written.push(text),
    });

    await shutdown("SIGTERM");
    assert.deepEqual(closed, [true]);
    assert.deepEqual(exits, [0]);
    assert.equal(readRuntimePointer({ path: pointerPath }), null, "the pointer is gone");
    assert.match(written.join(""), /SIGTERM/);
  });

  it("ignores a second signal while the first is still closing", async () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:1" }));

    let closes = 0;
    const exits = [];
    const shutdown = createShutdown({
      taskd: { close: async () => { closes += 1; } },
      pointerOptions: { path: pointerPath },
      exit: (code) => exits.push(code),
      write: () => {},
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM")]);
    assert.equal(closes, 1, "the board is closed exactly once");
    assert.deepEqual(exits, [0]);
  });

  it("still removes the pointer when closing the board throws", async () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:1" }));

    const exits = [];
    const shutdown = createShutdown({
      taskd: { close: async () => { throw new Error("already gone"); } },
      pointerOptions: { path: pointerPath },
      exit: (code) => exits.push(code),
      write: () => {},
    });

    await assert.rejects(() => shutdown("SIGTERM"));
    assert.equal(readRuntimePointer({ path: pointerPath }), null, "the finally still ran");
    assert.deepEqual(exits, [0]);
  });
});

describe("server/main — the daemon, started in-process", () => {
  it("writes a pointer naming the real port, and cleans up on close", async () => {
    const dir = tempDir();
    const env = {
      TASKD_DATA_DIR: dir,
      TASKD_RUNTIME_POINTER: join(dir, "runtime.json"),
      TASKD_PORT: "0",
      TASKD_HOST: "127.0.0.1",
    };
    // `register: false` keeps this test from installing signal handlers on the
    // test runner's own process.
    const taskd = await main(env, { register: false });
    try {
      const pointer = readRuntimePointer({ path: env.TASKD_RUNTIME_POINTER });
      assert.equal(pointer.url, taskd.url);
      assert.equal(pointer.port, taskd.port);
      assert.equal(pointer.dataDir, dir);
      assert.equal(pointer.pid, process.pid, "the pointer names this process");
      assert.match(pointer.tokenFile, /token$/);

      const response = await fetch(`${taskd.url}/health`);
      assert.equal((await response.json()).data.status, "ok");
    } finally {
      await taskd.close();
    }
  });
});

describe("server/index — the label GC timer (F1-C)", () => {
  const AGENT = { kind: "agent", id: "linus" };

  it("reads the interval and TTL from env, and honours the off switch", () => {
    assert.equal(labelGcIntervalMs({}, undefined), LABEL_GC_INTERVAL_MS);
    assert.equal(labelGcIntervalMs({ TASKD_LABEL_GC: "off" }, undefined), 0);
    assert.equal(labelGcIntervalMs({}, 50), 50);
    assert.equal(labelGcIntervalMs({}, -5), 0, "a negative interval means 'no timer'");

    assert.equal(labelGcTtlDays({}, undefined), LABEL_TTL_DAYS_DEFAULT);
    assert.equal(labelGcTtlDays({ TASKD_LABEL_TTL_DAYS: "0" }, undefined), 0);
    assert.equal(labelGcTtlDays({ TASKD_LABEL_TTL_DAYS: "7" }, undefined), 7);
    assert.equal(labelGcTtlDays({ TASKD_LABEL_TTL_DAYS: "nonsense" }, undefined), LABEL_TTL_DAYS_DEFAULT);
  });

  it("sweeps once at startup, and the timer prunes a label that stops being used", async () => {
    const logs = [];
    const taskd = await createTaskd({
      dataDir: tempDir(),
      host: "127.0.0.1",
      port: 0,
      env: {},
      logger: (event) => logs.push(event),
      // Disable the periodic timer but keep the startup sweep: the interval is
      // the injected knob F1-C asks for.
      gcIntervalMs: 0,
      gcTtlDays: 0,
    });
    try {
      assert.equal(taskd.labelGc.enabled, true);
      assert.equal(taskd.labelGc.intervalMs, 0);
      assert.deepEqual(taskd.labelGc.last, { archived: [], kept: 0, mismatched: [] }, "startup sweep on an empty board");
      assert.deepEqual(logs.filter((entry) => String(entry.event).startsWith("label_gc")), [], "a sweep that collects nothing is silent");

      const { commands, repos } = taskd.board;
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws", actor: AGENT });
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Temp"], actor: AGENT });
      commands.updateTask({ id: task.id, patch: { labels: [] }, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "temp").archivedAt, null);

      const result = taskd.labelGc.run();
      assert.deepEqual(result.archived.map((label) => label.displayName), ["Temp"]);
      assert.notEqual(repos.labels.getByNorm("proj", "temp").archivedAt, null);
      const gcRow = taskd.board.db.prepare("SELECT * FROM task_activities WHERE event = 'label_gc'").get();
      assert.equal(gcRow.task_id, null);
      assert.equal(logs.filter((entry) => entry.event === "label_gc").length, 1, "a collecting sweep is logged");
    } finally {
      await taskd.close();
    }
  });

  it("fires on its own once the interval elapses", async () => {
    const taskd = await createTaskd({
      dataDir: tempDir(),
      host: "127.0.0.1",
      port: 0,
      env: { TASKD_LABEL_TTL_DAYS: "0" },
      gcIntervalMs: 25,
    });
    try {
      const { commands, repos } = taskd.board;
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws", actor: AGENT });
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Timed"], actor: AGENT });
      commands.updateTask({ id: task.id, patch: { labels: [] }, actor: AGENT });

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && repos.labels.getByNorm("proj", "timed").archivedAt === null) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.notEqual(
        repos.labels.getByNorm("proj", "timed").archivedAt,
        null,
        "the unref'd timer swept without being called",
      );
    } finally {
      await taskd.close();
    }
  });

  it("is off entirely when TASKD_LABEL_GC=off", async () => {
    const taskd = await createTaskd({
      dataDir: tempDir(),
      host: "127.0.0.1",
      port: 0,
      env: { TASKD_LABEL_GC: "off", TASKD_LABEL_TTL_DAYS: "0" },
    });
    try {
      assert.equal(taskd.labelGc.enabled, false);
      assert.equal(taskd.labelGc.intervalMs, 0);
      assert.equal(taskd.labelGc.last, null, "not even the startup sweep ran");

      const { commands, repos } = taskd.board;
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws", actor: AGENT });
      const task = commands.createTask({ projectId: "proj", title: "a", labels: ["Keep"], actor: AGENT });
      commands.updateTask({ id: task.id, patch: { labels: [] }, actor: AGENT });
      assert.equal(repos.labels.getByNorm("proj", "keep").archivedAt, null);
    } finally {
      await taskd.close();
    }
  });

  it("logs a failed sweep instead of taking the daemon down", () => {
    const logs = [];
    const gc = startLabelGc({
      board: { commands: { collectUnusedLabels: () => { throw new Error("boom"); } } },
      env: {},
      logger: (event) => logs.push(event),
      options: { gcIntervalMs: 0 },
    });
    assert.equal(gc.last.failed, true);
    assert.deepEqual(gc.last.archived, []);
    assert.equal(logs.filter((entry) => entry.event === "label_gc_failed").length, 1);
    gc.stop();
  });
});

describe("server/main — the URL a client is told to use", () => {
  it("maps a wildcard bind to loopback and brackets an IPv6 literal", () => {
    assert.equal(boardUrl("0.0.0.0", 9527), "http://127.0.0.1:9527");
    assert.equal(boardUrl("::", 9527), "http://127.0.0.1:9527");
    assert.equal(boardUrl("127.0.0.1", 0), "http://127.0.0.1:0");
    assert.equal(boardUrl("::1", 4321), "http://[::1]:4321");
    assert.equal(boardUrl("board.local", 80), "http://board.local:80");
  });
});
