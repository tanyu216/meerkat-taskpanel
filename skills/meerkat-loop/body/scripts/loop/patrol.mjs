#!/usr/bin/env node
/**
 * The patrol entry — the notify-only half of the loop.
 *
 * It reads the board once, runs the legacy heartbeat alerts and the shared SLA
 * rows, and notifies. No alert moves a card, and no LLM turn starts unless
 * `--patrol-llm=yes` explicitly asks for one. The workflow entry is what
 * writes; it is a separate pass on purpose.
 *
 * The SLA thresholds are measured in 300-second units (`--patrol-interval`).
 * That is a measurement unit, not a promise of sampling frequency: the
 * continue turn decides how often this entry actually runs.
 *
 * Node builtins only; no network, no dependencies.
 */

import { isEntryPoint } from "../../src/shared/entry-guard.mjs";

import { readBoard, runSlaPass } from "./board.mjs";
import { parseArgs, resolveLoopConfig, USAGE } from "./options.mjs";
import { notifyReal, runPatrolTick, spawnWorkerReal } from "./runners.mjs";
import { createLogger } from "./runtime.mjs";

/**
 * One patrol pass.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { config } = resolveLoopConfig(opts, env);

  // The two SLA settings a deployment has to get right are stated up front: a
  // mis-set leader identity silently changes which events count as "the leader
  // acted", and a missing peer marker silently disables half a contract.
  log(
    `sla: leader=${opts.slaLeader === null ? "board-authority(author_kind=human)" : opts.slaLeader} ` +
      `last_ok=${opts.slaLastOk} peer=${opts.slaPeer === null ? "not configured (dependency registered)" : opts.slaPeer}`,
  );

  const read = readBoard(opts, log);
  if (!read.ok) return 1;
  const tasks = read.data.tasks ?? [];

  const patrol = await runPatrolTick({
    tasks,
    config,
    spawnPatrol: async (alert) => {
      if (opts.dryRun) return { ok: false };
      const card = { identifier: alert.identifier };
      return spawnWorkerReal(opts, config, log)(
        { identifier: alert.identifier, agent: alert.agent ?? opts.agents[0] },
        card,
      );
    },
    notify: opts.dryRun ? () => {} : notifyReal(opts, log),
    now: () => new Date().toISOString(),
    log,
  });
  log(`patrol: ${patrol.alerts.length} alert(s), ${patrol.spawns} LLM turn(s)`);

  await runSlaPass(opts, log, tasks, opts.patrolInterval, {
    boardTruncated: read.truncated === true,
  });
  return 0;
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
    process.stderr.write(`patrol: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  return runOnce(opts, env);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
