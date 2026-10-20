/**
 * The loop's event subscriber: what it dispatches, how it coalesces, where it
 * connects, and that a refused turn is retried rather than dropped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { resolveEventEndpoint } from "../../scripts/loop/endpoint.mjs";
import { advanceCursor, classify } from "../../scripts/loop/event-rules.mjs";
import { createDispatchScheduler, runSubscribe } from "../../scripts/loop/subscribe.mjs";

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-subscribe-"));
  tempDirs.push(dir);
  return dir;
}

const activity = (event, overrides = {}) => ({
  event,
  actor_kind: "claude",
  actor_id: "linus",
  changes: {},
  ...overrides,
});

/** A manual clock and timer queue, so the coalescer is deterministic. */
function fakeClock() {
  let now = 0;
  let nextHandle = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const handle = ++nextHandle;
      timers.set(handle, { at: now + Math.max(0, ms), fn });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("loop/subscribe — event rules", () => {
  it("dispatches the events that can create or complete work", () => {
    for (const event of [
      "task_created",
      "task_moved",
      "task_delivered",
      "report_written",
      "report_waived",
      "epic_auto_start",
      "relation_added",
      "relation_removed",
      "import_completed",
    ]) {
      assert.equal(classify(activity(event, { actor_kind: "human", actor_id: "terry" }), { agents: ["linus"] }), "dispatch", event);
    }
  });

  it("ignores the events that cannot change candidacy", () => {
    for (const event of [
      "comment_added",
      "session_registered",
      "session_closed",
      "progress",
      "label_gc",
      "project_created",
      "project_updated",
      "attachment_added",
      "attachment_updated",
      "attachment_removed",
      "task_claimed",
      "task_archived",
      "task_heartbeat",
    ]) {
      assert.equal(classify(activity(event, { actor_kind: "human", actor_id: "terry" }), { agents: ["linus"] }), "ignore", event);
    }
  });

  it("dispatches task_updated only for candidacy-affecting fields", () => {
    const update = (fields) => activity("task_updated", { changes: { fields }, actor_kind: "human", actor_id: "terry" });
    assert.equal(classify(update(["assigneeId", "assigneeKind"]), { agents: [] }), "dispatch");
    assert.equal(classify(update(["kind"]), { agents: [] }), "dispatch");
    assert.equal(classify(update(["labels"]), { agents: [] }), "dispatch");
    assert.equal(classify(update(["meta"]), { agents: [] }), "dispatch");
    assert.equal(classify(update(["title", "description"]), { agents: [] }), "ignore");
    assert.equal(classify(update(["priority"]), { agents: [] }), "ignore");
  });

  it("suppresses the board's own housekeeping and this loop's agents", () => {
    const ctx = { agents: ["linus"] };
    assert.equal(classify(activity("task_created", { actor_kind: "taskd", actor_id: "taskd" }), ctx), "ignore");
    assert.equal(classify(activity("task_moved", { actor_kind: "taskd", actor_id: "linus" }), ctx), "ignore");
    // The importer is the board's platform under a component id: it must pass.
    assert.equal(classify(activity("import_completed", { actor_kind: "taskd", actor_id: "md-import" }), ctx), "dispatch");
    // A human whose id happens to match an agent is still a human.
    assert.equal(classify(activity("task_created", { actor_kind: "human", actor_id: "linus" }), ctx), "dispatch");
    // Legacy rows used kind `system`; the same ids still classify correctly.
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "taskd" }), ctx), "ignore");
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "linus" }), ctx), "ignore");
  });

  it("advances the cursor monotonically", () => {
    assert.equal(advanceCursor(null, { id: "5" }), 5);
    assert.equal(advanceCursor(5, { id: "3" }), 5);
    assert.equal(advanceCursor(5, { id: "9" }), 9);
    assert.equal(advanceCursor(5, { id: null }), 5);
    assert.equal(advanceCursor(5, { id: "nope" }), 5);
  });
});

