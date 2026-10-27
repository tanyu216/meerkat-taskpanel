#!/usr/bin/env node
/**
 * The loop's deterministic passes — the one entry the continue turn runs.
 *
 *   taskctl loop patrol      notify-only SLA; never moves a card
 *   taskctl loop workflow    apply the board's workflow plan
 *   taskctl loop poll        scan → atomic claim → enqueue the handoff
 *
 * They are one file because they share one contract: parse the same flags, then
 * run one pass. The order (`patrol → workflow → poll`) belongs to the continue
 * prompt, not to this dispatcher: a review card dispatched in the workflow pass
 * must be claimable by the poll pass in the same turn.
 *
 * Each `run*Once` is exported for the tests; the process entry is `main`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveWakeDir } from "../foundation/project-dir.mjs";
import { reviewIdentityOf } from "../foundation/review-identity.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { candidateArgs, pruneRegistry } from "../foundation/scheduling.mjs";

import {
  readBoard,
  readOpenQuestions,
  readProjectReviewers,
  runSlaPass,
  runWorkflowPass,
} from "./board.mjs";
import { briefCards, openCardWatch, registerCardWatch, stopCardWatch } from "./card-watch.mjs";
import { liveSubagents, readLedger } from "./ledger.mjs";
import { mergeReviewerSets, parseArgs, resolveLoopConfig, USAGE } from "./options.mjs";
import { enqueueCard, questionDispatches, readCards } from "./queue.mjs";
import {
  notifyNoResident,
  notifyReal,
  runPatrolTick,
  runPollTick,
  runQuestionTick,
  wakeHandoff,
} from "./runners.mjs";
import {
  createLogger,
  isProcessAlive,
  loadRegistry,
  runCli,
  saveRegistry,
} from "./runtime.mjs";
import { poolStatus } from "./session.mjs";

const PASS_USAGE = `Usage: taskctl loop <patrol|workflow|poll> [options]

  patrol     the notify-only SLA pass; no alert moves a card
  workflow   apply the board's workflow plan (issue reconcile --workflow)
  poll       scan → atomic claim → enqueue the handoff for a project session

Options are the loop's shared flags; run \`taskctl loop run --help\` for the list.
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
 * Project admission for a poll claim.
 *
 * Resolves the candidate's `project` to a directory through the machine-local map
 * **before** the board is claimed, and enforces the per-project cap. A card whose
 * project is unmapped, names no directory, or has no free project slot is
 * deferred — it stays `todo`, where the next turn can offer it again.
 *
 * The brief is the gate: admission **registers the card with the hub before the
 * claim**. The hub writes the first snapshot synchronously, so a claimed card
 * still has a brief, and the registration keeps writing that file until the card
 * is `done` or `canceled` (no TTL). A registration that cannot be made, or a
 * card already terminal, defers the claim; a refused claim releases it again.
 *
 * @param {{
 *   opts: object,
 *   projectConcurrency: number,
 *   liveByDir?: Map<string, number>,
 *   queuedByDir?: Map<string, number>,
 *   watchCards?: (cards: Array<{ref: string, out: string}>) => Promise<{ok: boolean, running?: boolean, error?: string}>,
 *   stopWatch?: (target: {ref?: string|null, out?: string|null}) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} input
 * @returns {{
 *   admit: (action: object, card: object|undefined) => Promise<{ok: boolean, why?: string}>,
 *   release: (identifier: string) => Promise<unknown>,
 *   dirFor: (identifier: string) => string|null,
 * }}
 */
export function isGitCheckout(dir) {
  return existsSync(join(String(dir), ".git"));
}

