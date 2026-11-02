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

import { installEntryCrashGuard } from "../foundation/crash-guard.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";

import * as passesEntry from "./passes.mjs";
import { poolStatus, runSession } from "./session.mjs";
import * as subscribeEntry from "./subscribe.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./options.mjs";
import { availableKinds, isKindAvailable } from "./platforms.mjs";
import { loadRoles } from "../foundation/roles.mjs";
import { describeRolePlatforms } from "../foundation/role-platforms.mjs";
import { runContinueOnce } from "./runners.mjs";
import {
  createLogger,
  isProcessAlive,
  loadRegistry,
  recoverWedgedPool,
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
    // The liveness clock is also the pool's watchdog: a live pid whose tick has
    // outlived twice the turn timeout is stopped, and the unit restarts it.
    if (!opts.dryRun) {
      const { config } = resolveLoopConfig(opts, env);
      if (config.recoverWedged) {
        recoverWedgedPool({ pool: poolStatus({ opts, isAlive: isProcessAlive }), log });
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
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {(line: string) => void} log
 * @returns {Promise<number>}
 */
async function runDaemon(opts, env, log) {
  const { continueEnabled } = resolveLoopConfig(opts, env);
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

  let continueTimer = null;
  if (continueEnabled) {
    let inFlight = false;
    continueTimer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await runContinueOnce(opts, env);
      } catch (err) {
        log(`continue error: ${err.message}`, { level: "error" });
      } finally {
        inFlight = false;
      }
    }, Math.max(1, opts.continueInterval) * 1000);
  }

  const shutdown = () => {
    clearInterval(pingTimer);
    if (continueTimer !== null) clearInterval(continueTimer);
    log("scheduler: stopped");
    process.exit(0);
  };
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
        explicitDir: opts.rolesDir ?? null,
      });
      const lines = describeRolePlatforms(roleSet.roles, {
        primaryKind: opts.actorKind,
        available: availableKinds({ env }),
      });
      log(lines.length > 0 ? `roles: ${lines.join("; ")}` : "roles: none discovered");
      if (roleSet.roles.length > 0 && roleSet.decisionPolicy?.path == null) {
        log(
          "roles: no meerkat-director decision policy found on the primary kind — decision rows fall back to the built-in summary",
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
