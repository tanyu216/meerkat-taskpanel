/**
 * The one process-level crash boundary.
 *
 * A long-lived entry (the supervisor, the resident pool, the daemon, a
 * subscriber) has no caller to hand an escaped failure to. Without this module
 * an `uncaughtException` or an `unhandledRejection` is a silent death: the
 * process ends, nothing is recorded, and no lock, child or buffer is released.
 * Since P0 the epic (TP-0025) pins those shapes in
 * `test/orchestrator/resilience.test.mjs`; this is the S1 fix.
 *
 * The rule is **loud, bounded and clean — not swallowed**:
 *
 *   * exactly one `process_crash` record, at `error`, carrying the reason and
 *     the error;
 *   * `onFatal()` gets a chance to release locks, close children and flush;
 *   * the whole exit is bounded at {@link CRASH_FATAL_TIMEOUT_MS}, because a
 *     cleanup that hangs must not keep a dead process alive;
 *   * the exit code is 1, so a service manager restarts the process.
 *
 * A write to a closed pipe is the one failure that is not a crash: `| head`
 * closes the reader on purpose, and the next `process.stdout.write` would
 * otherwise end a working entry. `EPIPE` is swallowed; **any other** stream
 * error is re-thrown, exactly as it would be without a listener.
 *
 * `beforeExit` is deliberately not used: it never fires on an uncaught
 * exception and it is not an exit path.
 *
 * The module is installed only by a process entry point (see the five
 * `src/orchestrator/*.mjs` tails); importing it changes nothing.
 */

import { createLogger } from "./log.mjs";

/** How long `onFatal` gets before the process exits anyway. */
export const CRASH_FATAL_TIMEOUT_MS = 1500;

/** Installations already live, so a second call cannot double-report. */
const installed = new WeakSet();

/**
 * Entry-specific cleanup hooks, run inside the crash timebox.
 *
 * A long-lived entry is not always the process entry: `taskctl loop session`
 * starts through the CLI's dispatcher, so the CLI installs the one crash
 * boundary. The entry still needs its own last words (the boot ledger's failure
 * record and its restart delay), so it registers here instead of installing a
 * second boundary.
 */
const fatalHooks = new Set();

/**
 * @param {() => unknown} hook synchronous when it must delay the exit
 * @returns {() => void} the unregister
 */
export function registerFatalHook(hook) {
  if (typeof hook !== "function") return () => {};
  fatalHooks.add(hook);
  return () => fatalHooks.delete(hook);
}

/** The pipe-closed code: the reader asked for no more, so there is no failure. */
const EPIPE = "EPIPE";

/**
 * Install the crash boundary on a process-like emitter.
 *
 * @param {{
 *   name?: string,                       // entry name carried in the record
 *   log?: (record: object) => void,      // a `createLogger` value satisfies it
 *   onFatal?: () => unknown,             // release locks / close children / flush
 *   exit?: (code: number) => void,       // default `process.exit`
 *   timeoutMs?: number,                  // default {@link CRASH_FATAL_TIMEOUT_MS}
 *   target?: NodeJS.EventEmitter,        // the process object; injectable for tests
 *   streams?: NodeJS.EventEmitter[],     // streams whose EPIPE is swallowed
 * }} [options]
 * @returns {{uninstall: () => void}}
 */
export function installCrashGuard(options = {}) {
  const {
    name = "process",
    log = () => {},
    onFatal = null,
    exit = (code) => process.exit(code),
    timeoutMs = CRASH_FATAL_TIMEOUT_MS,
    target = process,
    streams = [process.stdout, process.stderr],
  } = options;

  if (installed.has(target)) return { uninstall: () => {} };
  installed.add(target);

  // One incident, one record, one exit — however many failure events arrive.
  let crashed = false;
  let exited = false;

  const finish = () => {
    if (exited) return;
    exited = true;
    exit(1);
  };

  const crash = (reason, error) => {
    if (crashed) return;
    crashed = true;
    try {
      log({
        event: "process_crash",
        level: "error",
        entry: name,
        pid: target.pid ?? null,
        reason,
        error,
      });
    } catch {
      /* The crash is the fact to report; a broken sink must not replace it. */
    }

    // The bound is the contract. It stays ref'd on purpose: an `onFatal` that
    // never settles (or resolves the process's last handle) must still be cut
    // off, so this timer is what keeps the exit guaranteed.
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    if (typeof onFatal !== "function") {
      clearTimeout(timer);
      finish();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      finish();
    };
    // A rejection or a throw from cleanup is already the crash being reported;
    // it must not escape a second time.
    Promise.resolve()
      .then(onFatal)
      .catch(() => {})
      .finally(done);
  };

  const onUncaught = (error, origin) =>
    crash(origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", error);
  const onRejection = (reason) => crash("unhandledRejection", reason);

  /**
   * A closed reader is not a failure; anything else is. Re-throwing turns it
   * into an uncaught exception, which is exactly the behaviour without the
   * listener — and then the crash boundary above owns it.
   */
  const onStreamError = (error) => {
    if (error?.code === EPIPE) return;
    throw error;
  };

  target.on("uncaughtException", onUncaught);
  target.on("unhandledRejection", onRejection);
  for (const stream of streams) {
    if (stream !== null && stream !== undefined && typeof stream.on === "function") {
      stream.on("error", onStreamError);
    }
  }

  return {
    uninstall() {
      target.removeListener("uncaughtException", onUncaught);
      target.removeListener("unhandledRejection", onRejection);
      for (const stream of streams) {
        if (stream !== null && stream !== undefined && typeof stream.removeListener === "function") {
          stream.removeListener("error", onStreamError);
        }
      }
      installed.delete(target);
    },
  };
}

/**
 * Install the boundary on this process with the tree's one logger.
 *
 * The five loop entry points all want the same record in the same place
 * (stderr, where the service manager looks), so the destination is named once
 * here rather than five times; an entry that needs a file sink can call
 * {@link installCrashGuard} directly.
 *
 * @param {string} name the entry name carried in the `process_crash` record
 * @returns {{uninstall: () => void}}
 */
export function installEntryCrashGuard(name) {
  // `debug` is the construction threshold, not the record's severity: it turns
  // on the logger's stack rendering, and the one record this logger ever writes
  // is an explicit `error` anyway. A crash is the case where the stack is not
  // optional (the same rule `taskd`'s `startup_failed` follows).
  const log = createLogger({ component: name, level: "debug" });
  return installCrashGuard({
    name,
    log,
    onFatal: () => {
      try {
        for (const hook of [...fatalHooks]) {
          // One broken cleanup must not rob the others of their last words.
          try {
            hook();
          } catch {
            /* the crash is already the fact being reported */
          }
        }
      } finally {
        log.close();
      }
    },
  });
}
