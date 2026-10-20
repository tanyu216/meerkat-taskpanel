#!/usr/bin/env node
/**
 * The workflow entry — the loop's card-writing channel.
 *
 * Asks the board for the workflow plan (`issue reconcile --workflow`) and
 * applies its review actions. The board decides; this entry writes, attributed
 * to `taskd`. A review card is closed last so a crash mid-pass is recoverable.
 */

import { isEntryPoint } from "../foundation/entry-guard.mjs";

import { runWorkflowPass } from "./board.mjs";
import { runEntry } from "./entry.mjs";
import { resolveLoopConfig } from "./options.mjs";
import { createLogger } from "./runtime.mjs";

/**
 * One workflow pass.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { config, reviewerIsWorker } = resolveLoopConfig(opts, env);

  // The channel is the one that writes cards, so its policy is stated up
  // front: a deployment must never have to infer who reviews or who closes a
  // review card from a quiet board.
  log(
    `workflow: ${config.workflow ? "on" : "off"} ` +
      `reviewer=${config.reviewer === null ? "not configured" : `${config.reviewer}${reviewerIsWorker ? " (also a worker)" : ""}`} ` +
      `auto_accept_reviews=${config.autoAcceptReviews ? "yes" : "no"} max_actions=${config.maxActions} ` +
      `review_aging=${Math.round(config.reviewAgingMs / 60_000)}m ` +
      // The board decides acceptance in the plan; this copy is printed so an
      // operator can see which policy the host *thinks* it is running under.
      `acceptance=${config.acceptancePolicy} (advisory)`,
  );
  if (config.workflow && config.reviewer !== null && reviewerIsWorker) {
    log(
      `warning: reviewer ${config.reviewer} is also a worker — the review lane and the work lane ` +
        "share one identity; a dedicated reviewer keeps the two apart",
    );
  }
  if (!config.workflow && config.reviewer !== null) {
    log(`warning: reviewer ${config.reviewer} is configured but workflow is off — no review card will be dispatched`);
  }

  if (!config.workflow) return 0;

  const result = await runWorkflowPass(opts, config, log);
  return result?.failed > 0 ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export function main(argv, env = process.env) {
  return runEntry("workflow", argv, env, runOnce);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
