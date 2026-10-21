#!/usr/bin/env node
/**
 * The patrol entry — the notify-only half of the loop.
 *
 * Reads the board once, emits the heartbeat alerts and the SLA rows, and
 * notifies. No alert moves a card; no LLM turn starts unless `--patrol-llm=yes`.
 * `--patrol-interval` is a measurement unit, not how often this runs.
 */

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

import { readBoard, runSlaPass } from "./board.mjs";
import { runEntry } from "./entry.mjs";
import { resolveLoopConfig } from "./options.mjs";
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

  const sla = await runSlaPass(opts, log, opts.patrolInterval);
  // A failed SLA read is a failed pass: the alternative is a patrol that looks
  // quiet because it never asked. The legacy heartbeat alerts above already ran.
  return sla.ok ? 0 : 1;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export function main(argv, env = process.env) {
  return runEntry("patrol", argv, env, runOnce);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
