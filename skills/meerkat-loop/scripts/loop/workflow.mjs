#!/usr/bin/env node
/**
 * The workflow entry — the loop's card-writing channel.
 *
 * Asks the board for the workflow plan (`issue reconcile --workflow`) and
 * applies its review actions. The board decides; this entry writes, attributed
 * to `taskd`. A review card is closed last so a crash mid-pass is recoverable.
 */

import { isEntryPoint } from "../foundation/entry-guard.mjs";

import { readProjectReviewers, runWorkflowPass } from "./board.mjs";
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
  const { config } = resolveLoopConfig(opts, env);

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
  if (!config.workflow) {
    if (config.reviewer !== null) {
      log(`warning: reviewer ${config.reviewer} is configured but workflow is off — no review card will be dispatched`);
    }
    return 0;
  }

  // `agent-only` forbids a human writer; auto-accept off forbids the loop, so a
  // review card would have no writer who may close it. This is not a state to
  // run in: refuse to start, rather than let the board's per-card alert be the
  // only signal.
  if (config.acceptancePolicy === "agent-only" && config.autoAcceptReviews === false) {
    log(
      "error: acceptance=agent-only with auto_accept_reviews=no — a human cannot close a review card " +
        "and this loop will not either. Set auto_accept_reviews=yes, or use acceptance=both.",
    );
    return 2;
  }

  // 0031 — `required` is a promise: a project that requires review must have an
  // effective reviewer. The board resolves `project.reviewer ?? global`; this
  // start-up read is the only place the loop can see the project rows before
  // the reconcile plan.
  const projectRead = readProjectReviewers(opts, log);
  const projects = projectRead.ok ? projectRead.projects : [];
  if (projectRead.ok) {
    const effectiveReviewer = (project) => {
      const override = typeof project.reviewer === "string" ? project.reviewer.trim() : "";
      return override !== "" ? override : config.reviewer;
    };
    const missing = projects.filter(
      (project) => project.review_policy === "required" && effectiveReviewer(project) === null,
    );
    if (missing.length > 0) {
      log(
        `error: ${missing.map((project) => project.id).join(", ")} require review but have no effective ` +
          "reviewer. Configure a deployment reviewer (--reviewer / MEERKAT_TASKPANEL_REVIEWER / " +
          "install.sh --reviewer), set the project's --reviewer, or change the project to optional/off.",
      );
      return 2;
    }
  }

  // Warn once per reviewer that is also a worker — the review lane and the work
  // lane share one identity. This covers the deployment reviewer and every
  // project override.
  const reviewers = new Set();
  if (config.reviewer !== null) reviewers.add(config.reviewer);
  for (const project of projects) {
    if (typeof project.reviewer === "string" && project.reviewer.trim() !== "") {
      reviewers.add(project.reviewer.trim());
    }
  }
  for (const reviewer of reviewers) {
    if (opts.agents.includes(reviewer)) {
      log(
        `warning: reviewer ${reviewer} is also a worker — the review lane and the work lane ` +
          "share one identity; a dedicated reviewer keeps the two apart",
      );
    }
  }
  if (config.acceptancePolicy === "human-only" && config.autoAcceptReviews === false) {
    log(
      "warning: acceptance=human-only with auto_accept_reviews=no — a human must close each review " +
        "card before accepting the original; with auto_accept_reviews=yes the loop closes the card " +
        "and the human only accepts.",
    );
  }

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