describe("loop/subscribe — coalescing", () => {
  it("debounces a burst into one run", async () => {
    const clock = fakeClock();
    let runs = 0;
    const scheduler = createDispatchScheduler({
      run: async () => { runs += 1; },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      debounceMs: 300,
      maxWaitMs: 2_000,
      minIntervalMs: 0,
    });
    scheduler.notify();
    clock.advance(299);
    await flush();
    assert.equal(runs, 0, "nothing before the debounce window");
    clock.advance(1);
    await flush();
    assert.equal(runs, 1);
  });

  it("never holds the first pending event past the max wait", async () => {
    const clock = fakeClock();
    let runs = 0;
    const scheduler = createDispatchScheduler({
      run: async () => { runs += 1; },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      debounceMs: 300,
      maxWaitMs: 500,
      minIntervalMs: 0,
    });
    scheduler.notify(); // at 0
    clock.advance(200);
    scheduler.notify(); // at 200: debounce would be 500
    clock.advance(200);
    scheduler.notify(); // at 400: the max wait leaves only 100ms
    clock.advance(100); // at 500 the first pending event must fire
    await flush();
    assert.equal(runs, 1, "the first event was not starved by later ones");
    clock.advance(1_000);
    await flush();
    assert.equal(runs, 1, "no further notification was pending");
  });

  it("honours the minimum interval between turns", async () => {
    const clock = fakeClock();
    let runs = 0;
    const scheduler = createDispatchScheduler({
      run: async () => { runs += 1; },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      debounceMs: 10,
      maxWaitMs: 10,
      minIntervalMs: 1_000,
    });
    scheduler.notify();
    clock.advance(10);
    await flush();
    assert.equal(runs, 1);

    scheduler.notify();
    clock.advance(10);
    await flush();
    assert.equal(runs, 1, "the second event waits out the interval");
    clock.advance(1_000);
    await flush();
    assert.equal(runs, 2);
  });

  it("retries a turn the continue lock refused", async () => {
    const clock = fakeClock();
    let runs = 0;
    const scheduler = createDispatchScheduler({
      run: async ({ onSkip }) => {
        runs += 1;
        if (runs === 1) onSkip();
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      debounceMs: 10,
      maxWaitMs: 10,
      minIntervalMs: 1_000,
      retryMs: 50,
    });
    scheduler.notify();
    clock.advance(10);
    await flush();
    assert.equal(runs, 1);
    clock.advance(50);
    await flush();
    assert.equal(runs, 2, "the skipped dispatch was remembered");
  });

  it("runs one trailing turn for events that arrive during a turn", async () => {
    const clock = fakeClock();
    let runs = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const scheduler = createDispatchScheduler({
      run: async () => {
        runs += 1;
        if (runs === 1) await gate;
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      debounceMs: 10,
      maxWaitMs: 10,
      minIntervalMs: 0,
    });
    scheduler.notify();
    clock.advance(10);
    await flush();
    assert.equal(runs, 1);

    scheduler.notify(); // arrives while run 1 is still in flight
    release();
    await flush();
    clock.advance(10);
    await flush();
    assert.equal(runs, 2, "the in-flight event produced exactly one trailing run");
  });
});

describe("loop/subscribe — endpoint resolution", () => {
  it("reads the pointer and the token file", () => {
    const dir = tempDir();
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `td_${"a".repeat(64)}\n`);
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:9999/", tokenFile, dataDir: dir }));
    const endpoint = resolveEventEndpoint(
      { repo: dir, token: null },
      { TASKD_RUNTIME_POINTER: pointerPath, TASKD_DATA_DIR: dir },
    );
    assert.equal(endpoint.url, "http://127.0.0.1:9999");
    assert.equal(endpoint.token, `td_${"a".repeat(64)}`);
  });

  it("returns null when there is no pointer", () => {
    const dir = tempDir();
    assert.equal(
      resolveEventEndpoint({ repo: dir, token: null }, { TASKD_RUNTIME_POINTER: join(dir, "missing.json") }),
      null,
    );
  });

  it("keeps going when the token file is corrupt", () => {
    const dir = tempDir();
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "not-a-token\n");
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:9999", tokenFile, dataDir: dir }));
    const endpoint = resolveEventEndpoint(
      { repo: dir, token: null },
      { TASKD_RUNTIME_POINTER: pointerPath, TASKD_DATA_DIR: dir },
    );
    assert.equal(endpoint.token, null);
  });

  it("lets an explicit --token win", () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:9999", dataDir: dir }));
    const endpoint = resolveEventEndpoint(
      { repo: dir, token: "td_flag" },
      { TASKD_RUNTIME_POINTER: pointerPath, TASKD_DATA_DIR: dir },
    );
    assert.equal(endpoint.token, "td_flag");
  });

  it("prefers --url > TASKD_URL > the pointer", () => {
    const dir = tempDir();
    const pointerPath = join(dir, "runtime.json");
    writeFileSync(pointerPath, JSON.stringify({ url: "http://127.0.0.1:9999", dataDir: dir }));
    const env = { TASKD_URL: "http://remote.example:9600", TASKD_RUNTIME_POINTER: pointerPath, TASKD_DATA_DIR: dir };
    assert.equal(resolveEventEndpoint({ repo: dir, token: null }, env).url, "http://remote.example:9600");
    assert.equal(
      resolveEventEndpoint({ repo: dir, url: "http://flag.example:9527", token: null }, env).url,
      "http://flag.example:9527",
    );
  });

  it("reads the URL and an inline token from the install-root .env", () => {
    const dir = tempDir();
    const token = `td_${"b".repeat(64)}`;
    const envFile = join(dir, ".env");
    writeFileSync(envFile, `TASKD_URL=http://from-file.example:9600\nTASKD_TOKEN=${token}\n`, { mode: 0o600 });
    const endpoint = resolveEventEndpoint(
      { repo: dir, token: null },
      { MEERKAT_TASKPANEL_ENV_FILE: envFile, TASKD_RUNTIME_POINTER: join(dir, "missing.json"), TASKD_DATA_DIR: dir },
    );
    assert.equal(endpoint.url, "http://from-file.example:9600");
    assert.equal(endpoint.token, token);
  });

  it("surfaces a broken explicitly configured token file", () => {
    const dir = tempDir();
    const envFile = join(dir, ".env");
    // A URL is needed for the resolver to reach the token step at all.
    writeFileSync(envFile, "TASKD_URL=http://127.0.0.1:9999\nTASKD_TOKEN_FILE=missing\n", { mode: 0o600 });
    assert.throws(
      () =>
        resolveEventEndpoint(
          { repo: dir, token: null },
          { MEERKAT_TASKPANEL_ENV_FILE: envFile, TASKD_RUNTIME_POINTER: join(dir, "missing.json"), TASKD_DATA_DIR: dir },
        ),
      (err) => err.code === "CONFIG_FILE_INVALID" && err.details.source === "config",
    );
  });
});

