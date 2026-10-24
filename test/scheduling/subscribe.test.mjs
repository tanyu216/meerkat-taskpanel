/**
 * The loop's event subscriber: what it dispatches, how it coalesces, how it
 * reconnects, and that a refused turn is retried rather than dropped.
 *
 * The transport itself is injected: `streamEvents` stands where the spawned
 * `taskctl events tail` would be, so these tests stay deterministic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceCursor,
  classify,
  classifyRefresh,
  createDispatchScheduler,
  followArgs,
  nextBackoff,
  runSubscribe,
} from "../../scripts/loop/subscribe.mjs";

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
      "task_reopened",
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

  it("refreshes a card's brief on any event with a task id, including own writes", () => {
    assert.equal(classifyRefresh(activity("comment_added", { task_id: "u1" })), "refresh");
    assert.equal(classifyRefresh(activity("task_updated", { task_id: "u1" })), "refresh");
    assert.equal(
      classifyRefresh(activity("report_written", { task_id: "u1", actor_kind: "claude", actor_id: "linus" })),
      "refresh",
      "a worker's own report must reach the brief",
    );
    assert.equal(classifyRefresh(activity("task_heartbeat", { task_id: "u1" })), "ignore");
    assert.equal(classifyRefresh(activity("task_created")), "ignore", "no task id, no row to map");
  });

  it("advances the cursor monotonically", () => {
    assert.equal(advanceCursor(null, { id: "5" }), 5);
    assert.equal(advanceCursor(5, { id: "3" }), 5);
    assert.equal(advanceCursor(5, { id: "9" }), 9);
    assert.equal(advanceCursor(5, { id: null }), 5);
    assert.equal(advanceCursor(5, { id: "nope" }), 5);
    // `streamCli` delivers a numeric id.
    assert.equal(advanceCursor(5, { id: 7 }), 7);
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

describe("loop/subscribe — the reconnect ladder", () => {
  it("goes 1s, 2s, 4s … capped at 30s", () => {
    let delay = 0;
    const ladder = [];
    for (let i = 0; i < 8; i += 1) {
      delay = nextBackoff(delay);
      ladder.push(delay);
    }
    assert.deepEqual(ladder, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("resets after a shutdown and advances after idle/eof/error", async () => {
    const controller = new AbortController();
    const sleeps = [];
    const reasons = ["shutdown", "idle", "eof", "error", "aborted"];
    let call = 0;
    await runSubscribe(
      { agents: ["linus"] },
      {},
      {
        controller,
        dispatchEnabled: false,
        loopConfig: { continueEnabled: false, eventContinueEnabled: false },
        log: () => {},
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        streamEvents: async () => {
          const reason = reasons[call] ?? "aborted";
          call += 1;
          if (reason === "aborted") controller.abort();
          return { reason, error: reason === "error" ? new Error("boom") : null };
        },
        runContinue: async () => {},
      },
    );
    // shutdown resets to 1s; idle 2s; eof 4s; error 8s; aborted stops before sleeping.
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
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
        streamEvents: async ({ onOpen, onEvent }) => {
          onOpen();
          onEvent({
            id: 1,
            data: { event: "task_created", actor_kind: "human", actor_id: "terry" },
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
        streamEvents: async ({ onEvent }) => {
          onEvent({
            id: 1,
            data: { event: "task_created", actor_kind: "human", actor_id: "terry" },
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

  it("batch-refreshes the cards named by events, even with event-continue off", async () => {
    const controller = new AbortController();
    const batches = [];
    let runs = 0;
    await runSubscribe(
      { agents: ["linus"], eventDebounceMs: 0, eventDebounceMaxMs: 0, eventContinueMinMs: 0, sseIdleMs: 1_000 },
      {},
      {
        controller,
        dispatchEnabled: false,
        loopConfig: { continueEnabled: true, eventContinueEnabled: false },
        log: () => {},
        stateDir: "/state",
        refreshMinMs: 0,
        refreshCards: (taskIds) => batches.push(taskIds),
        streamEvents: async ({ onEvent }) => {
          onEvent({
            id: 1,
            data: { event: "comment_added", task_id: "uuid-1", actor_kind: "claude", actor_id: "linus" },
          });
          onEvent({
            id: 2,
            data: { event: "report_written", task_id: "uuid-1", actor_kind: "claude", actor_id: "linus" },
          });
          onEvent({
            id: 3,
            data: { event: "task_heartbeat", task_id: "uuid-2", actor_kind: "claude", actor_id: "linus" },
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
          return { reason: "aborted" };
        },
        runContinue: async () => {
          runs += 1;
        },
        sleep: async () => {},
      },
    );
    assert.equal(runs, 0, "a brief refresh is not a continue turn");
    assert.deepEqual(batches, [["uuid-1"]], "one debounced batch; the heartbeat is ignored");
  });

  it("logs a failed refresh and keeps the stream alive", async () => {
    const controller = new AbortController();
    const logs = [];
    await runSubscribe(
      { agents: ["linus"], eventDebounceMs: 0, eventDebounceMaxMs: 0, eventContinueMinMs: 0, sseIdleMs: 1_000 },
      {},
      {
        controller,
        dispatchEnabled: false,
        loopConfig: { continueEnabled: true, eventContinueEnabled: false },
        log: (line) => logs.push(line),
        stateDir: "/state",
        refreshMinMs: 0,
        refreshCards: () => {
          throw new Error("disk full");
        },
        streamEvents: async ({ onEvent }) => {
          onEvent({
            id: 1,
            data: { event: "comment_added", task_id: "uuid-1", actor_kind: "claude", actor_id: "linus" },
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.abort();
          return { reason: "aborted" };
        },
        runContinue: async () => {},
        sleep: async () => {},
      },
    );
    assert.equal(logs.some((line) => line.includes("disk full")), true);
  });
});

describe("the loop consumes the local event hub", () => {
  it("spawns `events follow`, not another direct board stream", () => {
    assert.deepEqual(followArgs({ idleMs: 45_000 }), [
      "events",
      "follow",
      "--idle",
      "45000",
    ]);
    assert.deepEqual(followArgs({ idleMs: 45_000, after: 12 }), [
      "events",
      "follow",
      "--idle",
      "45000",
      "--after",
      "12",
    ]);
  });
});
