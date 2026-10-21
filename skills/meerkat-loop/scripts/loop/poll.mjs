#!/usr/bin/env node
/**
 * The poll entry — scan, atomically claim, wake one worker per accepted claim.
 *
 * An empty board scans nothing and spawns nothing; a refused claim never wakes
 * a worker. `--recover-stale` also offers stale `in_progress` claims.
 */

import { existsSync } from "node:fs";

import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { candidateArgs, pruneRegistry } from "../foundation/scheduling.mjs";

import { readProjectReviewers } from "./board.mjs";
import { runEntry } from "./entry.mjs";
import { mergeReviewerSets, resolveLoopConfig } from "./options.mjs";
import { runPollTick, spawnWorkerReal } from "./runners.mjs";
import {
  createLogger,
  isProcessAlive,
  loadRegistry,
  runCli,
  saveRegistry,
} from "./runtime.mjs";

/**
 * One poll pass.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { config } = resolveLoopConfig(opts, env);

  // 0031 — project-level reviewer overrides join the deployment reviewer in the
  // scan/wake set. A failed read falls back to the global reviewer (the board
  // itself still resolves the effective reviewer per card).
  const projectRead = readProjectReviewers(opts, log);
  const projectReviewers = projectRead.ok
    ? projectRead.projects
        .map((project) => project.reviewer)
        .filter((reviewer) => typeof reviewer === "string" && reviewer.trim() !== "")
    : [];
  const merged = mergeReviewerSets(opts, config, projectReviewers);
  config.reviewers = merged.reviewers;
  config.reviewerWorkers = merged.reviewerWorkers;
  const agents = merged.scanAgents;

  const registry = opts.dryRun
    ? { version: 1, running: {} }
    : pruneRegistry(loadRegistry(opts.state), isProcessAlive);

  const deps = {
    agents,
    registry,
    config,
    readCandidates: (agent, { claimUnassigned: pool }) => {
      const dedicatedReviewer =
        merged.reviewers.includes(agent) && !merged.reviewerWorkers.includes(agent);
      // A dedicated reviewer never takes the public pool, and only sees review
      // cards: handing it an ordinary card would be a self-review waiting to
      // happen.
      const read = runCli(
        opts,
        agent,
        candidateArgs(agent, dedicatedReviewer ? false : pool, config.recoverStale),
      );
      if (!read.ok) {
        log(`scan failed for ${agent}: ${read.error}`);
        return [];
      }
      const found = read.data.candidates ?? [];
      if (!dedicatedReviewer) return found;
      return found.filter((candidate) => typeof candidate.review_of === "string" && candidate.review_of !== "");
    },
    claim: (identifier, agent) => {
      if (opts.dryRun) return { ok: true };
      // `issue claim` is the one claim path: it handles a ready `todo` card and
      // the stale re-claim/takeover that the transition table cannot express.
      // The claim is the host's act, not a person's.
      const claimed = runCli(opts, agent, ["issue", "claim", identifier], { actorKind: opts.host });
      return claimed.ok ? { ok: true } : { ok: false, error: claimed.error };
    },
    spawnWorker: opts.dryRun ? async () => ({ ok: true, pid: null }) : spawnWorkerReal(opts, config, log),
    now: () => new Date().toISOString(),
    log,
  };

  // Say it up front, every tick: whether a wake can resolve a target directory.
  const gluePresent = opts.glue !== null && existsSync(opts.glue);
  const wakeForm = opts.wakeCommand === null ? `glue=${gluePresent ? opts.glue : "none"}` : `wake_command=${opts.wakeCommand}`;
  log(
    `tick: host=${opts.host} agents=${agents.join(",")} claim_unassigned=${config.claimUnassigned ? "yes" : "no"} ` +
      `recover_stale=${config.recoverStale ? "yes" : "no"} ` +
      `${wakeForm} projects_json=${opts.projectsJson}${opts.dryRun ? " (dry-run)" : ""}`,
  );
  if (!gluePresent && opts.wakeCommand === null && !opts.dryRun) {
    log(`warning: no wake glue at ${opts.glue} — workers will run in ${opts.repo} without a project target directory`);
  }

  const poll = await runPollTick(deps);
  if (!opts.dryRun) saveRegistry(opts.state, registry);
  log(`poll: ${poll.actions.length} action(s), ${poll.spawned} woke, ${poll.conflicts} refused, ${poll.failed} failed`);
  return poll.failed > 0 ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export function main(argv, env = process.env) {
  return runEntry("poll", argv, env, runOnce);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
