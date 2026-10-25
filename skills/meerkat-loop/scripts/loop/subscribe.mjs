#!/usr/bin/env node
/**
 * The event subscriber — the loop's ears.
 *
 * Spawns `taskctl events follow` — the local event hub's client — and asks for
 * a `continue` turn when a dispatch-relevant event arrives. The hub owns the
 * host's one board connection; the loop still never speaks HTTP itself, because
 * board discovery, the token and the stream all live behind `taskctl`, and this
 * file only decides when to reconnect and when to wake the agent.
 *
 * It never claims, moves or wakes anything: the continue turn rescans, so
 * replay, duplicate frames and bursts are harmless and there is only one
 * dispatch path. A turn is requested only while a resident pool is live — with
 * no pool, poll could not dispatch anything, so the event path logs and skips
 * and the continue timer remains the patrol + workflow path.
 *
 * A burst is debounced (300 ms, capped at 2 s), at most one turn starts per
 * minute, and a turn refused by the continue lock is retried (5 s), not
 * dropped. The process publishes `subscribe.state.json` beside the other loop
 * state so `--supervisor=status` can tell streaming from reconnect-looping.
 */

import { dirname } from "node:path";

import { isEntryPoint } from "../foundation/entry-guard.mjs";
import {
  CARD_REFRESH_MIN_MS,
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  HUMAN_KIND,
  SSE_SUBSCRIBE_IDLE_MS,
  SUBSCRIBE_BACKOFF_MAX_MS,
  SUBSCRIBE_RETRY_MS,
  SUBSCRIBE_STATE_WRITE_MIN_MS,
  TASKD_KIND,
} from "../foundation/constants.mjs";

import { refreshCardsForIds } from "./card-file.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { createLogger, saveSubscribeState, streamCli, subscribeStatePath } from "./runtime.mjs";
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
  "relation_added",
  "relation_removed",
  "import_completed",
]);

/**
 * The declared events that deliberately do not wake a turn.
 *
 * `task_updated` is absent: its decision is field-dependent (below).
 * `test/contract/activity-consumers.test.mjs` asserts that every declared,
 * non-historical event is in exactly one of this list, `DISPATCH_EVENTS`, or
 * the `task_updated` field rule — a new board event cannot be forgotten here.
 *
 * `epic_auto_start` is board-authored (`taskd`), which `isOwnWrite` already
 * suppresses; listing it as a dispatch was a contradiction, not a behaviour.
 * `task_resumed` is ignored on purpose for now: the human's `comment_added`
 * already refreshes the brief, and the next continue clock picks the returned
 * card up. Whether it should wake a turn immediately is a product decision.
 */
