/**
 * The loop's event subscriber: what it dispatches, how it coalesces, how it
 * reconnects, and that a refused turn is retried rather than dropped.
 *
 * The transport itself is injected: `streamEvents` stands where the spawned
 * `taskctl events follow` would be, so these tests stay deterministic.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readInterruptRequestIndex } from "../../src/orchestrator/interrupts.mjs";
import {
  DISPATCH_EVENTS,
  IGNORED_EVENTS,
  advanceCursor,
  classify,
  createDispatchScheduler,
  followArgs,
  nextBackoff,
  runSubscribe,
} from "../../src/orchestrator/subscribe.mjs";

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
    for (const event of DISPATCH_EVENTS) {
      assert.equal(classify(activity(event, { actor_kind: "human", actor_id: "terry" }), { agents: ["linus"] }), "dispatch", event);
    }
  });

  it("ignores the events that cannot change candidacy", () => {
    for (const event of IGNORED_EVENTS) {
      assert.equal(classify(activity(event, { actor_kind: "human", actor_id: "terry" }), { agents: ["linus"] }), "ignore", event);
    }
  });

  it("keeps the two lists disjoint, and ignores a name neither knows", () => {
    const overlap = DISPATCH_EVENTS.filter((event) => IGNORED_EVENTS.includes(event));
    assert.deepEqual(overlap, [], "an event cannot be both dispatched and ignored");
    assert.equal(
      classify(activity("brand_new_event", { actor_kind: "human", actor_id: "terry" }), { agents: [] }),
      "ignore",
      "a newer board's event must never wake work",
    );
  });

  it("does not dispatch the board's own epic start", () => {
    // `epic_auto_start` is written by the board (`Board`, kind `system`), so
    // suppression by author already wins; it belongs in the explicit ignore
    // list, not the dispatch whitelist.
    assert.equal(IGNORED_EVENTS.includes("epic_auto_start"), true);
    assert.equal(DISPATCH_EVENTS.includes("epic_auto_start"), false);
    assert.equal(
      classify(activity("epic_auto_start", { actor_kind: "system", actor_id: "Board" }), { agents: ["linus"] }),
      "ignore",
    );
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

  it("wakes the question lane for an own worker's question, but not its note", () => {
    const ctx = { agents: ["linus"] };
    assert.equal(
      classify(
        activity("comment_added", { changes: { kind: "question" }, actor_kind: "claude", actor_id: "linus" }),
        ctx,
      ),
      "dispatch",
      "the worker's own question is a handoff to the director, not an echo",
    );
    assert.equal(
      classify(
        activity("comment_added", { changes: { kind: "note" }, actor_kind: "claude", actor_id: "linus" }),
        ctx,
      ),
      "ignore",
    );
    assert.equal(
      classify(
        activity("comment_added", { changes: { kind: "note" }, actor_kind: "human", actor_id: "terry" }),
        ctx,
      ),
      "dispatch",
      "a human comment is always worth a re-scan",
    );
  });

  it("wakes when the director releases a card to the queue, even as an own write", () => {
    const ctx = { agents: ["linus"] };
    assert.equal(
      classify(
        activity("task_moved", { changes: { from: "in_progress", to: "todo" }, actor_kind: "claude", actor_id: "linus" }),
        ctx,
      ),
      "dispatch",
    );
    assert.equal(
      classify(
        activity("task_moved", { changes: { from: "todo", to: "in_progress" }, actor_kind: "claude", actor_id: "linus" }),
        ctx,
      ),
      "ignore",
      "a claim is not a release",
    );
    assert.equal(
      classify(
        activity("task_moved", { changes: { from: "in_progress", to: "awaiting" }, actor_kind: "claude", actor_id: "linus" }),
        ctx,
      ),
      "ignore",
      "an escalation parks; only a human comment resumes it",
    );
  });

  it("treats the Director as an own writer, but still wakes on its release", () => {
    const ctx = { agents: ["linus"] };
    assert.equal(
      classify(
        activity("task_updated", { changes: { fields: ["meta"] }, actor_kind: "claude", actor_id: "Director" }),
        ctx,
      ),
      "ignore",
      "the decision lane's triage marker is an echo, not news",
    );
    assert.equal(
      classify(
        activity("task_updated", { changes: { fields: ["assigneeId", "assigneeKind"] }, actor_kind: "claude", actor_id: "Director" }),
        ctx,
      ),
      "ignore",
      "the director's route is an echo, not news",
    );
    assert.equal(
      classify(
        activity("task_moved", { changes: { from: "in_progress", to: "todo" }, actor_kind: "claude", actor_id: "Director" }),
        ctx,
      ),
      "dispatch",
      "the release wakes the worker even though the Director is an own writer",
    );
  });

  it("wakes when a human answer resumes an awaiting card", () => {
    assert.equal(
      classify(
        activity("task_resumed", { changes: { from: "awaiting", to: "todo" }, actor_kind: "human", actor_id: "terry" }),
        { agents: ["linus"] },
      ),
      "dispatch",
    );
  });

  it("suppresses the board's own housekeeping and this loop's agents", () => {
    const ctx = { agents: ["linus"] };
    assert.equal(classify(activity("task_created", { actor_kind: "system", actor_id: "Board" }), ctx), "ignore");
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "linus" }), ctx), "ignore");
    // The workflow pass is the board too: one automation identity, one id.
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "Board" }), ctx), "ignore");
    // `system` is a kind, not an identity: a row that names it as the id is not
    // the board's own write (ADR 0018). The kind alone decides nothing.
    assert.equal(classify(activity("task_created", { actor_kind: "system", actor_id: "system" }), ctx), "dispatch");
    // The importer is the board's platform under a component id: it must pass.
    assert.equal(classify(activity("import_completed", { actor_kind: "system", actor_id: "md-import" }), ctx), "dispatch");
    // A human whose id happens to match an agent is still a human.
    assert.equal(classify(activity("task_created", { actor_kind: "human", actor_id: "linus" }), ctx), "dispatch");
    // A `system` kind alone is not enough: the id decides, so an importer stays visible.
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "md-import" }), ctx), "dispatch");
    // Legacy rows carried the retired kind; the same ids still classify correctly.
    assert.equal(classify(activity("task_moved", { actor_kind: "taskd", actor_id: "taskd" }), ctx), "ignore");
    assert.equal(classify(activity("task_moved", { actor_kind: "system", actor_id: "linus" }), ctx), "ignore");
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

describe("loop/subscribe — runtime state", () => {
  const baseOpts = () => ({
    agents: ["linus"],
    eventDebounceMs: 0,
    eventDebounceMaxMs: 0,
    eventContinueMinMs: 0,
    sseIdleMs: 1_000,
  });

  it("publishes the process and connection facts for status", async () => {
    const controller = new AbortController();
    const writes = [];
    const clock = { t: 0 };
    await runSubscribe(baseOpts(), {}, {
      controller,
      dispatchEnabled: true,
      loopConfig: { continueEnabled: true, eventContinueEnabled: true },
      log: () => {},
      now: () => clock.t,
      stateDir: "/state",
      subscribeStatePath: "/state/subscribe.state.json",
      writeSubscribeState: (path, state) => writes.push({ path, state }),
      streamEvents: async ({ onOpen, onEvent }) => {
        clock.t = 1_000;
        onOpen();
        clock.t = 3_000;
        onEvent({
          id: 7,
          data: { event: "task_created", actor_kind: "human", actor_id: "terry" },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        return { reason: "aborted" };
      },
      runContinue: async () => {},
      sleep: async () => {},
    });

    assert.equal(writes[0].path, "/state/subscribe.state.json");
    assert.equal(writes[0].state.version, 1);
    assert.equal(writes[0].state.pid, process.pid);
    const connected = writes.find((write) => write.state.connectedAt !== null);
    assert.equal(connected.state.connectedAt, new Date(1_000).toISOString());
    const last = writes[writes.length - 1].state;
    assert.equal(last.lastEventAt, new Date(3_000).toISOString());
    assert.equal(last.lastEventId, 7);
    assert.equal(last.nextAttemptAt, null);
    assert.equal(last.dispatchEnabled, true);
    assert.equal(typeof last.updatedAt, "string");
  });

  it("records a reconnect attempt, its error and when the next one is due", async () => {
    const controller = new AbortController();
    const writes = [];
    let call = 0;
    await runSubscribe(baseOpts(), {}, {
      controller,
      dispatchEnabled: false,
      loopConfig: { continueEnabled: false, eventContinueEnabled: false },
      log: () => {},
      now: () => 5_000,
      subscribeStatePath: "/state/subscribe.state.json",
      writeSubscribeState: (_path, state) => writes.push(state),
      streamEvents: async () => {
        call += 1;
        if (call === 1) return { reason: "error", error: new Error("boom") };
        controller.abort();
        return { reason: "aborted" };
      },
      runContinue: async () => {},
      sleep: async () => {},
    });

    const attempt = writes.find((state) => state.nextAttemptAt !== null);
    assert.equal(attempt.reconnects, 1);
    assert.equal(attempt.nextAttemptAt, new Date(6_000).toISOString());
    assert.equal(attempt.lastError, "boom");
    assert.equal(attempt.lastErrorAt, new Date(5_000).toISOString());
    assert.equal(writes[writes.length - 1].nextAttemptAt, null, "a stopped subscriber is not reconnecting");
  });

  it("throttles event-time writes but never drops the final one", async () => {
    const controller = new AbortController();
    const writes = [];
    const clock = { t: 0 };
    await runSubscribe(baseOpts(), {}, {
      controller,
      dispatchEnabled: false,
      loopConfig: { continueEnabled: false, eventContinueEnabled: false },
      log: () => {},
      now: () => clock.t,
      subscribeStatePath: "/state/subscribe.state.json",
      writeSubscribeState: (_path, state) => writes.push(state),
      streamEvents: async ({ onEvent }) => {
        onEvent({ id: 1, data: { event: "comment_added", task_id: "u1" } });
        clock.t = 1_000;
        onEvent({ id: 2, data: { event: "comment_added", task_id: "u1" } });
        clock.t = 2_500;
        onEvent({ id: 3, data: { event: "comment_added", task_id: "u1" } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort();
        return { reason: "aborted" };
      },
      runContinue: async () => {},
      sleep: async () => {},
    });

    assert.equal(writes.some((state) => state.lastEventId === 2), false, "an event inside the window is coalesced");
    assert.equal(writes.some((state) => state.lastEventId === 3), true);
    assert.equal(writes[writes.length - 1].lastEventId, 3);
  });

  it("never lets a failing state writer stop the stream", async () => {
    const controller = new AbortController();
    const logs = [];
    let runs = 0;
    const code = await runSubscribe(baseOpts(), {}, {
      controller,
      dispatchEnabled: true,
      loopConfig: { continueEnabled: true, eventContinueEnabled: true },
      log: (line) => logs.push(line),
      subscribeStatePath: "/state/subscribe.state.json",
      writeSubscribeState: () => {
        throw new Error("disk full");
      },
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
      runContinue: async () => {
        runs += 1;
      },
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(runs, 1, "dispatch still works");
    assert.equal(logs.some((line) => line.includes("could not write state")), true);
  });
});

describe("loop/subscribe — the process loop", () => {
  it("turns a dispatch event into one tick, then stops on abort", async () => {
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

  it("requires a live resident pool for every event-triggered turn", async () => {
    const controller = new AbortController();
    const hooks = [];
    await runSubscribe(
      { agents: ["linus"], eventDebounceMs: 0, eventDebounceMaxMs: 0, eventContinueMinMs: 0, sseIdleMs: 1_000 },
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
        runContinueOnce: async (_opts, _env, passed) => {
          hooks.push(passed);
        },
        sleep: async () => {},
      },
    );
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].requirePool, true);
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

});

/**
 * TP-0125 — the subscriber is one of the three writers of the cross-process
 * interrupt channel. It writes on the **event**, not on the dispatch decision:
 * `classify` is only consulted when dispatch is enabled, and `isOwnWrite` would
 * swallow the loop's own cancellation — both would leave an orphaned turn.
 */
