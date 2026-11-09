#!/usr/bin/env node
/**
 * The external scheduler — the loop's two clocks.
 *
 *   * **ping** (60s) — prune worker pids that are gone and probe the board's
 *     `/health` for liveness (log-only; it never stops the board). No board API
 *     read, no LLM.
 *   * **continue** (600s) — run patrol → workflow → poll in-process; the
 *     runs `taskctl patrol|workflow|poll`, in that order.
 *
 * The installed units are one-shot (`--ping-only --once` / `--continue-only
 * --once`); daemon mode is for a hand-run supervisor. A bare `--once` runs the
 * legacy poll pass, so an old installed unit keeps discovering work.
 *
 * Usage:
 *   taskctl run --actor-kind claude --agent alice
 *   taskctl run --actor-kind claude --agent alice --ping-once
 *   taskctl run --actor-kind claude --agent alice --continue-once
 *   taskctl subscribe --actor-kind claude --agent alice
 *
 * Run with: taskctl run --help
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { installEntryCrashGuard, registerLongLivedEntry } from "../foundation/crash-guard.mjs";
import { VERSION } from "../foundation/constants.mjs";
import { readJsonFile, writeJsonFile } from "../foundation/daemon-state.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { statePathsForDir, STOP_DRAIN_MS } from "../foundation/loop-state.mjs";

import { beginBootHealth } from "./boot-health.mjs";
import * as passesEntry from "./passes.mjs";
import { runSession } from "./session.mjs";
import * as subscribeEntry from "./subscribe.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { availableKinds, isKindAvailable } from "./platforms.mjs";
import { loadRoles } from "../foundation/roles.mjs";
import { describeRolePlatforms } from "../foundation/role-platforms.mjs";
import { runContinueOnce } from "./runners.mjs";
import {
  boardProbeUrl,
  createLogger,
  drainInFlight,
  isProcessAlive,
  killWedgedPool,
  loadRegistry,
  probeBoardHealth,
  runPingTick,
  saveRegistry,
} from "./runtime.mjs";

/**
 * One ping pass. A write failure is the only failure this clock can have; the
 * registry read is fail-soft by construction.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string, meta?: object) => void} log
 * @returns {Promise<number>} exit code
 */
async function runPingOnce(opts, env, log) {
  try {
    if (!opts.dryRun && !existsSync(opts.state)) {
      log("ping: registry missing — nothing to prune");
    }
    const registry = opts.dryRun ? { version: 1, running: {} } : loadRegistry(opts.state);
    runPingTick({
      registry,
      isAlive: isProcessAlive,
      save: (next) => saveRegistry(opts.state, next),
      dryRun: opts.dryRun,
      log,
    });
    // The ping is the loop's only kill authority: a pool whose event loop is
    // blocked cannot run an in-process timer, and every other timer may only
    // observe. The decision, its grace and the once-per-wedge marker live in
    // `wedgeKillAction`/`killWedgedPool`; the ping owns the marker file.
    if (!opts.dryRun) {
      const { config } = resolveLoopConfig(opts, env);
      const paths = statePathsForDir(dirname(opts.sessionState));
      if (config.recoverWedged) {
        killWedgedPool({
          state: readJsonFile(opts.sessionState),
          marker: readJsonFile(paths.poolWedge),
          isAlive: isProcessAlive,
          saveMarker: (marker) => writeJsonFile(paths.poolWedge, marker),
          log,
        });
      }
      // Board liveness, from the outside. This is observability only — the
      // probe has no kill path, because a board that answers slowly is not a
      // board the ping may stop (single writer + data safety).
      await probeBoardHealth({
        url: boardProbeUrl({ opts, env }),
        state: readJsonFile(paths.boardHealth),
        save: (record) => {
          mkdirSync(dirname(paths.boardHealth), { recursive: true });
          writeJsonFile(paths.boardHealth, record);
        },
        log,
      });
    }
    return 0;
  } catch (err) {
    log(`ping error: ${err.message}`, { level: "error" });
    return 1;
  }
}

