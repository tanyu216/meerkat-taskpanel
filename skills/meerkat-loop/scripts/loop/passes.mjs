#!/usr/bin/env node
/**
 * The loop's deterministic passes — the one entry the continue turn runs.
 *
 *   node scripts/loop/passes.mjs patrol      notify-only SLA; never moves a card
 *   node scripts/loop/passes.mjs workflow    apply the board's workflow plan
 *   node scripts/loop/passes.mjs poll        scan → atomic claim → wake a worker
 *
 * They are one file because they share one contract: parse the same flags, then
 * run one pass. The order (`patrol → workflow → poll`) belongs to the continue
 * prompt, not to this dispatcher: a review card dispatched in the workflow pass
 * must be claimable by the poll pass in the same turn.
 *
 * Each `run*Once` is exported for the tests; the process entry is `main`.
 */

import { existsSync } from "node:fs";

import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { candidateArgs, pruneRegistry } from "../foundation/scheduling.mjs";

import { readBoard, readProjectReviewers, runSlaPass, runWorkflowPass } from "./board.mjs";
import { mergeReviewerSets, parseArgs, resolveLoopConfig, USAGE } from "./options.mjs";
import { notifyReal, runPatrolTick, runPollTick, spawnWorkerReal } from "./runners.mjs";
import {
  createLogger,
  isProcessAlive,
  loadRegistry,
  runCli,
  saveRegistry,
} from "./runtime.mjs";

const PASS_USAGE = `Usage: node scripts/loop/passes.mjs <patrol|workflow|poll> [options]

  patrol     the notify-only SLA pass; no alert moves a card
  workflow   apply the board's workflow plan (issue reconcile --workflow)
  poll       scan → atomic claim → wake one worker per accepted claim

Options are the loop's shared flags; run \`node scripts/supervisor.mjs --help\` for the list.
`;

/**
 * The shared CLI shell: parse, `--help`, then the pass.
 *
 * @param {string} name error prefix ("patrol", "workflow", "poll")
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {(opts: object, env: NodeJS.ProcessEnv) => Promise<number>|number} run
 * @param {((opts: object) => string|null)|null} [validate] a refusal message, or null
 * @returns {Promise<number>} exit code
 */
async function runEntry(name, argv, env, run, validate = null) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`${name}: ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (validate !== null) {
    const problem = validate(opts);
    if (problem !== null) {
      process.stderr.write(`${name}: ${problem}\n`);
      return 2;
    }
  }
  return run(opts, env);
}

/**
 * One poll pass: scan, atomically claim, wake one worker per accepted claim.
 *
 * An empty board scans nothing and spawns nothing; a refused claim never wakes
 * a worker. `--recover-stale` also offers stale `in_progress` claims.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runPollOnce(opts, env = process.env) {
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
 * One patrol pass: read the board once, emit heartbeat alerts and SLA rows,
 * notify. No alert moves a card; no LLM turn starts unless `--patrol-llm=yes`.
 * `--patrol-interval` is a measurement unit, not how often this runs.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runPatrolOnce(opts, env = process.env) {
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
 * One workflow pass: ask the board for the plan (`issue reconcile --workflow`)
 * and apply its review actions. The board decides; this pass writes, attributed
 * to `taskd`. A review card is closed last so a crash mid-pass is recoverable.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runWorkflowOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { config } = resolveLoopConfig(opts, env);
  const reviewerIsWorker = config.reviewer !== null && opts.agents.includes(config.reviewer);

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

const PASSES = Object.freeze({
  patrol: runPatrolOnce,
  workflow: runWorkflowOnce,
  poll: runPollOnce,
});

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
export function main(argv, env = process.env) {
  const [pass, ...rest] = argv;
  if (pass === undefined || pass === "--help" || pass === "-h") {
    process.stdout.write(PASS_USAGE);
    return Promise.resolve(0);
  }
  const run = PASSES[pass];
  if (run === undefined) {
    process.stderr.write(`passes: unknown pass ${JSON.stringify(pass)}\n${PASS_USAGE}`);
    return Promise.resolve(2);
  }
  return runEntry(pass, rest, env, run);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