describe("loop/subscribe — claim-cycle exits write an interrupt request", () => {
  it("writes for every exit, including an own write, and never for an inside-cycle move", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tp-subscribe-interrupts-"));
    try {
      const controller = new AbortController();
      const sent = [
        ["u-todo", "task_moved", { from: "in_progress", to: "todo" }, { created_at: "2026-11-05T09:00:00.000Z" }],
        // The loop canceled its own review card: `isOwnWrite` says ignore, the
        // marker must still be written.
        ["u-own", "task_moved", { from: "in_review", to: "canceled" }, { actor_kind: "system", actor_id: "orchestrator" }],
        ["u-resumed", "task_resumed", { from: "awaiting", to: "todo" }, {}],
        // Inside the cycle: no marker.
        ["u-rework", "task_moved", { from: "in_review", to: "in_progress" }, {}],
        ["u-backlog", "task_moved", { from: "todo", to: "backlog" }, {}],
        ["u-await", "task_moved", { from: "in_progress", to: "awaiting" }, {}],
      ];
      await runSubscribe(
        { agents: ["linus"], eventDebounceMs: 0, eventDebounceMaxMs: 0, eventContinueMinMs: 0, sseIdleMs: 1_000 },
        {},
        {
          controller,
          // Deliberately off: the marker must not depend on the dispatch path.
          dispatchEnabled: false,
          loopConfig: { continueEnabled: false, eventContinueEnabled: false },
          log: () => {},
          stateDir,
          subscribeStatePath: join(stateDir, "subscribe.state.json"),
          writeSubscribeState: () => {},
          streamEvents: async ({ onEvent }) => {
            sent.forEach(([taskId, event, changes, extra], index) =>
              onEvent({ id: index + 1, data: { event, task_id: taskId, changes, ...extra } }),
            );
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.abort();
            return { reason: "aborted" };
          },
          runContinue: async () => {},
          sleep: async () => {},
        },
      );

      const index = readInterruptRequestIndex(stateDir);
      assert.deepEqual([...index.byTask.keys()].sort(), ["u-own", "u-resumed", "u-todo"]);
      assert.equal(index.byTask.get("u-todo")[0].to, "todo");
      assert.equal(index.byTask.get("u-resumed")[0].from, "awaiting");
      assert.equal(index.byTask.get("u-own")[0].requested_by, "subscribe");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
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
