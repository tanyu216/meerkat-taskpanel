#!/usr/bin/env node
/**
 * The host-external scheduler — the loop's two clocks.
 *
 *   * **ping** (60s) — prune worker pids that are gone. No board read, no LLM.
 *   * **continue** (600s) — wake the host with a bounded 继续 prompt; that turn
 *     runs `scripts/loop/patrol.mjs`, `workflow.mjs`, `poll.mjs`, in that order.
 *
 * The installed units are one-shot (`--ping-only --once` / `--continue-only
 * --once`); daemon mode is for a hand-run supervisor. A bare `--once` runs the
 * legacy poll pass, so an old installed unit keeps discovering work.
 *
 * Usage:
 *   node scripts/supervisor.mjs --host claude --agent alice
 *   node scripts/supervisor.mjs --host claude --agent alice --ping-only --once
 *   node scripts/supervisor.mjs --host claude --agent alice --continue-only --once
 *   node scripts/supervisor.mjs --host claude --agent alice --subscribe
 *
 * Run with: node scripts/supervisor.mjs --help
 */

import { existsSync } from "node:fs";

import { isEntryPoint } from "../src/foundation/entry-guard.mjs";

import * as continueEntry from "./loop/continue.mjs";
import * as patrolEntry from "./loop/patrol.mjs";
import * as pollEntry from "./loop/poll.mjs";
import * as subscribeEntry from "./loop/subscribe.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./loop/options.mjs";
import { createLogger, isProcessAlive, loadRegistry, runPingTick, saveRegistry } from "./loop/runtime.mjs";

/**
 * One ping pass. A write failure is the only failure this clock can have; the
 * registry read is fail-soft by construction.
 *
 * @param {object} opts
 * @param {(line: string) => void} log
 * @returns {number} exit code
 */
function runPingOnce(opts, log) {
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
    return 0;
  } catch (err) {
    log(`ping error: ${err.message}`);
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
      runPingOnce(opts, log);
    } catch (err) {
      log(`ping error: ${err.message}`);
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
        await continueEntry.runOnce(opts, env);
      } catch (err) {
        log(`continue error: ${err.message}`);
      } finally {
        inFlight = false;
      }
    }, Math.max(1, opts.continueInterval) * 1000);
  }

  const shutdown = () => {
    clearInterval(pingTimer);
    if (continueTimer !== null) clearInterval(continueTimer);
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
export async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`supervisor: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let mode;
  try {
    mode = selectMode(opts);
  } catch (err) {
    process.stderr.write(`supervisor: ${err.message}\n`);
    return 2;
  }

  const log = createLogger(opts);
  if (opts.legacyPollInterval) {
    log("warning: --poll-interval is deprecated; use --ping-interval");
  }

  switch (mode) {
    case "ping":
      return runPingOnce(opts, log);
    case "continue":
      return continueEntry.runOnce(opts, env);
    case "patrol":
      return patrolEntry.runOnce(opts, env);
    case "poll":
      // Only a bare `--once` reaches this branch; the new units never use it.
      log("mode: bare --once runs the legacy poll pass; new units use --ping-only/--continue-only");
      return pollEntry.runOnce(opts, env);
    case "subscribe":
      return subscribeEntry.runOnce(opts, env);
    default:
      return runDaemon(opts, env, log);
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
