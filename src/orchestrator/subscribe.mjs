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
 * It never claims, moves or wakes anything: the tick rescans, so
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

import { installEntryCrashGuard, registerLongLivedEntry } from "../foundation/crash-guard.mjs";
import { processStartToken } from "../foundation/daemon-state.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import {
  BOARD_ACTOR_ID,
  DIRECTOR_ACTOR_ID,
  EVENT_CONTINUE_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  HUMAN_KIND,
  SSE_SUBSCRIBE_IDLE_MS,
  SUBSCRIBE_BACKOFF_MAX_MS,
  SUBSCRIBE_RETRY_MS,
  SUBSCRIBE_STATE_WRITE_MIN_MS,
  VERSION,
} from "../foundation/constants.mjs";
import { statePathsForDir } from "../foundation/loop-state.mjs";

import { beginBootHealth } from "./boot-health.mjs";
import { isInterruptActivity, requestInterrupt } from "./interrupts.mjs";
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
  "task_resumed",
  "report_written",
  "report_waived",
  "relation_added",
  "relation_removed",
  "import_completed",
  // 0007 — a human's free-text work request is work to discover: the poll pass
  // reads pending intake and hands it to the decision lane.
  "intake_requested",
]);

/**
 * Events whose decision is **field-dependent**, handled before the two lists.
 *
 * `task_updated` is field-dependent (below). `comment_added` is the question
 * lane's wake: an agent `question` must reach the director even though the
 * worker authored it, and a human comment is always worth a re-scan. A plain
 * agent `note` stays suppressed.
 *
 * `test/contract/activity-consumers.test.mjs` asserts that every declared,
 * non-historical event is in exactly one of `DISPATCH_EVENTS`, `IGNORED_EVENTS`
 * or this set — a new board event cannot be forgotten here.
 */
export const CONDITIONAL_EVENTS = Object.freeze(["task_updated", "comment_added"]);

/**
 * The declared events that deliberately do not wake a turn.
 *
 * `epic_auto_start` is board-authored (`Board`), which `isOwnWrite` already
 * suppresses; listing it as a dispatch was a contradiction, not a behaviour.
 */
