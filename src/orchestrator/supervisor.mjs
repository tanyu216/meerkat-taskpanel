#!/usr/bin/env node
/**
 * The external scheduler — the loop's two clocks.
 *
 *   * **ping** (60s) — prune worker pids that are gone. No board read, no LLM.
 *   * **continue** (600s) — run patrol → workflow → poll in-process; the
 *     runs `taskctl loop patrol|workflow|poll`, in that order.
 *
 * The installed units are one-shot (`--ping-only --once` / `--continue-only
 * --once`); daemon mode is for a hand-run supervisor. A bare `--once` runs the
 * legacy poll pass, so an old installed unit keeps discovering work.
 *
 * Usage:
 *   taskctl loop run --actor-kind claude --agent alice
 *   taskctl loop run --actor-kind claude --agent alice --ping-once
 *   taskctl loop run --actor-kind claude --agent alice --continue-once
 *   taskctl loop subscribe --actor-kind claude --agent alice
 *
 * Run with: taskctl loop run --help
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { installEntryCrashGuard } from "../foundation/crash-guard.mjs";
import { readJsonFile, writeJsonFile } from "../foundation/daemon-state.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { statePathsForDir, STOP_DRAIN_MS } from "../foundation/loop-state.mjs";

import * as passesEntry from "./passes.mjs";
import { runSession } from "./session.mjs";
import * as subscribeEntry from "./subscribe.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { availableKinds, isKindAvailable } from "./platforms.mjs";
import { loadRoles } from "../foundation/roles.mjs";
import { describeRolePlatforms } from "../foundation/role-platforms.mjs";
import { runContinueOnce } from "./runners.mjs";
import {
  createLogger,
  drainInFlight,
  isProcessAlive,
  killWedgedPool,
  loadRegistry,
  runPingTick,
  saveRegistry,
} from "./runtime.mjs";

/**
 * One ping pass. A write failure is the only failure this clock can have; the
 * registry read is fail-soft by construction.
 *
 * @param {object} opts
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
function runPingOnce(opts, env, log) {
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
      if (config.recoverWedged) {
        const markerPath = statePathsForDir(dirname(opts.sessionState)).poolWedge;
        killWedgedPool({
          state: readJsonFile(opts.sessionState),
          marker: readJsonFile(markerPath),
          isAlive: isProcessAlive,
          saveMarker: (marker) => writeJsonFile(markerPath, marker),
          log,
        });
      }
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
 * @param {{signal?: AbortSignal, exit?: (code: number) => void, runContinue?: () => Promise<unknown>, drainMs?: number}} [hooks]
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

  const ping = () => {
    try {
      runPingOnce(opts, env, log);
    } catch (err) {
      log(`ping error: ${err.message}`, { level: "error" });
    }
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
      return subscribeEntry.runOnce(opts, env);
    case "session": {
      // The resident pool is long-lived. A signal closes it cleanly; the
      // service manager is responsible for restarting the process.
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGTERM", abort);
      process.once("SIGINT", abort);
      return runSession(opts, { log, signal: controller.signal });
    }
    default:
      return runDaemon(opts, env, log);
  }
}

if (isEntryPoint(import.meta.url)) {
  // An escaped rejection from `main()` used to be an unlogged death: one crash
  // record, a bounded cleanup and exit 1 instead.
  installEntryCrashGuard("supervisor");
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
