#!/usr/bin/env node
/**
 * The workflow entry — the loop's only writing channel.
 *
 * One pass: `issue reconcile` (container start/close), the review outcomes
 * (apply a reviewer's `VERDICT:` report to the card it audits), then review
 * dispatch. Every write is attributed to `system`; the state machine, not this
 * entry, is what refuses an illegal move. A review card is closed last, so a
 * crash between the original's move and the card's close is recovered on the
 * next pass.
 *
 * Off with `--workflow=no`; dispatch needs `--reviewer`; and
 * `--auto-accept-reviews=no` leaves a review card in `in_review` for a human
 * while still applying the verdict to the original.
 *
 * Node builtins only; no network, no dependencies.
 */

import { isEntryPoint } from "../../src/shared/entry-guard.mjs";

import { readBoard, runWorkflowPass } from "./board.mjs";
import { parseArgs, resolveLoopConfig, USAGE } from "./options.mjs";
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
      `review_aging=${Math.round(config.reviewAgingMs / 60_000)}m`,
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

  const read = readBoard(opts, log);
  if (!read.ok) return 1;
  const result = await runWorkflowPass(opts, config, log, {
    tasks: read.data.tasks ?? [],
    boardTruncated: read.truncated === true,
  });
  return result?.failed > 0 ? 1 : 0;
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
    process.stderr.write(`workflow: ${err.message}\n`);
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