export function createProjectAdmission(input) {
  const { opts, projectConcurrency } = input;
  const liveByDir = input.liveByDir ?? new Map();
  const queuedByDir = input.queuedByDir ?? new Map();
  const watchCards = input.watchCards ?? ((cards) => registerCardWatch(opts, cards));
  const stopWatch = input.stopWatch ?? ((target) => stopCardWatch(opts, target));
  const log = input.log ?? (() => {});
  const admittedDirs = new Map();
  const registrations = new Map();
  const claimedByDir = new Map();
  const warnedCheckouts = new Set();

  return {
    async admit(action, card) {
      const project = typeof card?.project === "string" ? card.project.trim() : "";
      if (project === "") return { ok: false, why: "the card names no project" };
      const resolved = resolveWakeDir({ project, projectsJson: opts.projectsJson });
      if (resolved.ok !== true) {
        const first = String(resolved.message ?? "").split("\n")[0];
        return { ok: false, why: `${resolved.code}: ${first}` };
      }
      const used =
        (liveByDir.get(resolved.dir) ?? 0) +
        (queuedByDir.get(resolved.dir) ?? 0) +
        (claimedByDir.get(resolved.dir) ?? 0);
      if (used >= projectConcurrency) {
        return { ok: false, why: `project ${project} is at its concurrency cap` };
      }

      // Parallel cards share one working tree. That is a deployment convention
      // (one worktree per card), not something the loop creates or enforces.
      if (
        projectConcurrency > 1 &&
        isGitCheckout(resolved.dir) &&
        !warnedCheckouts.has(resolved.dir)
      ) {
        warnedCheckouts.add(resolved.dir);
        log(
          `admission: ${resolved.dir} is a shared git checkout; workers run in parallel — ` +
            "per-card worktrees are a deployment convention, not enforced",
        );
      }

      // One registration covers the card and, for a review, its original; each
      // gets its own exact file in the same target directory. The hub writes
      // the first snapshot before this returns.
      const identifier = typeof card?.identifier === "string" && card.identifier !== ""
        ? card.identifier
        : action.identifier;
      const cards = opts.dryRun === true ? null : briefCards(resolved.dir, identifier, card?.review_of);
      if (cards !== null) {
        const watched = await watchCards(cards);
        if (watched?.ok !== true) {
          return { ok: false, why: `card brief watch failed: ${watched?.error ?? "unknown error"}` };
        }
        if (watched.running === false) {
          // The hub wrote the final brief and opened no stream. Claiming would
          // leave a worker with nothing to keep fresh; the card is terminal.
          return { ok: false, why: `card is already terminal (${watched.reason ?? "terminal"})` };
        }
        registrations.set(action.identifier, { ref: cards[0].ref, out: cards[0].out });
      }

      admittedDirs.set(action.identifier, resolved.dir);
      claimedByDir.set(resolved.dir, (claimedByDir.get(resolved.dir) ?? 0) + 1);
      return { ok: true };
    },
    async release(identifier) {
      const registered = registrations.get(identifier);
      if (registered === undefined) return { ok: true, stopped: false };
      registrations.delete(identifier);
      const dir = admittedDirs.get(identifier);
      admittedDirs.delete(identifier);
      // Admission reserves the project slot before the claim; a refused claim
      // must give it back, or one conflict would shrink the pass's capacity.
      if (dir !== undefined) {
        claimedByDir.set(dir, Math.max(0, (claimedByDir.get(dir) ?? 1) - 1));
      }
      return stopWatch({ ref: registered.ref, out: registered.out });
    },
    dirFor(identifier) {
      return admittedDirs.get(identifier) ?? null;
    },
  };
}

/**
 * The resident dispatch: write one claimed card's handoff into the card queue.
 * The pool manager takes it from there; this process never starts an agent.
 *
 * @param {{
 *   opts: object,
 *   config: object,
 *   stateDir: string,
 *   admission: {dirFor: (id: string) => string|null},
 *   log?: (line: string) => void,
 * }} input
 * @returns {(action: object, card: object|undefined) => Promise<{ok: boolean, pid?: null, queued?: boolean, dryRun?: boolean, error?: string}>}
 */