/**
 * The daemon: ping and continue on their own clocks.
 *
 * `hooks` is the in-process test seam (signal, exit, the continue runner and the
 * drain bound). Production passes nothing: the process's own SIGTERM handler
 * exits 0 after the drain.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string, meta?: object) => void} log
 * @param {{signal?: AbortSignal, exit?: (code: number) => void, runContinue?: () => Promise<unknown>, drainMs?: number, onFirstTick?: () => void}} [hooks]
 * @returns {Promise<number>}
 */
export async function runDaemon(opts, env, log, hooks = {}) {
  const { continueEnabled } = resolveLoopConfig(opts, env);
  const exit = typeof hooks.exit === "function" ? hooks.exit : (code) => process.exit(code);
  const runContinue =
    typeof hooks.runContinue === "function" ? hooks.runContinue : () => runContinueOnce(opts, env);
  const drainMs = Number.isFinite(hooks.drainMs) && hooks.drainMs >= 0 ? hooks.drainMs : STOP_DRAIN_MS;
  log(
    `scheduler: ping every ${opts.pingInterval}s; continue every ${opts.continueInterval}s ` +
      `(${continueEnabled ? "enabled" : "disabled"})${opts.dryRun ? " (dry-run)" : ""}`,
  );

  let firstTickDone = false;
  const ping = () => {
    // The probe is awaited inside the pass; the timer only needs to know the
    // tick happened, and its own failure is already logged by `runPingOnce`.
    runPingOnce(opts, env, log)
      .catch((err) => log(`ping error: ${err.message}`, { level: "error" }))
      .finally(() => {
        // The daemon ran: a later crash is not a failed boot and is never delayed.
        if (!firstTickDone) {
          firstTickDone = true;
          hooks.onFirstTick?.();
        }
      });
  };
  // The liveness clock runs immediately; the judgment clock waits one cadence,
  // mirroring the units' RunAtLoad=false.
  ping();
  const pingTimer = setInterval(ping, Math.max(1, opts.pingInterval) * 1000);

  let stopping = false;
  let inFlight = null;
  let continueTimer = null;
  if (continueEnabled) {
    continueTimer = setInterval(() => {
      // A signalled daemon accepts no new tick; the one already running is
      // drained (bounded) by the shutdown below.
      if (stopping || inFlight !== null) return;
      inFlight = runContinue()
        .catch((err) => log(`continue error: ${err.message}`, { level: "error" }))
        .finally(() => {
          inFlight = null;
        });
    }, Math.max(1, opts.continueInterval) * 1000);
  }

  let shutdownPromise = null;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      stopping = true;
      clearInterval(pingTimer);
      if (continueTimer !== null) clearInterval(continueTimer);
      const drained = await drainInFlight(inFlight, drainMs);
      if (!drained) {
        log(`scheduler: an in-flight continue outlived ${drainMs}ms — exiting anyway`, {
          level: "warn",
          event: "shutdown_drain_timeout",
        });
      }
      log("scheduler: stopped");
      exit(0);
      return 0;
    })());

  const signal = hooks.signal ?? null;
  if (signal !== null) {
    if (signal.aborted) await shutdown();
    else signal.addEventListener("abort", () => void shutdown(), { once: true });
    if (!signal.aborted) {
      await new Promise((resolveAbort) => signal.addEventListener("abort", resolveAbort, { once: true }));
    }
    await shutdown();
    return 0;
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Daemon mode never resolves: the scheduler is a timer holder until signalled.
  return await new Promise(() => {});
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
    writeErr(`supervisor: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    writeOut(USAGE);
    return 0;
  }

  // Dispatch honesty: a role is only sent to a kind whose CLI can start. Every
  // mode that builds handoffs resolves roles against this probe; tests that call
  // the passes directly get the deterministic "installed means available" default.
  opts.kindAvailable ??= (kind) => isKindAvailable(kind, { env });

  let mode;
  try {
    mode = selectMode(opts);
  } catch (error) {
    writeErr(`supervisor: ${error.message}\n`);
    return 2;
  }

  const log = createLogger(opts);

  // One startup line per discovered role: installation location is the routing,
  // and a role stranded on a kind whose CLI cannot start must be visible before
  // its cards strand, not after.
  if (mode === "continue" || mode === "session" || mode === null) {
    try {
      const roleSet = loadRoles({
        home: typeof opts.home === "string" ? opts.home : null,
        primaryKind: opts.actorKind,
        kindOrder: opts.kindOrder,
        explicitDir: opts.rolesDir ?? null,
      });
      const lines = describeRolePlatforms(roleSet.roles, {
        primaryKind: opts.actorKind,
        order: opts.kindOrder,
        available: availableKinds({ env }),
      });
      log(lines.length > 0 ? `roles: ${lines.join("; ")}` : "roles: none discovered");
      if (roleSet.roles.length > 0 && roleSet.decisionPolicy?.path == null) {
        log(
          "roles: no meerkat-director skill found on any agent kind — decision rows fall back to the built-in summary",
          { level: "warning" },
        );
      }
    } catch (err) {
      log(`roles: discovery failed (${err instanceof Error ? err.message : String(err)})`, { level: "warning" });
    }
  }

  // The resident shapes: a session, a subscriber or the two-clock daemon. They
  // keep the boot ledger (a start that never completes a first tick is delayed
  // before the service manager restarts it), and they declare themselves to the
  // crash guard, because the CLI's one-shot stream rule must not exit 0 on a
  // closed reader. The one-shot clocks exit on every tick and need neither.
  const longLived = mode === "session" || mode === "subscribe" || mode === null;
  const boot =
    opts.dryRun !== true && longLived
      ? beginBootHealth({
          path: statePathsForDir(dirname(String(opts.state))).health,
          log,
          version: VERSION,
        })
      : null;
  const unregisterLongLived = longLived ? registerLongLivedEntry() : null;
  const finish = async (code) => {
    if (boot === null) return code;
    const { delayMs } = boot.settle(code);
    if (delayMs > 0) {
      // `settle` has already logged `crash_loop`; the sleep is what turns the
      // record into a slower restart.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return code;
  };
  const onFirstTick = boot === null ? undefined : boot.noteFirstTick;

  try {
    switch (mode) {
      case "ping":
        return runPingOnce(opts, env, log);
      case "continue":
        return runContinueOnce(opts, env);
      case "patrol":
        return passesEntry.runPatrolOnce(opts, env);
      case "poll":
        // Only a bare `--once` reaches this branch; the new units never use it.
        log("mode: bare --once runs the legacy poll pass; new units use --ping-only/--continue-only");
        return passesEntry.runPollOnce(opts, env);
      case "subscribe":
        return await finish(await subscribeEntry.runOnce(opts, env, { log, onFirstTick }));
      case "session": {
        // The resident pool is long-lived. A signal closes it cleanly; the
        // service manager is responsible for restarting the process.
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGTERM", abort);
        process.once("SIGINT", abort);
        return await finish(await runSession(opts, { log, signal: controller.signal, onFirstTick }));
      }
      default:
        return await finish(await runDaemon(opts, env, log, { onFirstTick }));
    }
  } catch (err) {
    // An escaped throw is a failed boot too. The dispatcher will render it and
    // exit; the ladder's delay still happens first, where it can.
    if (boot !== null) {
      const { delayMs } = boot.settle(1);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw err;
  } finally {
    // The marker lives through the boot ledger's delay: until `main` settles
    // this process is still a long-lived entry, and a closed reader must not
    // turn it into a silent exit 0 on the way out.
    unregisterLongLived?.();
  }
}

if (isEntryPoint(import.meta.url)) {
  // An escaped rejection from `main()` used to be an unlogged death: one crash
  // record, a bounded cleanup and exit 1 instead.
  installEntryCrashGuard("supervisor");
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
