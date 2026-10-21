#!/usr/bin/env node
/**
 * The event subscriber — the loop's ears.
 *
 * Spawns `taskctl events tail` and asks for a `continue` turn when a
 * dispatch-relevant event arrives. The loop never speaks HTTP itself: board
 * discovery, the token and the stream all live behind `taskctl`, and this file
 * only decides when to reconnect and when to wake the host.
 *
 * It never claims, moves or wakes anything: the continue turn rescans, so
 * replay, duplicate frames and bursts are harmless and there is only one
 * dispatch path.
 *
 * A burst is debounced (300 ms, capped at 2 s), at most one turn starts per
 * minute, and a turn refused by the continue lock is retried (5 s), not
 * dropped.
 */

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";
import {
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  HUMAN_KIND,
  SSE_SUBSCRIBE_IDLE_MS,
  SUBSCRIBE_BACKOFF_MAX_MS,
  SUBSCRIBE_RETRY_MS,
  TASKD_KIND,
} from "../../src/foundation/constants.mjs";

import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { createLogger, streamCli } from "./runtime.mjs";
import { runContinueOnce } from "./runners.mjs";

/** The reconnect ladder: 1 s, 2 s, 4 s … capped at 30 s. */
export function nextBackoff(current) {
  const next = current <= 0 ? 1000 : current * 2;
  return Math.min(next, SUBSCRIBE_BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// Which events wake the loop
// ---------------------------------------------------------------------------

/**
 * Events that can make work newly actionable or complete. Everything else is
 * either noise for dispatch (comments, sessions, progress, attachments) or a
 * project-level change the UI reloads but the loop does not act on.
 */
export const DISPATCH_EVENTS = Object.freeze([
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
]);

/**
 * `task_updated` is field-dependent: a title edit is not a dispatch, a
 * reassignment or a workflow `meta` flag is.
 */
export const TASK_UPDATED_DISPATCH_FIELDS = Object.freeze([
  "assigneeId",
  "assigneeKind",
  "kind",
  "labels",
  "meta",
]);

const DISPATCH = new Set(DISPATCH_EVENTS);
const UPDATED_FIELDS = new Set(TASK_UPDATED_DISPATCH_FIELDS);

/**
 * Did this loop (or the board itself) write the activity?
 *
 * Suppression is by author, not by role word: a human's event is never
 * suppressed; `taskd` is the board's own housekeeping; an event authored by one
 * of `opts.agents` is our echo. `import_completed` is authored by `taskd` but
 * under `md-import`, so it survives — an import is work to discover.
 *
 * @param {object} activity an `activityToWire` payload
 * @param {{agents: string[]}} context
 * @returns {boolean}
 */
export function isOwnWrite(activity, context) {
  if (activity?.actor_kind === HUMAN_KIND) return false;
  const id = activity?.actor_id;
  if (typeof id !== "string" || id === "") return false;
  if (id === TASKD_KIND) return true;
  return Array.isArray(context?.agents) && context.agents.includes(id);
}

/**
 * `"dispatch"` asks for a continue turn; `"ignore"` does nothing.
 *
 * @param {object} activity
 * @param {{agents: string[]}} context
 * @returns {"dispatch"|"ignore"}
 */
export function classify(activity, context) {
  if (isOwnWrite(activity, context)) return "ignore";
  const event = activity?.event;
  if (event === "task_updated") {
    const fields = Array.isArray(activity?.changes?.fields) ? activity.changes.fields : [];
    return fields.some((field) => UPDATED_FIELDS.has(field)) ? "dispatch" : "ignore";
  }
  return DISPATCH.has(event) ? "dispatch" : "ignore";
}

/**
 * The reconnect cursor is the largest `id:` seen. It is a revision, and the
 * server replays rows strictly newer than it.
 *
 * @param {number|null} cursor
 * @param {{id: number|string|null}} frame
 * @returns {number|null}
 */
export function advanceCursor(cursor, frame) {
  const next = Number.parseInt(frame?.id ?? "", 10);
  if (!Number.isFinite(next)) return cursor;
  return cursor === null || next > cursor ? next : cursor;
}

/**
 * A coalescing scheduler, exported so its timing is testable without a socket.
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
      ((hooks) => runContinueOnce(opts, env, hooks)),
    now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    debounceMs: opts.eventDebounceMs ?? EVENT_DEBOUNCE_MS,
    maxWaitMs: opts.eventDebounceMaxMs ?? EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs: opts.eventContinueMinMs ?? EVENT_CONTINUE_MIN_MS,
    retryMs: deps.retryMs ?? SUBSCRIBE_RETRY_MS,
    log,
  });

  // One connection attempt = one `taskctl events tail` child. Board discovery,
  // the token and `.env` all belong to the CLI now; the loop only owns the
  // reconnect ladder and the dispatch decision.
  const streamEvents =
    deps.streamEvents ??
    ((input) =>
      streamCli(
        opts,
        opts.agents[0],
        [
          "events",
          "tail",
          "--idle",
          String(input.idleMs),
          ...(input.after === null || input.after === undefined
            ? []
            : ["--after", String(input.after)]),
        ],
        {
          signal: input.signal,
          onOpen: input.onOpen,
          onEvent: input.onEvent,
          log,
        },
      ));

  let cursor = deps.initialCursor ?? null;
  let backoff = 1000;

  while (!signal.aborted) {
    let result;
    try {
      result = await streamEvents({
        after: cursor,
        idleMs: opts.sseIdleMs ?? SSE_SUBSCRIBE_IDLE_MS,
        signal,
        onOpen: () => {
          backoff = 1000;
          log("subscribe: connected");
        },
        onEvent: ({ id, data }) => {
          cursor = advanceCursor(cursor, { id });
          if (dispatchEnabled && classify(data, { agents: opts.agents }) === "dispatch") {
            scheduler.notify();
          }
        },
      });
    } catch (err) {
      result = { reason: "error", error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (signal.aborted || result.reason === "aborted") break;
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
    process.stderr.write("subscribe: pass --subscribe (a daemon mode, not an --once entry)\n");
    return 2;
  }
  return runOnce(opts, env);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