export function createQueueDispatch(input) {
  const { opts, config, stateDir, admission } = input;
  const log = input.log ?? (() => {});
  const loggedRoleWarnings = new Set();
  return async (action, card) => {
    if (opts.dryRun) return { ok: true, pid: null, dryRun: true };
    const dir = admission.dirFor(action.identifier);
    if (dir === null) return { ok: false, error: "no admitted project directory" };
    const { role, agentRole, roleWarnings, handoff } = wakeHandoff(opts, config, action, card, {
      projectDir: dir,
    });
    for (const warning of roleWarnings) {
      if (loggedRoleWarnings.has(warning)) continue;
      loggedRoleWarnings.add(warning);
      log(`roles: ${warning}`);
    }
    const queued = enqueueCard(stateDir, {
      card: action.identifier,
      role,
      agent: action.agent,
      agent_role: agentRole,
      project: card?.project ?? null,
      target_dir: dir,
      handoff,
      // The subscriber maps an event's `task_id` (UUID) back to the card; the
      // identifier alone is not in the event. A review row also keeps its
      // original's brief fresh.
      task_id: card?.id ?? null,
      review_of: card?.review_of ?? null,
      review_round: card?.review_round ?? null,
    });
    if (!queued.ok) return { ok: false, error: queued.error };

    // No post-claim export: the claim itself is an event, and the registration
    // made before it refreshes the brief. One writer, one path.
    return { ok: true, pid: null, queued: !queued.coalesced };
  };
}

/**
 * One poll pass: scan, atomically claim, enqueue the handoff.
 *
 * **Poll never spawns.** It claims on the board and writes the handoff to the
 * card queue; a resident project session (one per target directory) takes the
 * handoff and spawns the worker/reviewer subagent in that directory. Without a
 * live pool there is nowhere to send the handoff, so this pass claims **nothing**
 * and alerts once — a claimed card that cannot run is worse than an untouched
 * one.
 *
 * An empty board scans nothing; a refused claim never enqueues. `--recover-stale`
 * also offers stale `in_progress` claims.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>} exit code
 */
