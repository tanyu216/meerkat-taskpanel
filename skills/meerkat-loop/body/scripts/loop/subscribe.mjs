#!/usr/bin/env node
/**
 * The event subscriber — the loop's ears.
 *
 * It keeps one long-lived SSE connection to the board and turns a **signal**
 * into a dispatch decision. It does not claim, move or wake anything itself:
 * an event asks for one existing `continue` turn, whose `patrol → workflow →
 * poll` sequence makes the actual decision from the board's current state.
 *
 * That division is what keeps replay, duplicate frames and bursts harmless:
 * the continue turn rescans, and the claim CAS plus the worker registry are the
 * only dispatch authorities. It also means there is one dispatch path, not two.
 *
 * Coalescing is deliberate:
 *   * a burst is debounced (300 ms) but never delayed past 2 s;
 *   * at most one turn starts per minute;
 *   * a turn refused by the continue lock is remembered and retried (5 s), not
 *     dropped — the in-flight turn may have scanned before this event existed.
 *
 * Node builtins only; no network, no dependencies.
 */

import { isEntryPoint } from "../../src/shared/entry-guard.mjs";
import {
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  SSE_SUBSCRIBE_IDLE_MS,
  SUBSCRIBE_RETRY_MS,
} from "../../src/shared/constants.mjs";

import * as continueEntry from "./continue.mjs";
import { resolveEventEndpoint } from "./endpoint.mjs";
import { advanceCursor, classify } from "./event-rules.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { createLogger } from "./runtime.mjs";
import { connectSse, nextBackoff } from "./sse-client.mjs";

/**
 * A tiny coalescing scheduler, exported so its timing is unit-testable without
 * a socket. `run` receives the hooks the continue entry understands.
 *
 * @param {{
 *   run: (hooks: {onSkip: () => void}) => Promise<unknown>,
 *   now?: () => number,
 *   setTimer?: Function,
 *   clearTimer?: Function,
 *   debounceMs?: number,
 *   maxWaitMs?: number,
 *   minIntervalMs?: number,
 *   retryMs?: number,
 *   log?: (line: string) => void,
 * }} input
 */
export function createDispatchScheduler(input) {
  const {
    run,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    debounceMs = EVENT_DEBOUNCE_MS,
    maxWaitMs = EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs = EVENT_CONTINUE_MIN_MS,
    retryMs = SUBSCRIBE_RETRY_MS,
    log = () => {},
  } = input;

  let pending = false;
  let timer = null;
  // `null`, not 0: a manual clock legitimately starts at 0, and a 0 sentinel
  // would restart the max-wait window on every event.
  let firstPendingAt = null;
  let running = false;
  let lastRunAt = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const arm = (delay) => {
    clear();
    timer = setTimer(() => {
      timer = null;
      pump();
    }, Math.max(0, delay));
  };

  async function pump() {
    if (stopped || !pending || running) return;
    if (lastRunAt !== null) {
      const wait = lastRunAt + minIntervalMs - now();
      if (wait > 0) {
        arm(wait);
        return;
      }
    }
    pending = false;
    firstPendingAt = null;
    running = true;
    let skipped = false;
    try {
      await run({ onSkip: () => { skipped = true; } });
    } catch (err) {
      log(`subscribe: dispatch failed: ${err.message}`);
    } finally {
      running = false;
      if (skipped) {
        pending = true;
        arm(retryMs);
      } else {
        lastRunAt = now();
        if (pending) arm(0);
      }
    }
  }

  return {
    /** A dispatch-relevant event arrived. */
    notify() {
      if (stopped) return;
      pending = true;
      const at = now();
      if (firstPendingAt === null) firstPendingAt = at;
      // Debounce, but never hold the first event longer than maxWaitMs.
      arm(Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - at)));
    },
    stop() {
      stopped = true;
      clear();
    },
    get pending() {
      return pending;
    },
    get running() {
      return running;
    },
  };
}

/** An abortable sleep: SIGTERM must not wait out a 30 s backoff. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keep a subscriber alive until the signal aborts.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [deps] injectable seams for tests
 * @returns {Promise<number>} exit code
 */
export async function runSubscribe(opts, env = process.env, deps = {}) {
  const log = deps.log ?? createLogger(opts);
  const connect = deps.connectSse ?? connectSse;
  const resolveEndpoint = deps.resolveEventEndpoint ?? resolveEventEndpoint;
  const controller = deps.controller ?? new AbortController();
  const signal = controller.signal;
  const now = deps.now ?? Date.now;
  const sleepFor = deps.sleep ?? ((ms) => sleep(ms, signal));

  const loopConfig = deps.loopConfig ?? resolveLoopConfig(opts, env);
  const dispatchEnabled =
    deps.dispatchEnabled ?? (loopConfig.continueEnabled && loopConfig.eventContinueEnabled);
  if (!dispatchEnabled) {
    log("subscribe: event dispatch is disabled (--continue=no or --event-continue=no)");
  }

  const scheduler = createDispatchScheduler({
    run:
      deps.runContinue ??
      ((hooks) => continueEntry.runOnce(opts, env, hooks)),
    now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    debounceMs: opts.eventDebounceMs ?? EVENT_DEBOUNCE_MS,
    maxWaitMs: opts.eventDebounceMaxMs ?? EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs: opts.eventContinueMinMs ?? EVENT_CONTINUE_MIN_MS,
    retryMs: deps.retryMs ?? SUBSCRIBE_RETRY_MS,
    log,
  });

  let cursor = deps.initialCursor ?? null;
  let backoff = 1000;

  while (!signal.aborted) {
    let endpoint = null;
    try {
      endpoint = await resolveEndpoint(opts, env);
    } catch (err) {
      log(`subscribe: endpoint resolution failed: ${err.message}`);
    }
    if (endpoint === null) {
      log("subscribe: no board pointer yet; retrying");
      await sleepFor(backoff);
      backoff = nextBackoff(backoff);
      continue;
    }

    let result;
    try {
      result = await connect({
        url: endpoint.url,
        token: endpoint.token,
        after: cursor,
        idleMs: opts.sseIdleMs ?? SSE_SUBSCRIBE_IDLE_MS,
        signal,
        onOpen: () => {
          backoff = 1000;
          log(`subscribe: connected ${endpoint.url}`);
        },
        onFrame: (frame) => {
          cursor = advanceCursor(cursor, frame);
          let activity;
          try {
            activity = JSON.parse(frame.data);
          } catch {
            return; // a frame that is not JSON cannot name a board event
          }
          if (dispatchEnabled && classify(activity, { agents: opts.agents }) === "dispatch") {
            scheduler.notify();
          }
        },
      });
    } catch (err) {
      result = { reason: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (signal.aborted) break;
    if (result.reason === "shutdown") {
      backoff = 1000;
      log("subscribe: the board is shutting down; reconnecting");
    } else if (result.reason === "idle") {
      log("subscribe: idle timeout; reconnecting");
    } else if (result.reason === "error") {
      log(`subscribe: ${result.error?.message ?? "connection failed"}`);
    }
    await sleepFor(backoff);
    backoff = nextBackoff(backoff);
  }

  scheduler.stop();
  return 0;
}

/** One subscriber process, owning SIGINT/SIGTERM. */
export async function runOnce(opts, env = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runSubscribe(opts, env, { controller });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`subscribe: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (selectMode(opts) !== "subscribe") {
    process.stderr.write("subscribe: pass --subscribe (it is a daemon mode, not an --once entry)\n");
    return 2;
  }
  return runOnce(opts, env);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
