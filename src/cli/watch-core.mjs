/**
 * The card-brief refresh mechanics shared by `export watch` and the local event
 * hub.
 *
 * Nothing here knows about a board, a stream or a command: `watchPath` names the
 * file, `writeCardFile` replaces it atomically, and `createWatchScheduler`
 * coalesces a noisy event stream into serial refresh batches. Keeping the three
 * together is what lets the standalone watcher (its own SSE stream) and the hub
 * (one stream for the whole host) write byte-identical briefs with the same
 * cadence.
 *
 * Pure file I/O and timers only — no `src/core`, no transport.
 */

import { basename, join } from "node:path";

import {
  CARD_REFRESH_MIN_MS,
  EVENT_DEBOUNCE_MAX_MS,
  EVENT_DEBOUNCE_MS,
  EVENT_STREAM_LINE,
} from "../foundation/constants.mjs";
import { CARD_BRIEF_FILE, cardDirRel } from "../foundation/card-brief.mjs";
import { writeCardFileAtomic } from "../foundation/card-write.mjs";
import { DomainError } from "../foundation/errors.mjs";

/**
 * Default hard lifetime for a watch: two hours. A single card's work is not
 * expected to outlive it, and the bound is what keeps a vanished session from
 * leaving a registration behind forever. `--ttl 0` disables it.
 */
export const CARD_WATCH_TTL_MS = 120 * 60 * 1000;

/**
 * NDJSON line types for the watcher: the shared stream spellings plus the two
 * records this feature adds. Kept local (rather than in `foundation/constants`)
 * so the loop's generated payload does not change for a CLI-only vocabulary.
 */
export const WATCH_LINE = Object.freeze({
  OPEN: EVENT_STREAM_LINE.OPEN,
  REFRESH: "refresh",
  IDLE: EVENT_STREAM_LINE.IDLE,
  SHUTDOWN: EVENT_STREAM_LINE.SHUTDOWN,
  EOF: EVENT_STREAM_LINE.EOF,
  ERROR: EVENT_STREAM_LINE.ERROR,
  /** Every watched card reached `done`; the watcher stopped itself. */
  DONE: "done",
  /** The `--ttl` bound expired; the watcher stopped itself. */
  TTL: "ttl",
});

/** The brief `export watch` keeps fresh: `<dir>/.meerkat/<identifier>/card.md`. */
export function watchPath(dir, identifier) {
  return join(dir, cardDirRel(identifier), CARD_BRIEF_FILE);
}

/**
 * Write the server's markdown over a card brief, atomically.
 *
 * The file discipline — unique temp, byte-identical skip, growth-guard
 * exemption — is documented once in `src/foundation/card-write.mjs`, shared
 * with the loop's exporter. This wrapper keeps the CLI's error contract: an
 * empty render is a `DomainError`, not a silent no-op.
 *
 * @param {string} file
 * @param {string} markdown
 * @returns {{path: string, changed: boolean}}
 */
export function writeCardFile(file, markdown) {
  if (typeof markdown !== "string" || markdown === "") {
    throw new DomainError("CLI_IO", {
      message: `export watch: the board rendered no card for ${basename(file)}`,
      details: { path: file },
    });
  }
  return writeCardFileAtomic({ file, content: markdown });
}

/**
 * Coalescing, strictly serial refresh queue.
 *
 * The timing mirrors the loop's subscriber (300 ms debounce, 2 s max wait,
 * `CARD_REFRESH_MIN_MS` floor), but the payload is the set of task ids that
 * changed. `notify()` never starts work synchronously; at most one `refresh()`
 * is in flight; `stop()` clears the timer, waits for the in-flight batch, then
 * force-drains whatever was pending (so an event seen just before EOF is not
 * lost).
 *
 * The shared contract with `scripts/loop/subscribe.mjs` is only two
 * expressions: the debounce cap
 * `min(debounceMs, firstPendingAt + maxWaitMs - now)` and the interval floor
 * `lastRunAt + minIntervalMs - now`. This scheduler folds the floor into the
 * same arm; the subscriber arms the debounce and re-arms at the floor in its
 * `pump()`. Fire times are identical, arm counts are not — both are
 * deliberate. Do not "fix" one to match the other; their stop/retry semantics
 * differ for the same reason.
 *
 * @param {{
 *   refresh: (batch: {taskIds: string[], all: boolean, revision: number|null}) => Promise<void>|void,
 *   now?: () => number,
 *   setTimer?: Function,
 *   clearTimer?: Function,
 *   debounceMs?: number,
 *   maxWaitMs?: number,
 *   minIntervalMs?: number,
 * }} input
 */
export function createWatchScheduler(input = {}) {
  const {
    refresh,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    debounceMs = EVENT_DEBOUNCE_MS,
    maxWaitMs = EVENT_DEBOUNCE_MAX_MS,
    minIntervalMs = CARD_REFRESH_MIN_MS,
  } = input;

  const pending = new Set();
  let all = false;
  let revision = null;
  let timer = null;
  let firstPendingAt = null;
  let lastRunAt = null;
  let running = null;
  let stopped = false;
  let stopping = null;

  const hasPending = () => all || pending.size > 0;
  const clear = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const take = () => {
    const batch = { taskIds: [...pending], all, revision };
    pending.clear();
    all = false;
    revision = null;
    firstPendingAt = null;
    return batch;
  };
  const execute = async () => {
    const batch = take();
    try {
      await refresh(batch);
    } catch {
      // refresh() reports per card; this is a belt-and-braces backstop.
    } finally {
      lastRunAt = now();
    }
  };
  const arm = (delay) => {
    clear();
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, Math.max(0, delay));
    if (typeof timer?.unref === "function") timer.unref();
  };
  const schedule = () => {
    if (stopped || !hasPending()) return;
    const at = now();
    if (firstPendingAt === null) firstPendingAt = at;
    let delay = Math.min(debounceMs, firstPendingAt + maxWaitMs - at);
    if (lastRunAt !== null) delay = Math.max(delay, lastRunAt + minIntervalMs - at);
    arm(delay);
  };
  async function pump() {
    if (running !== null) return; // the in-flight finally reschedules
    if (!hasPending()) return;
    if (lastRunAt !== null && now() < lastRunAt + minIntervalMs) {
      schedule();
      return;
    }
    running = execute().finally(() => {
      running = null;
      if (!stopped && hasPending()) schedule();
    });
    await running;
  }

  return {
    /** `taskId === null` means a task-less event: refresh every watched card. */
    notify(taskId, atRevision = null) {
      if (stopped) return;
      if (taskId === null || taskId === undefined) all = true;
      else pending.add(String(taskId));
      if (Number.isInteger(atRevision)) {
        revision = revision === null ? atRevision : Math.max(revision, atRevision);
      }
      schedule();
    },
    async stop() {
      if (stopping !== null) return stopping;
      stopped = true;
      clear();
      stopping = (async () => {
        if (running !== null) await running.catch(() => {});
        if (hasPending()) await execute();
      })();
      return stopping;
    },
    get pending() {
      return hasPending();
    },
    get running() {
      return running !== null;
    },
  };
}