export async function runPollOnce(opts, env = process.env) {
  const log = createLogger(opts);
  const { config } = resolveLoopConfig(opts, env);
  const stateDir = dirname(String(opts.state));

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

  const pool = poolStatus({ opts, isAlive: isProcessAlive });
  if (!pool.live) {
    log(`poll: skipped — no resident session pool (${pool.reason ?? "unknown"}); 0 cards claimed`);
    if (!opts.dryRun) notifyNoResident(opts, log, pool);
    return 0;
  }

  // The question lane rides poll: a worker's unanswered question is handed to
  // the project session before the subagent budget is consulted (a question is
  // not a subagent). The capability guard keeps an older pool from receiving
  // rows it would treat as handoffs.
  if (!opts.dryRun && (pool.capabilities ?? []).includes("question-lane")) {
    const open = readOpenQuestions(opts, log);
    if (open.ok) {
      const result = runQuestionTick({
        questions: open.rows,
        resolveDir: (project) => resolveWakeDir({ project, projectsJson: opts.projectsJson }),
        enqueue: (row) => enqueueCard(stateDir, row),
        dispatches: (questionId) => questionDispatches(stateDir, questionId),
        log,
      });
      if (result.enqueued > 0) {
        log(`questions: ${result.enqueued} open question(s) enqueued for the project session`);
      }
    }
  }

  const registry = opts.dryRun
    ? { version: 1, running: {} }
    : pruneRegistry(loadRegistry(opts.state), isProcessAlive);

  // The claim budget: what the pool can actually run. A live subagent and a
  // handoff already queued both occupy a slot, so neither is claimed twice. A
  // question row is a project-session turn, not a subagent, and is not counted.
  const live = liveSubagents(readLedger(stateDir).value);
  const queued = readCards(stateDir).value.cards.filter(
    (card) =>
      (card.status === "pending" || card.status === "processing") &&
      String(card.queue_kind ?? "handoff") === "handoff",
  );
  const maxConcurrency = Number(opts.maxConcurrency ?? 8);
  const projectConcurrency = Number(opts.projectConcurrency ?? maxConcurrency);
  const countBy = (rows, key) => {
    const counts = new Map();
    for (const row of rows) {
      const value = String(row?.[key] ?? "");
      if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };
  const liveByDir = countBy(live, "sessionKey");
  const queuedByDir = countBy(queued, "target_dir");
  const budget = Math.max(0, maxConcurrency - live.length - queued.length);
  if (budget === 0) {
    log(
      `poll: claim budget is 0 (${live.length} live subagent(s), ${queued.length} queued card(s), ` +
        `cap ${maxConcurrency}) — nothing claimed`,
    );
    return 0;
  }

  // One hub per poll pass: the first registration starts (or finds) it, and
  // every later card rides the same connection. A failed start is remembered
  // as a rejection for this pass, so each card defers instead of retrying a
  // broken spawn once per candidate.
  let hubPromise = null;
  const owner = `${opts.actorKind}:${agents[0] ?? "-"}`;
  const watchCards = async (cards) => {
    try {
      hubPromise ??= openCardWatch(opts, { env, log });
      const hub = await hubPromise;
      return await registerCardWatch(opts, cards, { hub, owner });
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  };
  const stopWatch = async (target) => {
    try {
      if (hubPromise === null) return { ok: true, stopped: false };
      const hub = await hubPromise;
      return await stopCardWatch(opts, target, { hub });
    } catch (err) {
      log(`watch-stop failed: ${err?.message ?? String(err)}`);
      return { ok: false, error: err?.message ?? String(err) };
    }
  };

  const admission = createProjectAdmission({
    opts,
    projectConcurrency,
    liveByDir,
    queuedByDir,
    watchCards,
    stopWatch,
    log,
  });
  const dispatch = createQueueDispatch({ opts, config, stateDir, admission, log });

  const deps = {
    agents,
    registry,
    config,
    readCandidates: (agent, { claimUnassigned: claimPool }) => {
      const dedicatedReviewer =
        merged.reviewers.includes(agent) && !merged.reviewerWorkers.includes(agent);
      // A dedicated reviewer never takes the public pool, and only sees review
      // cards: handing it an ordinary card would be a self-review waiting to
      // happen.
      const read = runCli(
        opts,
        agent,
        candidateArgs(agent, dedicatedReviewer ? false : claimPool, config.recoverStale),
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
      // The claim is the agent kind's act, not a person's.
      const claimed = runCli(opts, agent, ["issue", "claim", identifier], { actorKind: opts.actorKind });
      return claimed.ok ? { ok: true } : { ok: false, error: claimed.error };
    },
    dispatch,
    admit: admission.admit,
    release: admission.release,
    limit: budget,
    verb: "enqueued",
    now: () => new Date().toISOString(),
    log,
  };

  log(
    `tick: kind=${opts.actorKind} agents=${agents.join(",")} claim_unassigned=${config.claimUnassigned ? "yes" : "no"} ` +
      `recover_stale=${config.recoverStale ? "yes" : "no"} pool=resident ` +
      `budget=${budget} projects_json=${opts.projectsJson}${opts.dryRun ? " (dry-run)" : ""}`,
  );

  const poll = await runPollTick(deps);
  if (!opts.dryRun) saveRegistry(opts.state, registry);
  log(
    `poll: ${poll.actions.length} action(s), ${poll.spawned} enqueued, ${poll.deferred} deferred, ` +
      `${poll.conflicts} refused, ${poll.failed} failed`,
  );
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
      // The LLM lane needs a resident project session to run in. Without one the
      // alert stays notify-only — no card is claimed, no process is started.
      const pool = poolStatus({ opts, isAlive: isProcessAlive });
      if (!pool.live) {
        log(`patrol: ${alert.identifier} — no resident session pool; notify-only, no LLM turn`);
        return { ok: false };
      }
      const task = tasks.find((entry) => entry.identifier === alert.identifier) ?? null;
      const project = typeof task?.project === "string" ? task.project.trim() : "";
      if (project === "") {
        log(`patrol: ${alert.identifier} — the card names no project; notify-only, no LLM turn`);
        return { ok: false };
      }
      const resolved = resolveWakeDir({ project, projectsJson: opts.projectsJson });
      if (resolved.ok !== true) {
        const first = String(resolved.message ?? "").split("\n")[0];
        log(`patrol: ${alert.identifier} — ${resolved.code}: ${first}; notify-only, no LLM turn`);
        return { ok: false };
      }
      const action = { identifier: alert.identifier, agent: alert.agent ?? opts.agents[0] };

      // Same gate as poll: register the brief watch before the claim. The hub
      // writes the first snapshot synchronously, and a terminal card opens no
      // stream — that card is not claimed.
      const cards = briefCards(resolved.dir, alert.identifier, task?.review_of);
      if (opts.dryRun !== true) {
        const watched = await registerCardWatch(opts, cards, {
          owner: `${opts.actorKind}:${action.agent}`,
        });
        if (watched.ok !== true || watched.running === false) {
          log(
            `patrol: ${alert.identifier} — card brief watch failed: ` +
              `${watched.error ?? watched.reason ?? "unknown error"}; notify-only, no LLM turn`,
          );
          return { ok: false };
        }
      }

      const claimed = runCli(opts, action.agent, ["issue", "claim", alert.identifier], {
        actorKind: opts.actorKind,
      });
      if (!claimed.ok) {
        log(`patrol: claim refused ${alert.identifier} (${claimed.error ?? "conflict"}) — not dispatching`);
        if (opts.dryRun !== true) {
          await stopCardWatch(opts, { ref: cards[0].ref, out: cards[0].out });
        }
        return { ok: false };
      }
      const { role, handoff } = wakeHandoff(
        opts,
        config,
        action,
        task ?? { identifier: alert.identifier },
        { projectDir: resolved.dir },
      );
      const identity = reviewIdentityOf(task);
      const queued = enqueueCard(dirname(String(opts.state)), {
        card: alert.identifier,
        role,
        agent: action.agent,
        project,
        target_dir: resolved.dir,
        handoff,
        task_id: task?.id ?? null,
        review_of: identity.originalRef,
        review_round: identity.auditedRound,
      });
      if (!queued.ok) {
        log(`patrol: could not enqueue ${alert.identifier}: ${queued.error}`);
        return { ok: false };
      }
      log(`patrol: enqueued ${alert.identifier} for ${action.agent} in ${resolved.dir}`);
      return { ok: true };
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
      `max_actions=${config.maxActions} ` +
      `review_aging=${Math.round(config.reviewAgingMs / 60_000)}m`,
  );
  if (!config.workflow) {
    if (config.reviewer !== null) {
      log(`warning: reviewer ${config.reviewer} is configured but workflow is off — no review card will be dispatched`);
    }
    return 0;
  }

  // A project whose default is `agent` promises a review for every card it
  // creates, so it must have an effective reviewer. The board resolves
  // `project.reviewer ?? global`; this start-up read is the only place the loop
  // can see the project rows before the reconcile plan.
  const projectRead = readProjectReviewers(opts, log);
  const projects = projectRead.ok ? projectRead.projects : [];
  if (projectRead.ok) {
    const effectiveReviewer = (project) => {
      const override = typeof project.reviewer === "string" ? project.reviewer.trim() : "";
      return override !== "" ? override : config.reviewer;
    };
    const missing = projects.filter(
      (project) => project.acceptance === "agent" && effectiveReviewer(project) === null,
    );
    if (missing.length > 0) {
      log(
        `error: ${missing.map((project) => project.id).join(", ")} require review but have no effective ` +
          "reviewer. Configure a deployment reviewer (--reviewer / MEERKAT_TASKPANEL_REVIEWER / " +
          "install.sh --reviewer), set the project's --reviewer, or change --acceptance-mode per card.",
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
export function main(argv, env = process.env, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const [pass, ...rest] = argv;
  if (pass === undefined || pass === "--help" || pass === "-h") {
    out(PASS_USAGE);
    return Promise.resolve(0);
  }
  const run = PASSES[pass];
  if (run === undefined) {
    err(`passes: unknown pass ${JSON.stringify(pass)}\n${PASS_USAGE}`);
    return Promise.resolve(2);
  }
  return runEntry(pass, rest, env, run);
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