export const IGNORED_EVENTS = Object.freeze([
  "project_created",
  "project_updated",
  "task_claimed",
  "task_heartbeat",
  "task_resumed",
  "task_archived",
  "acceptance_changed",
  "acceptance_pruned",
  "acceptance_override",
  "epic_auto_start",
  "comment_added",
  "label_gc",
  "session_registered",
  "session_closed",
  "progress",
  "attachment_added",
  "attachment_updated",
  "attachment_removed",
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
 * A name neither list knows is a newer board, not an error: it is ignored. A
 * throw here would kill the subscriber and reconnect-loop it against a board
 * that is working correctly.
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
 * Does this event change some active card's markdown?
 *
 * A brief refresh is **not** a dispatch decision: it is a file write, so it
 * follows every event for a card the loop is still working. Own writes are
 * deliberately **not** suppressed (`isOwnWrite` exists to avoid waking the LLM
 * on its own echo) — a worker's own comment or report is exactly what the brief
 * needs to reflect. Heartbeats are already filtered from the stream; an event
 * without a `task_id` cannot be mapped to a queue row.
 *
 * @param {object} activity an `activityToWire` payload
 * @returns {"refresh"|"ignore"}
 */
export function classifyRefresh(activity) {
  if (typeof activity?.task_id !== "string" || activity.task_id === "") return "ignore";
  return activity.event === "task_heartbeat" ? "ignore" : "refresh";
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
 * The CLI invocation for one follow attempt.
 *
 * `events follow` consumes the local event hub, which owns the single board
 * connection. `events tail` would open a second SSE stream on the board — the
 * duplication the hub exists to remove.
 *
 * @param {{idleMs: number, after?: number|null}} input
 * @returns {string[]}
 */
export function followArgs(input) {
  const after = input?.after;
  return [
    "events",
    "follow",
    "--idle",
    String(input.idleMs),
    ...(after === null || after === undefined ? [] : ["--after", String(after)]),
  ];
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
      ((hooks) =>
        (deps.runContinueOnce ?? runContinueOnce)(opts, env, { ...hooks, requirePool: true })),
    now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    debounceMs: opts.eventDebounceMs ?? EVENT_DEBOUNCE_MS,
    maxWaitMs: opts.eventDebounceMaxMs ?? EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs: opts.eventContinueMinMs ?? EVENT_CONTINUE_MIN_MS,
    retryMs: deps.retryMs ?? SUBSCRIBE_RETRY_MS,
    log,
  });

  // The brief refresher is independent of the continue scheduler: it is cheap,
  // it follows comments and reports (not just dispatch events), and it still
  // works when `--event-continue=no`. It is debounced like a dispatch burst and
  // bounded by its own (much smaller) minimum interval.
  const pendingRefresh = new Set();
  const stateDir =
    deps.stateDir ??
    (typeof opts.state === "string" && opts.state !== "" ? dirname(opts.state) : null);

  // What `--supervisor=status` reads. A quiet board produces no events, so the
  // useful liveness facts are "when did we last open a stream" and "are we
  // waiting to reconnect" — both forced flushes; traffic only updates the rest.
  const subscribePath =
    deps.subscribeStatePath ??
    (stateDir === null || stateDir === undefined || stateDir === ""
      ? null
      : subscribeStatePath(stateDir));
  const writeState = deps.writeSubscribeState ?? saveSubscribeState;
  const state = {
    version: 1,
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    connectedAt: null,
    lastEventAt: null,
    lastEventId: null,
    reconnects: 0,
    lastError: null,
    lastErrorAt: null,
    nextAttemptAt: null,
    dispatchEnabled,
    updatedAt: null,
  };
  let lastWritten = null;
  let lastWriteAt = null;
  let stateWriteFailed = false;
  const flushState = (force = false) => {
    if (subscribePath === null) return;
    const at = now();
    if (!force && lastWriteAt !== null && at - lastWriteAt < SUBSCRIBE_STATE_WRITE_MIN_MS) return;
    state.updatedAt = new Date(at).toISOString();
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (serialized === lastWritten) return;
    try {
      writeState(subscribePath, { ...state });
      lastWritten = serialized;
      lastWriteAt = at;
    } catch (err) {
      // Observability is never allowed to break the stream; say it once.
      if (!stateWriteFailed) {
        stateWriteFailed = true;
        log(`subscribe: could not write state: ${err.message}`);
      }
    }
  };
  flushState(true);

  const refreshCards =
    deps.refreshCards ??
    ((taskIds) => refreshCardsForIds({ opts, stateDir, taskIds, log }));
  const refreshScheduler = createDispatchScheduler({
    run: async () => {
      const taskIds = [...pendingRefresh];
      pendingRefresh.clear();
      refreshCards(taskIds);
    },
    now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    debounceMs: opts.eventDebounceMs ?? EVENT_DEBOUNCE_MS,
    maxWaitMs: opts.eventDebounceMaxMs ?? EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs: deps.refreshMinMs ?? CARD_REFRESH_MIN_MS,
    retryMs: deps.retryMs ?? SUBSCRIBE_RETRY_MS,
    log,
  });

  // One connection attempt = one `taskctl events follow` child. It talks to the
  // local event hub, which owns the single board SSE connection (and its
  // reconnect ladder) for every consumer on this host. Board discovery, the
  // token and `.env` still belong to the CLI; the loop keeps only its own
  // reconnect ladder for the local stream and the dispatch decision.
  const streamEvents =
    deps.streamEvents ??
    ((input) =>
      streamCli(
        opts,
        opts.agents[0],
        followArgs(input),
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
          state.connectedAt = new Date(now()).toISOString();
          state.nextAttemptAt = null;
          flushState(true);
          log("subscribe: connected");
        },
        onEvent: ({ id, data }) => {
          cursor = advanceCursor(cursor, { id });
          state.lastEventAt = new Date(now()).toISOString();
          state.lastEventId = cursor;
          flushState(false);
          if (dispatchEnabled && classify(data, { agents: opts.agents }) === "dispatch") {
            scheduler.notify();
          }
          if (classifyRefresh(data) === "refresh") {
            pendingRefresh.add(data.task_id);
            refreshScheduler.notify();
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
    state.reconnects += 1;
    if (result.reason === "error") {
      state.lastError = result.error?.message ?? "connection failed";
      state.lastErrorAt = new Date(now()).toISOString();
    }
    state.nextAttemptAt = new Date(now() + backoff).toISOString();
    flushState(true);
    await sleepFor(backoff);
    backoff = nextBackoff(backoff);
  }

  state.nextAttemptAt = null;
  flushState(true);
  scheduler.stop();
  refreshScheduler.stop();
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
