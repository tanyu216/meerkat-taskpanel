#!/usr/bin/env node
/**
 * The host-external **scheduler** — the loop Claude Code and Codex do not have.
 *
 * Claude Code and Codex only run when something opens a session; they have no
 * timers. This process owns the two clocks that keep a board moving:
 *
 *   * **ping** (default 60s) — process liveness only. It reads the worker
 *     registry and drops entries whose pid is gone. It never reads the board,
 *     claims a card or starts an LLM turn.
 *   * **continue** (default 600s / 10 minutes) — wake the host's headless agent
 *     with a bounded prompt that begins `继续`. That turn is where the loop's
 *     deterministic work happens: it runs `scripts/loop/patrol.mjs`,
 *     `scripts/loop/workflow.mjs` and `scripts/loop/poll.mjs`, in that order.
 *
 * The deterministic entries are **not** scheduled individually. This is
 * deliberate: poll/patrol/workflow are the loop skill's responsibilities, and
 * the continue turn is the one place that invokes them. The cost is a bounded
 * work-discovery latency (one continue cadence); the benefit is that the
 * scheduler stays a scheduler.
 *
 * The scheduling units installed by `install.sh` are two one-shot interval
 * units (`--ping-only --once` and `--continue-only --once`); daemon mode is
 * still available for a hand-run supervisor and owns both timers.
 *
 * A bare `--once` still runs the **legacy poll pass**. That is an upgrade
 * safety valve, not the new topology: an installed poll unit is only replaced
 * with `--force`, so the old unit must keep discovering work until the
 * installer's migration boots it out.
 *
 * The decision half lives in `src/shared/`; the I/O half lives in
 * `scripts/loop/`. This file is the dispatcher and the compatibility surface
 * (it re-exports everything the old monolithic supervisor exported).
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

import { isEntryPoint } from "../src/shared/entry-guard.mjs";

import * as continueEntry from "./loop/continue.mjs";
import * as patrolEntry from "./loop/patrol.mjs";
import * as pollEntry from "./loop/poll.mjs";
import * as subscribeEntry from "./loop/subscribe.mjs";
import { parseArgs, resolveLoopConfig, selectMode, USAGE } from "./loop/options.mjs";
import { createLogger, isProcessAlive, loadRegistry, runPingTick, saveRegistry } from "./loop/runtime.mjs";

// The compatibility surface. Existing callers (and the scheduling tests)
// import the decision functions and the runners from one place; the split must
// not change that.
export {
  buildContinuePrompt,
  buildHandoff,
  buildReviewHandoff,
  candidateArgs,
  planContinueInvocation,
  planPatrol,
  planTick,
  planWakeInvocation,
  pruneRegistry,
  quoteArg,
  resolveClaimUnassigned,
  resolveContinueEnabled,
  resolveIntervalSeconds,
  resolveRecoverStale,
  resolveWorkflowConfig,
  wakeCommand,
} from "../src/shared/scheduling.mjs";
export { planSlaPatrol } from "../src/shared/sla-patrol.mjs";
export {
  HOST_DIRS,
  buildScanAgents,
  defaultRepo,
  loopCommandArgs,
  parseArgs,
  resolveLoopConfig,
  selectMode,
} from "./loop/options.mjs";
export {
  acquireContinueLock,
  createLogger,
  isProcessAlive,
  loadContinueLock,
  loadRegistry,
  loadSlaLedger,
  readPeerLastOk,
  recordContinuePid,
  releaseContinueLock,
  runCli,
  runPingTick,
  saveLastOk,
  saveRegistry,
  saveSlaLedger,
} from "./loop/runtime.mjs";
export {
  notifyReal,
  runPatrolTick,
  runPollTick,
  runSlaPatrolTick,
  runWorkflowTick,
  spawnContinueTurn,
  spawnWorkerReal,
} from "./loop/runners.mjs";
export { createDispatchScheduler, runSubscribe } from "./loop/subscribe.mjs";
export {
  readBoard,
  readLiveCard,
  readReviewCards,
  readTrail,
  runSlaPass,
  runWorkflowPass,
} from "./loop/board.mjs";

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
async function main(argv, env = process.env) {
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
      // Only a bare `--once` reaches this branch; the explicit selectors are
      // handled above. Say so, because the new units never use it.
      log("mode: bare --once runs the legacy poll pass; new units use --ping-only/--continue-only");
      return pollEntry.runOnce(opts, env);
    case "subscribe":
      // A daemon alongside the two clocks: it holds one SSE connection and
      // asks for a continue turn when the board says something happened.
      return subscribeEntry.runOnce(opts, env);
    default:
      return runDaemon(opts, env, log);
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
