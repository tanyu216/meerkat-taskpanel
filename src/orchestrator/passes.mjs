#!/usr/bin/env node
/**
 * The loop's deterministic passes — the one entry the tick runs.
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

import { ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
import { resolveWakeDir, resolveWakeTarget } from "../foundation/project-dir.mjs";
import { reviewIdentityOf } from "../foundation/review-identity.mjs";
import { installEntryCrashGuard } from "../foundation/crash-guard.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { candidateArgs, pruneRegistry } from "../foundation/scheduling.mjs";

import {
  readBoard,
  readHandoffTriage,
  readOpenQuestions,
  readUnownedTodos,
  runSlaPass,
  runWorkflowPass,
} from "./board.mjs";
import { briefCards, openCardWatch, registerCardWatch, stopCardWatch } from "./card-watch.mjs";
import {
  createDeferralRecorder,
  deferralGate,
  pruneDeferrals,
  readDeferralLedger,
  writeDeferralLedger,
} from "./deferrals.mjs";
import { liveSubagents, readLedger } from "./ledger.mjs";
import { effectiveScanAgents, parseArgs, resolveLoopConfig, roleIsReviewer, roleIsWorker, USAGE } from "./options.mjs";
import { isKindAvailable } from "./platforms.mjs";
import { defaultReviewerAgent, loadRoles, selectWorkerRole } from "../foundation/roles.mjs";
import { enqueueCard, questionDispatches, readCards } from "./queue.mjs";
import { parseWorkerKey, readWorkerSessions } from "./worker-session.mjs";
import {
  createWorkspace,
  findWorkspace,
  isUsableWorkspaceRecord,
  listPreviousWorkspaces,
  probeRef,
  removeWorkspace,
  removeWorkspaceRecord,
  sweepWorkspaces,
  upsertWorkspaceRecord,
  WORKSPACE_CODES,
} from "./workspace.mjs";
import {
  buildHandoffRow,
  notifyNoResident,
  resolveRoleTarget,
  notifyReal,
  runPatrolTick,
  runPollTick,
  runQuestionTick,
} from "./runners.mjs";
import { syncRoleCatalog } from "./role-sync.mjs";
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
  poll       scan → atomic claim → enqueue the handoff for the session pool

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

/**
 * Where a card's handoff runs: its own worktree, the original's worktree (for a
 * review), or the project directory when the deployment opts out or the project
 * is not a git checkout.
 *
 * A worker in worktree mode never falls back to the shared tree: a failed
 * creation is a defer, because the whole point is that the tree is private.
 */
function prepareDispatchTarget({
  stateDir,
  workspaceMode,
  runGit,
  exists,
  mkdir,
  target,
  projectDir,
  card,
  identifier,
  log,
}) {
  if (typeof stateDir === "string" && typeof card?.review_of === "string" && card.review_of !== "") {
    const record = findWorkspace(stateDir, {
      identifier: card.review_of,
      round: card.review_round,
    });
    if (record !== null && isUsableWorkspaceRecord(record, { exists, projectDir })) {
      return { ok: true, targetDir: record.path, workspace: record, created: false };
    }
    if (record !== null) {
      // The reviewer would otherwise run in the shared checkout and could dirty
      // the tree acceptance merges into. Defer instead; the ledger escalates.
      return {
        ok: false,
        code: WORKSPACE_CODES.REVIEW_TARGET_MISSING,
        why:
          `${WORKSPACE_CODES.REVIEW_TARGET_MISSING}: the original workspace ` +
          `${record.path} is not a usable checkout`,
      };
    }
    log(`admission: review ${identifier} has no recorded workspace; running in ${projectDir}`);
    return { ok: true, targetDir: projectDir, workspace: null, created: false };
  }

  if (workspaceMode !== "worktree" || !isGitCheckout(projectDir)) {
    return { ok: true, targetDir: projectDir, workspace: null, created: false };
  }

  const round = Number(card?.delivery_round ?? 1);
  const existing = findWorkspace(stateDir, { identifier, round });
  let reuseExistingBranch = false;
  if (existing !== null) {
    if (isUsableWorkspaceRecord(existing, { exists, projectDir })) {
      return { ok: true, targetDir: existing.path, workspace: existing, created: false };
    }
    // The directory is gone or is not a checkout: drop the dead pointer and
    // re-attach the lane branch if it survived (prune + add without -b).
    log(`admission: ${identifier} r${round} workspace ${existing.path} is gone; dropping the record`);
    removeWorkspaceRecord(stateDir, { identifier, round });
    reuseExistingBranch = true;
  }

  // A rework continues from the most recent previous round whose branch still
  // exists — not simply the latest record, whose branch may be gone.
  let previousBranch = null;
  for (const previous of listPreviousWorkspaces(stateDir, { identifier, round })) {
    if (previous.project_dir && previous.project_dir !== projectDir) continue;
    const probe = probeRef({ projectDir, ref: previous.branch, run: runGit });
    if (probe.ok === true && probe.exists === true) {
      previousBranch = previous.branch;
      break;
    }
  }

  const created = createWorkspace({
    projectDir,
    entry: target.entry ?? null,
    project: target.project ?? card?.project ?? null,
    identifier,
    round,
    previousBranch,
    reuseExistingBranch,
    run: runGit,
    exists,
    mkdir,
    log,
  });
  if (created.ok !== true) {
    return { ok: false, why: `${created.code}: ${created.message}`, code: created.code };
  }
  upsertWorkspaceRecord(stateDir, created.workspace);
  return { ok: true, targetDir: created.workspace.path, workspace: created.workspace, created: true };
}