export const IGNORED_EVENTS = Object.freeze([
  "project_created",
  "project_updated",
  "task_claimed",
  "task_heartbeat",
  "task_archived",
  "acceptance_changed",
  "acceptance_pruned",
  "acceptance_override",
  "epic_auto_start",
  "label_gc",
  "session_registered",
  "session_closed",
  "progress",
  "attachment_added",
  "attachment_updated",
  "attachment_removed",
  // The two terminal decisions are written by the decision lane/Board itself;
  // the request they settle is no longer pending, so there is nothing to wake.
  "intake_consumed",
  "intake_failed",
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
 * Suppression is by author **id**, not by kind: a human's event is never
 * suppressed; the board's own housekeeping, the workflow pass and every other
 * automated write carry the one identity `Board` (ADR 0018) and are our echo; an
 * event authored by one of `opts.agents` is ours too. `import_completed` is
 * authored under `md-import`, so it survives — an import is work to discover.
 * That is why the rule stays on ids rather than "any `system` write": a
 * historical importer's rows are `system` too, and suppressing them would hide
 * the import.
 *
 * @param {object} activity an `activityToWire` payload
 * @param {{agents: string[]}} context
 * @returns {boolean}
 */
/**
 * The ids the loop writes under: the board's one automation identity `Board`,
 * the decision lane's `Director`, and — for rows recorded before 2026-10-30 — the
 * retired `taskd` id. History is never rewritten, so a replay from a lost cursor
 * still sees it, and the loop's own deliveries must not wake it.
 *
 * `system` is absent on purpose: it is the kind of every automation write, not
 * an id any more, so it suppresses nothing (ADR 0018). The *kind* is deliberately
 * not consulted: `md-import` also wrote `system`, and an import is work to
 * discover. The `in_progress → todo` release is classified before this set, so a
 * Director release still wakes the worker.
 */
const BOARD_ACTOR_IDS = Object.freeze(new Set([BOARD_ACTOR_ID, DIRECTOR_ACTOR_ID, "taskd"]));

export function isOwnWrite(activity, context) {
  if (activity?.actor_kind === HUMAN_KIND) return false;
  const id = activity?.actor_id;
  if (typeof id !== "string" || id === "") return false;
  if (BOARD_ACTOR_IDS.has(id)) return true;
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
  const event = activity?.event;
  const changes = activity?.changes ?? {};
  // The question lane's wake. A worker's own `question` must reach the director
  // even though `isOwnWrite` would suppress it — the loop never writes a
  // worker's question, so this is a handoff, not an echo. A human comment is
  // always worth a re-scan; a plain agent `note` stays suppressed.
  if (event === "comment_added") {
    if (changes.kind === "question") return "dispatch";
    if (String(activity?.actor_kind ?? "").toLowerCase() === HUMAN_KIND) return "dispatch";
    return "ignore";
  }
  // A card returned to the queue by the director's own release. Without this,
  // a note+release turn would only be picked up by the next continue clock.
  // A `to: "awaiting"` escalation is not a wake: the worker is parked and only
  // a human comment resumes the card (`task_resumed`).
  if (event === "task_moved" && changes.from === "in_progress" && changes.to === "todo") {
    return "dispatch";
  }
  if (isOwnWrite(activity, context)) return "ignore";
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
 * The timing mirrors `src/cli/watch-core.mjs#createWatchScheduler` in exactly
 * two expressions: the debounce cap
 * `min(debounceMs, firstPendingAt + maxWaitMs - now)` and the interval floor
 * `lastRunAt + minIntervalMs - now`. Fire times are identical, arm counts are
 * not: this one arms the debounce and re-arms at the floor in `pump()`, whereas
 * the watcher folds the floor into the same arm. The stop/retry semantics also
 * differ on purpose — this one drops pending work on `stop()` and retries a
 * skipped turn with `retryMs`. Do not merge the two state machines.
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
      log(`subscribe: dispatch failed: ${err.message}`, { level: "error" });
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

  // The directory the subscriber's own state file lives in; the briefs are the
  // hub's business now, not this process's.
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
    pidStart: processStartToken(process.pid),
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
  let firstTickDone = false;

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
          // The boot worked: the subscriber reached the hub. A later crash is
          // not a failed boot and is never delayed.
          if (!firstTickDone) {
            firstTickDone = true;
            deps.onFirstTick?.();
          }
        },
        onEvent: ({ id, data }) => {
          cursor = advanceCursor(cursor, { id });
          state.lastEventAt = new Date(now()).toISOString();
          state.lastEventId = cursor;
          flushState(false);
          // TP-0125 — a card that left its claim cycle has an orphaned turn in
          // the pool. The marker is written **unconditionally**: `classify` is
          // only consulted while dispatch is enabled, and `isOwnWrite` would
          // suppress the loop's own cancellation — both would leave a turn
          // running after its card stopped being claimed. It is written before
          // `scheduler.notify()` so the continue turn sees it; a write failure
          // is a debug line, never a broken event stream.
          if (stateDir !== null && stateDir !== undefined && stateDir !== "" && isInterruptActivity(data)) {
            const written = requestInterrupt(stateDir, {
              taskId: typeof data.task_id === "string" ? data.task_id : null,
              card: null,
              from: data.changes?.from ?? null,
              to: data.changes?.to ?? null,
              round: Number.isInteger(data.changes?.deliveryRound) ? data.changes.deliveryRound : null,
              reason: "claim-cycle exit",
              requestedBy: "subscribe",
              requestedAt:
                typeof data.created_at === "string" && data.created_at !== ""
                  ? data.created_at
                  : new Date(now()).toISOString(),
            });
            if (!written.ok) {
              log(`subscribe: could not write an interrupt request: ${written.error}`, { level: "debug" });
            }
          }
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
  return 0;
}

/** One subscriber process, owning SIGINT/SIGTERM. */
export async function runOnce(opts, env = process.env, deps = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runSubscribe(opts, env, { ...deps, controller });
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
export async function main(argv, env = process.env, io = {}) {
  const writeOut = io.out ?? ((text) => process.stdout.write(text));
  const writeErr = io.err ?? ((text) => process.stderr.write(text));
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (error) {
    writeErr(`subscribe: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    writeOut(USAGE);
    return 0;
  }
  if (selectMode(opts) !== "subscribe") {
    writeErr("subscribe: pass --subscribe (a daemon mode, not an --once entry)\n");
    return 2;
  }
  // The long-lived entry keeps the boot ledger: a start that never reaches the
  // hub is delayed before the service manager restarts it. It also declares its
  // lifetime to the crash guard: the CLI dispatches this entry, and its one-shot
  // stream rule must not exit 0 on a closed reader.
  const log = createLogger(opts);
  const boot = beginBootHealth({
    path: statePathsForDir(dirname(String(opts.state))).health,
    log,
    version: VERSION,
  });
  const unregisterLongLived = registerLongLivedEntry();
  try {
    const code = await runOnce(opts, env, { log, onFirstTick: boot.noteFirstTick });
    const { delayMs } = boot.settle(code);
    if (delayMs > 0) {
      // `settle` has already logged `crash_loop`; the sleep delays the restart.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return code;
  } catch (err) {
    // An escaped throw is a failed boot too; the dispatcher renders it after
    // the ladder's delay.
    const { delayMs } = boot.settle(1);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw err;
  } finally {
    unregisterLongLived();
  }
}

if (isEntryPoint(import.meta.url)) {
  installEntryCrashGuard("subscribe");
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