describe("loop/subscribe — the process loop", () => {
  it("turns a dispatch event into one continue turn, then stops on abort", async () => {
    const controller = new AbortController();
    let runs = 0;
    const code = await runSubscribe(
      {
        agents: ["linus"],
        eventDebounceMs: 0,
        eventDebounceMaxMs: 0,
        eventContinueMinMs: 0,
        sseIdleMs: 1_000,
      },
      {},
      {
        controller,
        dispatchEnabled: true,
        loopConfig: { continueEnabled: true, eventContinueEnabled: true },
        log: () => {},
        resolveEventEndpoint: () => ({ url: "http://board", token: null }),
        connectSse: async ({ onOpen, onFrame }) => {
          onOpen();
          onFrame({
            id: "1",
            event: "message",
            data: JSON.stringify({ event: "task_created", actor_kind: "human", actor_id: "terry" }),
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
          return { reason: "aborted" };
        },
        runContinue: async () => { runs += 1; },
        sleep: async () => {},
      },
    );
    assert.equal(code, 0);
    assert.equal(runs, 1);
  });

  it("does not dispatch when --event-continue=no", async () => {
    const controller = new AbortController();
    let runs = 0;
    await runSubscribe(
      { agents: ["linus"], eventDebounceMs: 0, eventDebounceMaxMs: 0, eventContinueMinMs: 0, sseIdleMs: 1_000 },
      {},
      {
        controller,
        dispatchEnabled: false,
        loopConfig: { continueEnabled: true, eventContinueEnabled: false },
        log: () => {},
        resolveEventEndpoint: () => ({ url: "http://board", token: null }),
        connectSse: async ({ onFrame }) => {
          onFrame({
            id: "1",
            event: "message",
            data: JSON.stringify({ event: "task_created", actor_kind: "human", actor_id: "terry" }),
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.abort();
          return { reason: "aborted" };
        },
        runContinue: async () => { runs += 1; },
        sleep: async () => {},
      },
    );
    assert.equal(runs, 0);
  });
});