/** Undo a workspace this pass created but will not use. */
function discardWorkspace({ stateDir, workspace, runGit }) {
  if (workspace === null || workspace === undefined) return;
  const result = removeWorkspace({ workspace, run: runGit });
  if (result.worktreeRemoved) {
    removeWorkspaceRecord(stateDir, {
      identifier: workspace.identifier,
      round: workspace.round,
    });
  }
}

/**
 * The deferral recorder both admission sites share: the poll pass and the
 * patrol's LLM turn. The board write is the escalation itself — one note per
 * (streak, failure code), attributed to `Orchestrator`.
 */
function deferralRecorderFor(opts, stateDir, log) {
  return createDeferralRecorder({
    stateDir,
    dryRun: opts.dryRun === true,
    log,
    notify: opts.dryRun === true ? () => {} : notifyReal(opts, log),
    postComment: (ref, body) => {
      const posted = runCli(
        opts,
        ORCHESTRATOR_ACTOR_ID,
        ["comment", "add", ref, "--kind", "note", "--body", body],
        { actorKind: SYSTEM_KIND },
      );
      return posted.ok ? { ok: true } : { ok: false, error: posted.error };
    },
  });
}

export function createProjectAdmission(input) {
  const { opts, projectConcurrency, stateDir } = input;
  // A caller that supplies project maps counts by project; the older direct
  // callers still pass directory maps and keep the directory cap.
  const byProject = input.liveByProject !== undefined || input.queuedByProject !== undefined;
  const liveBy = byProject ? (input.liveByProject ?? new Map()) : (input.liveByDir ?? new Map());
  const queuedBy = byProject ? (input.queuedByProject ?? new Map()) : (input.queuedByDir ?? new Map());
  const workspaceMode = input.workspaceMode ?? "shared";
  const runGit = input.runGit;
  const exists = input.exists;
  const mkdir = input.mkdir;
  const watchCards = input.watchCards ?? ((cards) => registerCardWatch(opts, cards));
  const stopWatch = input.stopWatch ?? ((target) => stopCardWatch(opts, target));
  const log = input.log ?? (() => {});
  const admitted = new Map();
  const registrations = new Map();
  const claimedBy = new Map();
  const warnedCheckouts = new Set();
  const capacityKey = (project, dir) => (byProject ? project : dir);

  return {
    async admit(action, card) {
      const project = typeof card?.project === "string" ? card.project.trim() : "";
      if (project === "") {
        return {
          ok: false,
          why: "the card names no project",
          code: "ADMISSION_NO_PROJECT",
          accounted: true,
        };
      }
      const target = resolveWakeTarget({ project, projectsJson: opts.projectsJson });
      if (target.ok !== true) {
        const first = String(target.message ?? "").split("\n")[0];
        return { ok: false, why: `${target.code}: ${first}`, code: target.code, accounted: true };
      }
      const projectDir = target.dir;
      const key = capacityKey(project, projectDir);
      const used = (liveBy.get(key) ?? 0) + (queuedBy.get(key) ?? 0) + (claimedBy.get(key) ?? 0);
      if (used >= projectConcurrency) {
        return {
          ok: false,
          why: `project ${project} is at its concurrency cap`,
          code: "ADMISSION_CONCURRENCY_CAP",
          accounted: false,
        };
      }

      const identifier =
        typeof card?.identifier === "string" && card.identifier !== ""
          ? card.identifier
          : action.identifier;

      const prepared = prepareDispatchTarget({
        stateDir,
        workspaceMode,
        runGit,
        exists,
        mkdir,
        target,
        projectDir,
        project,
        card,
        identifier,
        log,
      });
      if (prepared.ok !== true) {
        return {
          ok: false,
          why: prepared.why,
          code: prepared.code ?? "ADMISSION_FAILED",
          accounted: true,
        };
      }
      const targetDir = prepared.targetDir;

      // Shared-tree mode is explicit now; keep the warning for a deployment
      // that has not switched to worktrees yet.
      if (
        prepared.workspace === null &&
        projectConcurrency > 1 &&
        isGitCheckout(projectDir) &&
        !warnedCheckouts.has(projectDir)
      ) {
        warnedCheckouts.add(projectDir);
        log(
          `admission: ${projectDir} is a shared git checkout; workers run in parallel — ` +
            "set --workspace=worktree to isolate them",
        );
      }

      // One registration covers the card and, for a review, its original; each
      // gets its own exact file in the same target directory. The hub writes
      // the first snapshot before this returns.
      const cards = opts.dryRun === true ? null : briefCards(targetDir, identifier, card?.review_of);
      if (cards !== null) {
        const watched = await watchCards(cards);
        if (watched?.ok !== true) {
          if (prepared.created) discardWorkspace({ stateDir, workspace: prepared.workspace, runGit });
          return {
            ok: false,
            why: `card brief watch failed: ${watched?.error ?? "unknown error"}`,
            code: "ADMISSION_BRIEF_WATCH_FAILED",
            accounted: true,
          };
        }
        if (watched.running === false) {
          // The hub wrote the final brief and opened no stream. Claiming would
          // leave a worker with nothing to keep fresh; the card is terminal.
          if (prepared.created) discardWorkspace({ stateDir, workspace: prepared.workspace, runGit });
          return {
            ok: false,
            why: `card is already terminal (${watched.reason ?? "terminal"})`,
            code: "ADMISSION_CARD_TERMINAL",
            accounted: false,
          };
        }
        // Only a registration this pass created may be released. A covered or
        // reused registration belongs to another owner; releasing it would
        // retire a brief someone else still depends on. Address the stop by a
        // card this registration actually holds, never by a covered one.
        if (watched.owned === true) {
          const registered = Array.isArray(watched.cards)
            ? watched.cards.find(
                (entry) => typeof entry?.ref === "string" && typeof entry?.path === "string",
              )
            : undefined;
          if (registered !== undefined) {
            registrations.set(action.identifier, { ref: registered.ref, out: registered.path });
          }
        }
      }

      admitted.set(action.identifier, {
        targetDir,
        projectDir,
        project,
        workspace: prepared.workspace,
        created: prepared.created,
      });
      claimedBy.set(key, (claimedBy.get(key) ?? 0) + 1);
      return { ok: true };
    },
    async release(identifier) {
      const registered = registrations.get(identifier);
      registrations.delete(identifier);
      const entry = admitted.get(identifier);
      admitted.delete(identifier);
      // Admission reserves the project slot before the claim; a refused claim
      // must give it back, or one conflict would shrink the pass's capacity.
      // A workspace this pass created is cleaned up too: nothing will run in it.
      if (entry !== undefined) {
        const key = capacityKey(entry.project, entry.projectDir);
        claimedBy.set(key, Math.max(0, (claimedBy.get(key) ?? 1) - 1));
        if (entry.created) {
          discardWorkspace({ stateDir, workspace: entry.workspace, runGit });
        }
      }
      // No owned registration (reused/covered, or none was made): nothing to
      // stop — the watch belongs to another owner.
      if (registered === undefined) return { ok: true, stopped: false };
      return stopWatch({ ref: registered.ref, out: registered.out });
    },
    dirFor(identifier) {
      return admitted.get(identifier)?.targetDir ?? null;
    },
    contextFor(identifier) {
      return admitted.get(identifier) ?? null;
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
    const context =
      typeof admission.contextFor === "function" ? admission.contextFor(action.identifier) : null;
    const dir = context?.targetDir ?? admission.dirFor(action.identifier);
    if (dir === null || dir === undefined) return { ok: false, error: "no admitted project directory" };
    // Roles and the decision policy resolve from the project checkout, not the
    // worktree: `.meerkat/roles/` lives at the project root.
    const projectDir = context?.projectDir ?? dir;
    const round = card?.delivery_round ?? card?.review_round ?? 1;
    const handoffRow = buildHandoffRow({ opts, config, action, card, projectDir, round, resident: true });
    const { role, agentRole, actorKind, platformFallback, roleWarnings, handoff, worker_key, executorReady } = handoffRow;
    if (!executorReady) {
      return {
        ok: false,
        error: `review card assignee ${action.agent} is not an installed reviewer-lane role; not dispatching ${action.identifier}`,
      };
    }
    for (const warning of roleWarnings) {
      if (loggedRoleWarnings.has(warning)) continue;
      loggedRoleWarnings.add(warning);
      log(`roles: ${warning}`);
    }
    if (platformFallback !== null) {
      const key = `${agentRole ?? action.agent}->${platformFallback}`;
      if (!loggedRoleWarnings.has(key)) {
        loggedRoleWarnings.add(key);
        log(`roles: ${agentRole ?? action.agent} runs on ${platformFallback} (its preferred kind is unavailable)`);
      }
    }
    if (actorKind === null) {
      const who = handoffRow.agent_role ?? action.agent;
      return {
        ok: false,
        error: `no available platform carries role ${who}; not dispatching ${action.identifier}`,
      };
    }
    const queued = enqueueCard(stateDir, {
      card: action.identifier,
      role,
      agent: action.agent,
      agent_role: agentRole,
      actor_kind: actorKind,
      project: card?.project ?? null,
      project_dir: projectDir,
      target_dir: dir,
      workspace: context?.workspace ?? null,
      round,
      worker_key,
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
 * card queue; a resident lane session (one per target directory) takes the
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
  const deferrals = deferralRecorderFor(opts, stateDir, log);
  // A card whose admission has failed a pattern of times is not re-offered on
  // every pass: the backoff is the counter's whole purpose.
  const deferralNow = Date.now();
  const deferralCards = readDeferralLedger(stateDir).value.cards;

  // Discovery is the routing: the scan set is every discovered worker-lane role,
  // plus the configured reviewers. A role installed on this kind sees its cards
  // without being listed anywhere; a writer identity with no role skill can
  // write but is never claimable.
  const roleSet = opts.roles ?? loadRoles({
    home: typeof opts.home === "string" ? opts.home : null,
    primaryKind: opts.actorKind,
    kindOrder: opts.kindOrder,
    explicitDir: opts.rolesDir ?? null,
  });
  const agents = effectiveScanAgents({ roleSet });
  // Publish the discovered set locally through `taskctl` — before the no-pool
  // return, so every poll (resident or not) keeps the catalog fresh. A failure is
  // logged and never blocks a claim: routing does not read this file.
  syncRoleCatalog({ opts, roleSet, log });
  // Dispatch honesty: a role whose carrying CLIs cannot start is not claimed.
  // The supervisor already sets this probe; a bare poll gets the same PATH probe.
  const kindAvailable = opts.kindAvailable ?? ((kind) => isKindAvailable(kind, { env }));

  const pool = poolStatus({ opts, isAlive: isProcessAlive });
  if (!pool.live) {
    log(`poll: skipped — no resident session pool (${pool.reason ?? "unknown"}); 0 cards claimed`);
    if (!opts.dryRun) notifyNoResident(opts, log, pool);
    return 0;
  }

  // A card parked on an unanswered question is a **dormant claim**, like
  // `awaiting`: no stale re-claim may put a second worker on it before the
  // director answers. The refs are read regardless of whether this pool can
  // enqueue question rows: an older pool still must not re-claim a parked card.
  const openQuestionRefs = new Set();
  // A dry run makes no claims, so it needs no filter and must not turn a read
  // failure into a different candidate list.
  let questionsKnown = opts.dryRun === true;

  // The question lane rides poll: a worker's unanswered question is handed to
  // the director lane before the subagent budget is consulted (a question is
  // not a subagent). The capability guard keeps an older pool from receiving
  // rows it would treat as handoffs.
  if (!opts.dryRun) {
    const open = readOpenQuestions(opts, log);
    if (open.ok) {
      questionsKnown = true;
      for (const row of open.rows) openQuestionRefs.add(String(row.ref));
      if ((pool.capabilities ?? []).includes("question-lane")) {
        const result = runQuestionTick({
          questions: open.rows,
          resolveDir: (project) => resolveWakeDir({ project, projectsJson: opts.projectsJson }),
          enqueue: (row) => enqueueCard(stateDir, row),
          dispatches: (questionId) => questionDispatches(stateDir, questionId),
          log,
        });
        if (result.enqueued > 0) {
          log(`questions: ${result.enqueued} open question(s) enqueued for the director`);
        }
      }
    } else {
      log(`questions: the open-question read failed (${open.error}) — stale in-progress claims are not offered this pass`);
    }
  }

  // The director's routing fallback: a `todo` card still unassigned past the
  // window. A dedicated reviewer never takes it; the row is a decision row, not
  // a handoff, so it consumes no worker slot.
  if (!opts.dryRun && (pool.capabilities ?? []).includes("question-lane")) {
    const routes = readUnownedTodos(opts, log);
    if (routes.ok && routes.rows.length > 0) {
      let routed = 0;
      for (const row of routes.rows) {
        const rowId = `route:${row.ref}`;
        if (questionDispatches(stateDir, rowId) >= 2) continue;
        const resolved = resolveWakeDir({ project: row.project, projectsJson: opts.projectsJson });
        if (resolved?.ok !== true) {
          log(`route ${row.ref}: ${resolved?.code ?? "no project directory"}`);
          continue;
        }
        const queued = enqueueCard(stateDir, {
          id: rowId,
          queue_kind: "question",
          role: "question",
          card: row.ref,
          project: row.project,
          // The director turn is the loop's own write, so its identity is the
          // writer, never the first discovered role the loop scans for.
          agent: opts.agents[0] ?? "agent",
          target_dir: resolved.dir,
          route: true,
          // The attempt cap reads the dispatch key; a route row has no
          // question, so its stable row id is the key. `question_id` stays as
          // the legacy spelling for a queue written by an earlier release.
          question_id: rowId,
          dispatch_key: rowId,
          title: row.title,
          updated_at: row.updated_at,
        });
        if (queued.ok && queued.coalesced !== true) routed += 1;
      }
      if (routed > 0) log(`route: ${routed} unowned card(s) enqueued for the director`);
    }
  }

  // The director's handoff triage: an accepted producer card whose required
  // handoff has no decision for the current delivery round. It is enqueued
  // after the worker questions and routes: a held worker must never wait behind
  // post-acceptance work.
  if (!opts.dryRun && (pool.capabilities ?? []).includes("question-lane")) {
    const triage = readHandoffTriage(opts, log);
    if (triage.ok && triage.rows.length > 0) {
      let enqueued = 0;
      for (const row of triage.rows) {
        const rowId = `triage:${row.ref}:r${row.round}`;
        if (questionDispatches(stateDir, rowId) >= 2) continue;
        const resolved = resolveWakeDir({
          project: row.project_id,
          projectsJson: opts.projectsJson,
        });
        if (resolved?.ok !== true) {
          log(`triage ${row.ref}: ${resolved?.code ?? "no project directory"}`);
          continue;
        }
        const queued = enqueueCard(stateDir, {
          id: rowId,
          queue_kind: "question",
          role: "triage",
          card: row.ref,
          project: row.project_id,
          // The director turn is the loop's own write, so its identity is the
          // writer, never the first discovered role the loop scans for.
          agent: opts.agents[0] ?? "agent",
          target_dir: resolved.dir,
          triage: true,
          question_id: rowId,
          dispatch_key: rowId,
          round: row.round,
          title: row.title,
          updated_at: row.updated_at,
        });
        if (queued.ok && queued.coalesced !== true) enqueued += 1;
      }
      if (enqueued > 0) log(`triage: ${enqueued} accepted handoff(s) enqueued for the director`);
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
  // A project's cards now run in separate worktrees, so the per-project cap is
  // counted by project, not by directory. A legacy ledger row without a project
  // falls back to its session key (the shared directory), which is exactly the
  // old behaviour.
  const countByProject = (rows) => {
    const counts = new Map();
    for (const row of rows) {
      const value = String(row?.project ?? row?.project_dir ?? row?.sessionKey ?? row?.target_dir ?? "");
      if (value !== "") counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  };
  const liveByProject = countByProject(live);
  const queuedByProject = countByProject(queued);
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
    stateDir,
    workspaceMode: opts.workspace ?? "worktree",
    liveByProject,
    queuedByProject,
    watchCards,
    stopWatch,
    log,
  });
  const dispatch = createQueueDispatch({ opts, config, stateDir, admission, log });

  // An unassigned card is claimed as the Worker role, explicitly. Taking the
  // scan order's first name would hand the public pool to whichever agent
  // happens to be scanned first.
  const defaultAgent = selectWorkerRole(roleSet)?.agent ?? null;

  // A worker holding for an answer still owns its card. If the director releases
  // during that turn, the poll would see a `todo` card and queue a second
  // resume; the pool's busy guard only defers it until the turn ends, when it
  // becomes a duplicate prompt. Skip the card while its worker session runs.
  const { workers } = readWorkerSessions(stateDir);
  const runningCards = new Set();
  for (const [key, record] of Object.entries(workers)) {
    if (String(record?.status ?? "") !== "running") continue;
    const parsed = parseWorkerKey(key);
    if (parsed !== null) runningCards.add(String(parsed.card));
  }

  const deps = {
    agents,
    registry,
    config,
    defaultAgent,
    readCandidates: (agent, { claimUnassigned: claimPool }) => {
      // A role that can review but cannot work never takes the public pool:
      // handing it an ordinary card would be a self-review waiting to happen.
      const dedicatedReviewer = roleIsReviewer(roleSet, agent) && !roleIsWorker(roleSet, agent);
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
      // A card parked on an unanswered question is not offered for a stale
      // re-claim: only the director's answer may move it forward. When the
      // question read failed, the state is unknown — fail closed for the risky
      // class (an `in_progress` stale claim) and keep `todo` cards claimable.
      const found = (read.data.candidates ?? []).filter((candidate) => {
        const ref = String(candidate.identifier ?? "");
        if (runningCards.has(ref)) return false;
        if (deferralGate(deferralCards[ref], deferralNow, candidate.version).blocked) return false;
        if (questionsKnown) return !openQuestionRefs.has(ref);
        return String(candidate.status ?? "") !== "in_progress";
      });
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
    // A card whose role has no available carrying kind must not be claimed: the
    // dispatch would refuse it and the card would sit `in_progress` until the
    // stale recovery. This uses the same role resolution dispatch uses.
    authorize: (action, card) => {
      const target = resolveRoleTarget(
        { ...opts, roles: roleSet, kindAvailable },
        config,
        action,
        card,
      );
      if (target.actorKind !== null) return { ok: true };
      return {
        ok: false,
        why: `role ${target.role?.agent ?? action.agent ?? "?"} is installed on no available kind`,
      };
    },
    admit: admission.admit,
    release: admission.release,
    recordDefer: (identifier, failure) => deferrals.record(identifier, failure),
    clearDeferral: (identifier) => deferrals.clear(identifier),
    // A claim that cannot be dispatched goes back to the queue instead of
    // sitting `in_progress` until the board's stale recovery finds it.
    moveBack: (identifier, agent) => {
      if (opts.dryRun) return { ok: true, dryRun: true };
      const moved = runCli(
        opts,
        agent,
        ["issue", "move", identifier, "todo", "--reason", "dispatch failed; the card returned to the queue"],
        { actorKind: opts.actorKind },
      );
      return moved.ok ? { ok: true } : { ok: false, error: moved.error };
    },
    // The execution-fault hold: a card the loop cannot advance is parked as a
    // human-owned decision, never auto-cancelled and never retried forever.
    holdCard: (identifier, { code, reason }) => {
      if (opts.dryRun) return { ok: true, dryRun: true };
      const blockedReason = code === "DISPATCH_FAILED" ? "resource" : "external";
      const body = [
        `The loop stopped dispatching this card after repeated \`${code}\` failures.`,
        "",
        String(reason ?? "").slice(0, 500),
        "",
        "It will not be retried automatically. Fix the cause, then move this card back to `todo` (or `in_progress`).",
      ].join("\n");
      const commented = runCli(
        opts,
        ORCHESTRATOR_ACTOR_ID,
        ["comment", "add", identifier, "--kind", "question", "--body", body],
        { actorKind: SYSTEM_KIND },
      );
      if (!commented.ok) log(`hold ${identifier}: comment failed: ${commented.error}`, { level: "warn" });
      const moved = runCli(
        opts,
        ORCHESTRATOR_ACTOR_ID,
        ["issue", "move", identifier, "blocked", "--blocked-reason", blockedReason, "--reason", "the loop stopped dispatching after repeated failures"],
        { actorKind: SYSTEM_KIND },
      );
      return moved.ok ? { ok: true } : { ok: false, error: moved.error };
    },
    limit: budget,
    verb: "enqueued",
    now: () => new Date().toISOString(),
    log,
  };

  log(
    `tick: kind=${opts.actorKind} agents=${agents.join(",")} claim_unassigned=${config.claimUnassigned ? "yes" : "no"} ` +
      `default_agent=${defaultAgent ?? "(scan order)"} ` +
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

  // Terminal cards' worktrees are removed here, not when a turn completes: the
  // reviewer may still need the tree after delivery. A path still named by a
  // queued row or a live subagent is left alone.
  const stateDir = dirname(String(opts.state));
  const deferrals = deferralRecorderFor(opts, stateDir, log);
  const busyPaths = new Set([
    ...readCards(stateDir)
      .value.cards.filter((card) => card.status === "pending" || card.status === "processing")
      .map((card) => card.target_dir),
    ...liveSubagents(readLedger(stateDir).value).map((row) => row.sessionKey),
  ]);
  if (opts.dryRun !== true) {
    sweepWorkspaces({
      stateDir,
      tasks,
      isBusy: (path) => busyPaths.has(path),
      entryFor: (project) => {
        const target = resolveWakeTarget({ project, projectsJson: opts.projectsJson });
        return target.ok === true ? (target.entry ?? null) : null;
      },
      log,
    });
    // A deferral entry is evidence, not a queue row: terminal cards and streaks
    // past retention are the only ones dropped. An unknown card is kept.
    const ledger = readDeferralLedger(stateDir);
    const pruned = pruneDeferrals(ledger.value, { tasks, nowMs: Date.now() });
    for (const drop of pruned.dropped) {
      log(`deferral: dropping ${drop.identifier} (${drop.why})`);
    }
    if (pruned.dropped.length > 0) writeDeferralLedger(stateDir, pruned.ledger);
  }

  // A stale patrol turn must not act on a card that is parked on an unanswered
  // question: the director is the only middle rung, and the worker will be
  // resumed by its answer. The read is made only when the LLM patrol is on.
  const openQuestionRefs = new Set();
  if (config.patrolLlm === true) {
    const open = readOpenQuestions(opts, log);
    if (open.ok) for (const row of open.rows) openQuestionRefs.add(String(row.ref));
  }

  const patrol = await runPatrolTick({
    tasks,
    config,
    spawnPatrol: async (alert) => {
      if (opts.dryRun) return { ok: false };
      if (openQuestionRefs.has(String(alert.identifier))) {
        log(
          `patrol: ${alert.identifier} — parked on an unanswered question; notify-only, no LLM turn`,
        );
        return { ok: false };
      }
      // The LLM lane needs a resident session to run in. Without one the
      // alert stays notify-only — no card is claimed, no process is started.
      const pool = poolStatus({ opts, isAlive: isProcessAlive });
      if (!pool.live) {
        log(`patrol: ${alert.identifier} — no resident session pool; notify-only, no LLM turn`);
        return { ok: false };
      }
      const task = tasks.find((entry) => entry.identifier === alert.identifier) ?? null;
      const project = typeof (task?.project_id ?? task?.project) === "string"
        ? String(task.project_id ?? task.project).trim()
        : "";
      if (project === "") {
        log(`patrol: ${alert.identifier} — the card names no project; notify-only, no LLM turn`);
        return { ok: false };
      }
      const target = resolveWakeTarget({ project, projectsJson: opts.projectsJson });
      if (target.ok !== true) {
        const first = String(target.message ?? "").split("\n")[0];
        log(`patrol: ${alert.identifier} — ${target.code}: ${first}; notify-only, no LLM turn`);
        return { ok: false };
      }
      const projectDir = target.dir;
      const action = { identifier: alert.identifier, agent: alert.agent ?? opts.agents[0] };
      const prepared = prepareDispatchTarget({
        stateDir,
        workspaceMode: opts.workspace ?? "worktree",
        target,
        projectDir,
        card: task,
        identifier: alert.identifier,
        log,
      });
      if (prepared.ok !== true) {
        // The patrol is the second admission site: count the same card-scoped
        // failure poll counts, or this lane retries silently forever.
        deferrals.record(alert.identifier, {
          code: prepared.code ?? "ADMISSION_FAILED",
          reason: prepared.why,
          round: Number(task?.delivery_round ?? 1),
        });
        log(`patrol: ${alert.identifier} — ${prepared.why}; notify-only, no LLM turn`);
        return { ok: false };
      }
      const targetDir = prepared.targetDir;

      // Same gate as poll: register the brief watch before the claim. The hub
      // writes the first snapshot synchronously, and a terminal card opens no
      // stream — that card is not claimed.
      const cards = briefCards(targetDir, alert.identifier, task?.review_of);
      // The registration to undo if the claim is refused, and only when this
      // pass created it; a covered/reused watch belongs to another owner. It is
      // addressed by a card the hub actually registered.
      let owned = null;
      if (opts.dryRun !== true) {
        const watched = await registerCardWatch(opts, cards, {
          owner: `${opts.actorKind}:${action.agent}`,
        });
        if (watched.ok !== true) {
          if (prepared.created) discardWorkspace({ stateDir, workspace: prepared.workspace });
          const reason =
            `card brief watch failed: ${watched.error ?? "unknown error"}`;
          deferrals.record(alert.identifier, {
            code: "ADMISSION_BRIEF_WATCH_FAILED",
            reason,
            round: Number(task?.delivery_round ?? 1),
          });
          log(`patrol: ${alert.identifier} — ${reason}; notify-only, no LLM turn`);
          return { ok: false };
        }
        if (watched.running === false) {
          // The hub wrote the final brief and opened no stream: terminal, not stuck.
          if (prepared.created) discardWorkspace({ stateDir, workspace: prepared.workspace });
          log(
            `patrol: ${alert.identifier} — card is already terminal ` +
              `(${watched.reason ?? "terminal"}); notify-only, no LLM turn`,
          );
          return { ok: false };
        }
        if (watched.owned === true) {
          const registered = Array.isArray(watched.cards)
            ? watched.cards.find(
                (entry) => typeof entry?.ref === "string" && typeof entry?.path === "string",
              )
            : undefined;
          if (registered !== undefined) owned = { ref: registered.ref, out: registered.path };
        }
      }

      const claimed = runCli(opts, action.agent, ["issue", "claim", alert.identifier], {
        actorKind: opts.actorKind,
      });
      if (!claimed.ok) {
        if (prepared.created) discardWorkspace({ stateDir, workspace: prepared.workspace });
        log(`patrol: claim refused ${alert.identifier} (${claimed.error ?? "conflict"}) — not dispatching`);
        if (owned !== null) await stopCardWatch(opts, owned);
        return { ok: false };
      }
      // Admission is proven: the card is no longer deferred.
      deferrals.clear(alert.identifier);
      const round = task?.delivery_round ?? 1;
      const { role, agentRole, handoff, worker_key, actorKind, executorReady } = buildHandoffRow({
        opts,
        config,
        action,
        card: task ?? { identifier: alert.identifier },
        projectDir,
        round,
      });
      if (!executorReady) {
        log(`patrol: ${alert.identifier} needs a reviewer-lane assignee; ${action.agent} is not one — not dispatching`);
        return { ok: false };
      }
      if (actorKind === null) {
        log(`patrol: no available platform carries ${action.agent}'s role — not dispatching ${alert.identifier}`);
        return { ok: false };
      }
      const identity = reviewIdentityOf(task);
      const queued = enqueueCard(stateDir, {
        card: alert.identifier,
        role,
        agent: action.agent,
        agent_role: agentRole,
        actor_kind: actorKind,
        project,
        project_dir: projectDir,
        target_dir: targetDir,
        workspace: prepared.workspace,
        round,
        worker_key,
        handoff,
        task_id: task?.id ?? null,
        review_of: identity.originalRef,
        review_round: identity.auditedRound,
      });
      if (!queued.ok) {
        log(`patrol: could not enqueue ${alert.identifier}: ${queued.error}`);
        return { ok: false };
      }
      log(`patrol: enqueued ${alert.identifier} for ${action.agent} in ${targetDir}`);
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
  // "Reviewer is also a worker" is a property of the discovered role, never of
  // the writer identity the unit happens to run as.
  const roleSet = opts.roles ?? loadRoles({
    home: typeof opts.home === "string" ? opts.home : null,
    primaryKind: opts.actorKind,
    kindOrder: opts.kindOrder,
    explicitDir: opts.rolesDir ?? null,
  });
  const defaultAssignee = defaultReviewerAgent(roleSet);
  const assigneeIsWorker = defaultAssignee !== null && roleIsWorker(roleSet, defaultAssignee);

  // The channel is the one that writes cards, so its policy is stated up
  // front: a deployment must never have to infer who reviews or who closes a
  // review card from a quiet board.
  log(
    `workflow: ${config.workflow ? "on" : "off"} ` +
      `assignee=${defaultAssignee === null ? "no reviewer-lane role" : `${defaultAssignee}${assigneeIsWorker ? " (also a worker)" : ""}`} ` +
      `max_actions=${config.maxActions} ` +
      `review_aging=${Math.round(config.reviewAgingMs / 60_000)}m`,
  );
  if (!config.workflow) {
    if (defaultAssignee !== null) {
      log(
        `warning: reviewer-lane role ${defaultAssignee} is installed but workflow is off — ` +
          "no review card will be dispatched",
      );
    }
    return 0;
  }
  if (defaultAssignee === null) {
    log(
      "warning: reviewer_role_unavailable — no installed reviewer-lane role; review-card dispatch is paused",
    );
  }
  config.assignee = defaultAssignee;

  // Warn once when the catalog default is also a worker — the review lane and
  // the work lane share one identity.
  if (defaultAssignee !== null && roleIsWorker(roleSet, defaultAssignee)) {
    log(
      `warning: reviewer ${defaultAssignee} is also a worker — the review lane and the work lane ` +
        "share one identity; a dedicated reviewer keeps the two apart",
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
  installEntryCrashGuard("passes");
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
