#!/usr/bin/env node
/**
 * The loop's runners and process spawners.
 *
 * The runners take their side effects as dependencies, so a test can prove
 * "an empty scan spawns nothing" without a board.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildContinuePrompt,
  buildHandoff,
  buildReviewHandoff,
  planContinueInvocation,
  planPatrol,
  planTick,
  quoteArg,
} from "../foundation/scheduling.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  partitionSlaAlerts,
  recordSlaAlerts,
} from "../foundation/sla-patrol.mjs";
import { loadRoles, selectReviewerRole, selectRole } from "../foundation/roles.mjs";
import { agentPaths, loopCommandArgs, resolveLoopConfig } from "./options.mjs";
import { enqueueContinue } from "./queue.mjs";
import {
  acquireContinueLock,
  createLogger,
  isProcessAlive,
  openAppendFd,
  recordContinuePid,
  releaseContinueLock,
} from "./runtime.mjs";
import { poolStatus } from "./session.mjs";

/** Rows about the board, not one card — a single-card re-read cannot decide them. */
const BOARD_LEVEL_ROWS = new Set(["leader_stalled", "inspector_liveness"]);

/**
 * One poll pass.
 *
 * `dispatch` is the side effect of a successful claim. In the resident model it
 * writes the card queue (the project session spawns the subagent); the legacy
 * direct wake still spawns an agent process. `admit` and `limit` are the claim
 * budget: a card beyond the pool's capacity is deferred **before** it is
 * claimed, so the board never shows a claim that has nowhere to run.
 *
 * @param {{
 *   agents: string[],
 *   registry: object,
 *   config: object,
 *   readCandidates: (agent: string, opts: {claimUnassigned: boolean}) => Promise<object[]>,
 *   claim: (identifier: string, agent: string) => Promise<{ok: boolean, error?: string}>,
 *   spawnWorker: (action: object, card: object|undefined) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   dispatch?: (action: object, card: object|undefined) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   admit?: (action: object, card: object|undefined) => Promise<{ok: boolean, why?: string}>,
 *   release?: (identifier: string) => Promise<unknown>,
 *   limit?: number,
 *   verb?: string,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runPollTick(deps) {
  const {
    agents,
    registry,
    config,
    readCandidates,
    claim,
    spawnWorker,
    dispatch = spawnWorker,
    admit = null,
    release = null,
    limit = Number.POSITIVE_INFINITY,
    verb = "woke",
    now,
    log,
  } = deps;

  const candidates = [];
  for (const agent of agents) {
    const found = await readCandidates(agent, { claimUnassigned: config.claimUnassigned === true });
    for (const candidate of found ?? []) candidates.push({ ...candidate, agent: candidate.agent ?? agent });
  }

  const actions = planTick({ candidates, registry, config });
  const cardById = new Map();
  for (const candidate of candidates) cardById.set(String(candidate.identifier), candidate);

  let spawned = 0;
  let claimed = 0;
  let conflicts = 0;
  let failed = 0;
  let deferred = 0;

  for (const action of actions) {
    if (action.type === "skip") {
      log(`skip ${action.identifier} (${action.why})`);
      continue;
    }
    if (claimed >= limit) {
      deferred += 1;
      log(`defer ${action.identifier} (claim budget exhausted)`);
      continue;
    }

    const card = cardById.get(action.identifier);
    // The claim budget is checked **before** the claim: a card with no place to
    // run must stay `todo`, where the next turn can offer it again. Admission
    // registers the brief watch first; a terminal card is written once and
    // skipped, never claimed.
    const admitted = admit === null ? { ok: true } : await admit(action, card);
    if (admitted?.ok !== true) {
      deferred += 1;
      log(`defer ${action.identifier} (${admitted?.why ?? "not admitted"})`);
      continue;
    }

    // Atomic claim first: the board (not the supervisor) decides the winner.
    const verdict = await claim(action.identifier, action.agent);
    if (!verdict?.ok) {
      conflicts += 1;
      log(`claim refused ${action.identifier} (${verdict?.error ?? "conflict"}) — not dispatching`);
      // The registration must not outlive the claim it was made for: nothing
      // would ever move that card through this loop, so the watch would wait
      // forever for a terminal state.
      if (release !== null) await release(action.identifier);
      continue;
    }
    claimed += 1;

    const outcome = await dispatch(action, card);
    if (!outcome?.ok) {
      // Honest failure: a card we could not dispatch is not "running".
      failed += 1;
      log(`${verb} failed ${action.identifier}: ${outcome?.error ?? "unknown error"}`, {
        level: "error",
      });
      continue;
    }
    spawned += 1;
    if (outcome.pid !== undefined && outcome.pid !== null) {
      registry.running[action.identifier] = { agent: action.agent, pid: outcome.pid, startedAt: now() };
    }
    log(
      `${verb} ${action.identifier} for ${action.agent} (${action.reason})` +
        `${outcome.pid ? ` pid ${outcome.pid}` : ""}` +
        `${outcome.queued === true ? " [queued]" : ""}${outcome.dryRun === true ? " [dry-run]" : ""}`,
    );
  }

  return { actions, spawned, claimed, conflicts, failed, deferred };
}

/**
 * Enqueue one question-lane row per unanswered agent question.
 *
 * Poll calls this **before** its concurrency budget (a question is not a
 * subagent) and only when the resident pool advertises `question-lane`. It never
 * claims a card and never moves one: the project session answers the question
 * and moves the card. The attempt bound counts dispatches, so a broken turn is
 * retried twice and then left to the human.
 *
 * @param {{
 *   questions?: object[],
 *   resolveDir: (project: string) => {ok: boolean, dir?: string, code?: string},
 *   enqueue: (row: object) => {ok: boolean, coalesced?: boolean, error?: string},
 *   dispatches?: (questionId: string) => number,
 *   maxAttempts?: number,
 *   log?: (line: string) => void,
 * }} deps
 */
export function runQuestionTick(deps) {
  const {
    questions = [],
    resolveDir,
    enqueue,
    dispatches = () => 0,
    maxAttempts = 2,
    log = () => {},
  } = deps;
  let enqueued = 0;
  let skipped = 0;
  for (const question of questions) {
    if (dispatches(question.question_id) >= maxAttempts) {
      log(`question ${question.ref}: attempt cap reached — left for the human`);
      skipped += 1;
      continue;
    }
    const resolved = resolveDir(question.project);
    if (resolved?.ok !== true) {
      log(`question ${question.ref}: ${resolved?.code ?? "no project directory"}`);
      skipped += 1;
      continue;
    }
    const queued = enqueue({
      id: `question:${question.ref}:${question.question_id}`,
      queue_kind: "question",
      role: "question",
      card: question.ref,
      project: question.project,
      agent: question.agent,
      target_dir: resolved.dir,
      question_id: question.question_id,
      question: question.body,
      asked_at: question.asked_at,
    });
    if (queued?.ok !== true) {
      log(`question ${question.ref}: ${queued?.error ?? "enqueue failed"}`, { level: "warn" });
      skipped += 1;
      continue;
    }
    if (queued.coalesced === true) skipped += 1;
    else enqueued += 1;
  }
  return { ok: true, enqueued, skipped };
}

/**
 * One patrol pass. Alerts are logged and notified; the LLM stays off unless
 * `config.patrolLlm` is explicitly on.
 *
 * @param {{
 *   tasks: object[],
 *   config: object,
 *   spawnPatrol: (alert: object) => Promise<{ok: boolean}>,
 *   notify: (alert: object) => void,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runPatrolTick(deps) {
  const { tasks, config, spawnPatrol, notify, now, log } = deps;
  const alerts = planPatrol({ tasks, now: now() });

  let spawns = 0;
  for (const alert of alerts) {
    log(alert.type === "stale"
      ? `patrol: stale ${alert.identifier} (heartbeat ${Math.round(alert.ageMs / 60_000)}m old)`
      : `patrol: heartbeat-unreadable ${alert.identifier} (${alert.reason})`);
    notify(alert);
    if (config.patrolLlm === true && alert.type === "stale") {
      const outcome = await spawnPatrol(alert);
      if (outcome?.ok) spawns += 1;
    }
  }
  return { alerts, spawns };
}

/**
 * One SLA notification pass.
 *
 * The board computes the candidates (`GET /api/v1/sla`); this half owns the
 * order that must not move: drop already-notified keys → re-read the survivors
 * live (a card that just moved must not alert) → notify, *then* record.
 * Writing the ledger before the send would suppress an alert that was never
 * delivered. Nothing here writes a card or starts an LLM.
 *
 * The re-read is the board's own computation for one card (`taskctl sla get`),
 * so the rule that produced the alert and the rule that keeps it are the same
 * code — §9.6 asks for one decision rule, not a second restatement. The row is
 * matched by **`(card, row)`**, not `dedup_key`: a tier promotion during the
 * re-read keeps the row open and the next pass emits the new key.
 *
 * @param {{
 *   alerts: object[],
 *   ledger: object,
 *   recheck: (cardId: string) => Promise<{checked: boolean, alerts?: object[]}>,
 *   notify: (alert: object) => void,
 *   now: () => string,
 *   log: (line: string) => void,
 *   mechanism?: string,
 *   mechanismActor?: string|null,
 * }} deps
 */
export async function notifySlaAlerts(deps) {
  const { ledger, recheck, notify, now, log } = deps;
  const mechanism = deps.mechanism ?? MECHANISM;
  const mechanismActor = deps.mechanismActor ?? null;
  const stamp = now();
  // The board computed the rows; the *mechanism* that delivers them is this
  // loop. Stamp identity here so the ledger's `observed_by` and the peer's
  // view name the actual notifier, not the board.
  const alerts = (Array.isArray(deps.alerts) ? deps.alerts : []).map((alert) => ({
    ...alert,
    mechanism,
    mechanism_actor: mechanismActor,
  }));

  const { notify: fresh, suppressed } = partitionSlaAlerts(alerts, ledger);
  for (const alert of suppressed) {
    log(`patrol: sla ${alert.alert_id} (${alert.severity}) already notified — suppressed`);
  }

  const dropped = [];
  const survivors = [];
  for (const alert of fresh) {
    // A board-level row (`leader_stalled`, `inspector_liveness`) is not about
    // one card, so there is nothing a single-card read can decide — and asking
    // the provider for the sentinel would log a failure that is not one.
    // `leader_stalled` is anchored on a real card for display, but the row is
    // still board-level: re-reading that card cannot say whether the leader is
    // stalled. §9.6's second look is about *card* rows; these go straight
    // through, which is also what §9.3 requires when a re-check cannot run.
    if (alert.card_id === BOARD_CARD_ID || BOARD_LEVEL_ROWS.has(alert.sla_row)) {
      survivors.push(alert);
      continue;
    }
    const live = await recheck(alert.card_id);
    // A re-check that could not run must never be able to silence a real alert
    // (§9.3): an unverifiable card is notified, not dropped. Only a *successful*
    // read that no longer contains the row is grounds for a drop.
    if (live?.checked !== true || !Array.isArray(live.alerts)) {
      log(`patrol: re-check unavailable for ${alert.card_id} — notifying anyway`);
      survivors.push(alert);
      continue;
    }
    const stillOpen = live.alerts.some(
      (row) => row.card_id === alert.card_id && row.sla_row === alert.sla_row,
    );
    if (stillOpen) survivors.push(alert);
    else dropped.push({ card_id: alert.card_id, sla_row: alert.sla_row, reason: `recheck:${alert.sla_row}:not_open` });
  }
  for (const drop of dropped) {
    log(`patrol: dropped ${drop.card_id} ${drop.sla_row} (${drop.reason})`);
  }

  // Notify first, then record — and enrich the emitted tuple from the ledger so
  // `first_seen` / `last_seen` / `observed_by` have exactly one source.
  const nextLedger = recordSlaAlerts(ledger, survivors, stamp, suppressed);
  const sent = [];
  for (const alert of survivors) {
    const entry = nextLedger.seen[alert.dedup_key];
    const enriched = {
      ...alert,
      first_seen: entry?.first_seen ?? alert.first_seen,
      last_seen: entry?.last_seen ?? stamp,
      observed_by: entry?.observed_by ?? [alert.mechanism],
    };
    const hint = alert.releasable ? ` [releasable: ${alert.releasable_basis}]` : "";
    log(
      `patrol: sla ${alert.alert_id} (${alert.severity}, ${alert.elapsed_working_min}m of ` +
        `${alert.threshold_min}m, ${alert.measure_start_kind})${hint}`,
    );
    notify(enriched);
    sent.push(enriched);
  }

  return {
    alerts: sent,
    suppressed,
    dropped,
    ledger: nextLedger,
    mechanism: MECHANISM,
    // `LLM turns` is reported by the caller; this pass never starts one.
    spawns: 0,
  };
}

/**
 * One workflow pass — the loop's write channel.
 *
 * `deps.plan` is the `workflow` object from `issue reconcile --workflow`; no
 * write happens before it arrives. Actions run independently, one failure never
 * stops the rest, and the review card is closed last, so a crash between the
 * original's move and the card's close is recovered on the next pass.
 *
 * @param {{
 *   plan?: {alerts?: object[], actions?: object[], changes?: object[], summary?: object},
 *   config?: object,
 *   dryRun?: boolean,
 *   createReview?: (action: object) => Promise<{ok: boolean, ref?: string, error?: string}>,
 *   createFixChild?: (action: object) => Promise<{ok: boolean, ref?: string, error?: string}>,
 *   linkFixChild?: (epicRef: string, childRef: string) => Promise<{ok: boolean, error?: string}>,
 *   move?: (ref: string, to: string) => Promise<{ok: boolean, error?: string}>,
 *   comment?: (ref: string, input: {kind: string, body: string}) => Promise<{ok: boolean, error?: string}>,
 *   setMeta?: (ref: string, meta: Record<string, string>) => Promise<{ok: boolean, error?: string}>,
 *   notify?: (alert: object) => void,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runWorkflowTick(deps) {
  const {
    plan = { alerts: [], actions: [], changes: [], summary: {} },
    config = {},
    dryRun = false,
    ledger = null,
    now = () => new Date().toISOString(),
    createReview = null,
    createFixChild = null,
    linkFixChild = null,
    move = null,
    comment = null,
    setMeta = null,
    notify = () => {},
    log,
  } = deps;

  const baseLedger =
    ledger && typeof ledger === "object" && ledger.seen && typeof ledger.seen === "object"
      ? ledger
      : { version: 1, seen: {} };

  const disabled = {
    dryRun,
    actions: [],
    alerts: [],
    changes: [],
    executed: 0,
    failed: 0,
    skipped: 0,
    summary: { actions: 0, alerts: 0 },
    ledger: baseLedger,
  };
  if (config.workflow !== true) return disabled;

  const alerts = Array.isArray(plan.alerts) ? plan.alerts : [];
  const changes = Array.isArray(plan.changes) ? plan.changes : [];
  const actions = Array.isArray(plan.actions) ? plan.actions : [];

  // Workflow findings are notified once per state, not once per tick. The
  // ledger has the same shape the SLA pass uses; `partitionSlaAlerts` /
  // `recordSlaAlerts` read only `dedup_key`, so they are mechanism-agnostic.
  let workingLedger = baseLedger;
  const notifyBatch = (batch) => {
    const { notify: fresh, suppressed } = partitionSlaAlerts(
      batch.map((alert) => ({
        ...alert,
        dedup_key: alert.dedup_key ?? alert.dedupKey,
        mechanism: alert.mechanism ?? "workflow",
      })),
      workingLedger,
    );
    for (const alert of fresh) notify(alert);
    workingLedger = recordSlaAlerts(workingLedger, fresh, now(), suppressed);
  };

  for (const alert of alerts) {
    log(`workflow: ${describeWorkflowAlert(alert)}`);
  }
  // Standing-state notices (no reviewer configured, a capped pass) would
  // otherwise re-notify on every pass forever. They are logged; only findings
  // an operator can act on are notified.
  notifyBatch(alerts.filter((alert) => WORKFLOW_NOTIFY_TYPES.has(alert.type)));
  for (const change of changes) {
    log(`workflow: reconcile ${change.action} ${change.epic} (${change.reason})`);
  }

  let executed = 0;
  let failed = 0;
  let skipped = 0;

  const step = async (fn, name, ...args) => {
    if (typeof fn !== "function") throw new Error(`${name} is not wired`);
    const result = await fn(...args);
    if (result?.ok === false) throw new Error(result.error ?? `${name} failed`);
    return result;
  };

  // Closing the review card is the last write of every outcome. A cancel is a
  // two-hop move when the card is `in_review`: the state machine has no direct
  // `in_review → canceled` edge. `close_review` still ends `done`, because that
  // is the only terminal an `in_review` card can reach directly.
  const closeReviewCard = async (action, note) => {
    // 0038 — the loop always closes the review card it dispatched. `human` is a
    // card mode, not a "leave the review open" flag.
    // The board carries the status; the fallback keeps an older plan safe.
    const status =
      action.review_status ?? (action.type === "cancel_review" ? "canceled" : "in_review");
    if (status === "done" || status === "canceled") return;
    if (note !== null) await step(comment, "comment", action.review_ref, { kind: "note", body: note });
    if (status === "in_review") {
      if (action.type === "cancel_review") {
        await step(move, "move", action.review_ref, "in_progress");
        await step(move, "move", action.review_ref, "canceled");
        return;
      }
      await step(move, "move", action.review_ref, "done");
      return;
    }
    await step(move, "move", action.review_ref, "canceled");
  };

  for (const action of actions) {
    if (dryRun) {
      log(`workflow: would ${describeWorkflowAction(action)}`);
      continue;
    }
    try {
      switch (action.type) {
        case "create_review":
          await step(createReview, "create_review", action);
          break;

        // 0038 — the card's own `acceptance_mode` is `off`, so `taskd` may
        // complete it. The marker is written first so a crash between it and
        // the move is recoverable without a duplicate comment (`held`).
        case "auto_accept": {
          if (typeof action.accepted_by !== "string" || action.accepted_by === "") {
            throw new Error("auto_accept action is missing accepted_by");
          }
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, {
              accepted_by: action.accepted_by,
              accepted_round: String(action.round),
              auto_accepted: "1",
            });
            await step(comment, "comment", action.original_ref, {
              kind: "note",
              body: `Auto-accepted after delivery round ${action.round}: this card does not require review.`,
            });
          }
          await step(move, "move", action.original_ref, "done");
          break;
        }

        case "approve":
          if (typeof action.accepted_by !== "string" || action.accepted_by === "") {
            throw new Error("approve action is missing accepted_by");
          }
          await step(comment, "comment", action.original_ref, {
            kind: "note",
            body: `Loop acceptance after review ${action.review_ref} (round ${action.round}): VERDICT: APPROVE.`,
          });
          await step(setMeta, "setMeta", action.original_ref, {
            accepted_by: action.accepted_by,
            accepted_round: String(action.round),
          });
          await step(move, "move", action.original_ref, "done");
          await closeReviewCard(
            action,
            `Loop auto-accepted this review card after applying VERDICT: APPROVE to ${action.original_ref}.`,
          );
          break;

        case "reject_task": {
          const body = `VERDICT: REJECT (review ${action.review_ref}, round ${action.round}).\n\n${
            action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
          }`;
          await step(comment, "comment", action.original_ref, { kind: "change", body });
          await step(setMeta, "setMeta", action.original_ref, { rework_round: String(action.rework_round) });
          await step(move, "move", action.original_ref, "in_progress");
          await step(move, "move", action.original_ref, "todo");
          await closeReviewCard(
            action,
            `Loop closed this review card after moving ${action.original_ref} back to rework.`,
          );
          break;
        }

        case "reject_epic": {
          const body = `VERDICT: REJECT (review ${action.review_ref}, round ${action.round}).\n\n${
            action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
          }`;
          const created = await step(createFixChild, "create_fix_child", action);
          const childRef = created?.ref ?? created?.identifier ?? created?.task?.identifier ?? null;
          if (childRef === null) throw new Error("create_fix_child returned no ref");
          await step(linkFixChild, "link_fix_child", action.original_ref, childRef);
          await step(comment, "comment", action.original_ref, { kind: "change", body });
          await step(setMeta, "setMeta", action.original_ref, { rework_round: String(action.rework_round) });
          await step(move, "move", action.original_ref, "in_progress");
          await closeReviewCard(
            action,
            `Loop closed this review card after reopening ${action.original_ref} with fix child ${childRef}.`,
          );
          break;
        }

        case "reject_task_finish":
          await step(move, "move", action.original_ref, "todo");
          await closeReviewCard(action, `Loop closed this review card after completing the rework move.`);
          break;

        case "reopen_review": {
          // The marker is written before the two-hop move: a crash between the
          // hops leaves an `in_progress` review card the next pass finishes.
          const retry = Math.max(1, Number(action.retry ?? 1));
          await step(comment, "comment", action.review_ref, {
            kind: "note",
            body:
              `Verdict could not be applied (${action.reason}); ` +
              `re-dispatching for review attempt ${retry}.`,
          });
          await step(setMeta, "setMeta", action.review_ref, {
            review_retry: String(retry),
            review_reopen_at: now(),
          });
          if ((action.review_status ?? "in_review") === "in_review") {
            await step(move, "move", action.review_ref, "in_progress");
          }
          await step(move, "move", action.review_ref, "todo");
          break;
        }

        case "close_review":
          await closeReviewCard(action, `Loop closed this review card (${action.reason}).`);
          break;

        case "cancel_review":
          await closeReviewCard(action, `Loop canceled this review card: ${action.reason}.`);
          break;

        default:
          throw new Error(`unknown workflow action '${action.type}'`);
      }
      executed += 1;
    } catch (err) {
      const ref = action.original_ref ?? action.review_ref;
      // 0032 — a plan that outlived the report it was built on is a *skipped*
      // action, not an implementation failure: the next tick re-plans it. Keep
      // it out of `failed` (and out of the notification set) so a broken
      // delivery does not page every period.
      if (EXPECTED_ACCEPTANCE_SKIP_CODES.has(err.code)) {
        skipped += 1;
        log(`workflow: ${action.type} skipped for ${ref} (${err.code}: ${err.message})`);
        continue;
      }
      failed += 1;
      log(
        `workflow: ${action.type} failed for ${ref} ` +
          `(${err.message}) — leaving the review card for the next pass`,
        { level: "error" },
      );
      // A refusal that repeats every pass is a standing alarm, not a one-off:
      // `ACCEPTANCE_FORBIDDEN`/`CHILDREN_OPEN` mean this deployment's copy of
      // the policy (or the board's state) disagrees with the plan, and the loop
      // deliberately leaves the review card in place rather than forcing it.
      notifyBatch([
        {
          type: "workflow_action_failed",
          action: action.type,
          ref,
          error: err.message,
          dedupKey: `workflow_action_failed|${action.type}|${ref}|${err.message}`,
        },
      ]);
    }
  }

  return {
    dryRun,
    actions,
    alerts,
    changes,
    executed,
    failed,
    skipped,
    summary: { ...(plan.summary ?? {}), executed, failed, skipped },
    ledger: workingLedger,
  };
}

/**
 * Codes a plan can hit when the board's state moved under it. They are
 * re-planned on the next tick, so they are logged and counted as `skipped`, not
 * as failed actions.
 */
const EXPECTED_ACCEPTANCE_SKIP_CODES = new Set([
  "ACCEPTANCE_INCOMPLETE",
  "ACCEPTANCE_UNVERIFIED",
  "ROLLUP_REQUIRED",
  "ROLLUP_STALE",
  "REVIEW_PENDING",
]);

/**
 * Alerts worth a notification. The rest are log-only standing state
 * (`dispatch_skipped`, `dispatch_capped`, `review_awaiting_human_acceptance`):
 * a tick cannot resolve them, so notifying would repeat every period.
 * A state-based alert may still notify once when the ledger keys it to the
 * state rather than the clock (`actions_capped`).
 */
const WORKFLOW_NOTIFY_TYPES = new Set([
  "reconcile",
  "self_review_not_independent",
  "review_done_but_original_open",
  "verdict_unreadable",
  "verdict_conflict",
  "review_report_not_by_reviewer",
  "review_aging",
  "review_retries_exhausted",
  "original_unseen",
  "original_unexpected_status",
  "review_stale_round",
  "actions_capped",
]);

function describeWorkflowAlert(alert) {
  const detail = alert.original ?? alert.epic ?? "";
  return `alert ${alert.type}${alert.reason === undefined ? "" : ` (${alert.reason})`}${detail === "" ? "" : ` ${detail}`}`;
}

function describeWorkflowAction(action) {
  switch (action.type) {
    case "create_review":
      return `create review ${action.idem} for ${action.original_ref}`;
    case "auto_accept":
      return `auto-accept ${action.original_ref} (round ${action.round})`;
    case "approve":
      return `approve ${action.original_ref} (round ${action.round}) and close ${action.review_ref}`;
    case "reject_task":
    case "reject_epic":
      return `${action.type} ${action.original_ref} (round ${action.round})`;
    case "reject_task_finish":
      return `finish the rework move for ${action.original_ref}`;
    case "reopen_review":
      return `reopen review ${action.review_ref} for attempt ${action.retry} (${action.reason})`;
    case "close_review":
    case "cancel_review":
      return `${action.type} ${action.review_ref} (${action.reason})`;
    default:
      return action.type;
  }
}

/**
 * Start a detached child and resolve as soon as it exists. `stderrFd` (or null)
 * is closed in the parent once spawn resolves or fails.
 *
 * @param {{command: string, args: string[], env: Record<string,string>, cwd: string|null}} invocation
 * @param {number|null} stderrFd
 * @returns {Promise<{ok: boolean, pid?: number, error?: string}>}
 */
function spawnDetached(invocation, stderrFd) {
  return new Promise((resolveResult) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
      env: { ...process.env, ...invocation.env },
      ...(invocation.cwd === null ? {} : { cwd: invocation.cwd }),
    });
    const release = () => {
      if (stderrFd === null) return;
      try {
        closeSync(stderrFd);
      } catch {
        // Closing twice must never take the tick down.
      }
    };
    child.once("error", (err) => {
      release();
      resolveResult({ ok: false, error: err.message });
    });
    child.once("spawn", () => {
      release();
      child.unref();
      resolveResult({ ok: true, pid: child.pid });
    });
  });
}

/**
 * The handoff a claim produces — reviewer or worker. Shared by the resident
 * card queue and the legacy direct wake, so both routes say the same thing.
 *
 * @param {object} opts
 * @param {object} config
 * @param {{identifier: string, agent: string}} action
 * @param {object|undefined} card the candidate projection
 * @param {{projectDir?: string|null}} [context]
 * @returns {{isReview: boolean, role: "worker"|"reviewer", agentRole: string|null, roleWarnings: string[], handoff: string}}
 */
export function wakeHandoff(opts, config, action, card, context = {}) {
  // A review card takes the reviewer handoff. The candidate projection carries
  // `review_of`, so the decision needs no second read; the agent-name fallback
  // keeps an older projection (one written before those fields existed) working
  // for a dedicated reviewer.
  // 0031 — the reviewer set is the deployment reviewer plus every project
  // override. `reviewerWorkers` is the subset that is also a worker, so a
  // reviewer-worker keeps the normal worker lane. An older config that only
  // carries `reviewer` still works.
  const reviewers = Array.isArray(config.reviewers) && config.reviewers.length > 0
    ? config.reviewers
    : config.reviewer === null || config.reviewer === undefined
      ? []
      : [config.reviewer];
  const reviewerWorkers = Array.isArray(config.reviewerWorkers) ? config.reviewerWorkers : [];
  const dedicatedReviewer =
    reviewers.includes(action.agent) && !reviewerWorkers.includes(action.agent);
  const isReview = (typeof card?.review_of === "string" && card.review_of !== "") || dedicatedReviewer;

  // The role layer is optional. `opts.roles` is the injected/preloaded form the
  // tests use; production reads the effective root each dispatch (the files are
  // small, and a workflow edit must not need a pool restart). A broken manifest
  // degrades to no role, never an exception.
  const paths = typeof opts.home === "string" && typeof opts.actorKind === "string"
    ? agentPaths(opts.home, opts.actorKind)
    : null;
  const roleSet = opts.roles ?? loadRoles({
    explicitDir: opts.rolesDir ?? null,
    projectDir: context.projectDir ?? null,
    loopSkillDir: paths?.loopSkill ?? null,
    stateDir: paths?.stateDir ?? null,
  });
  const role = isReview
    ? selectReviewerRole(roleSet, action.agent)
    : selectRole(roleSet, action.agent, "worker");
  const decisionPolicyPath = roleSet?.decisionPolicy?.path ?? null;

  const handoff = isReview
    ? buildReviewHandoff({
        card: card ?? { identifier: action.identifier },
        agent: action.agent,
        actorKind: opts.actorKind,
        role,
        roleWorkflowPath: role?.workflows?.reviewer ?? null,
        reviewerPrompt: readRoleText(role?.reviewerPrompt),
        reviewerPromptPath: role?.reviewerPrompt ?? null,
        decisionPolicyPath,
      })
    : buildHandoff({
        card: card ?? { identifier: action.identifier },
        agent: action.agent,
        actorKind: opts.actorKind,
        review: reviewers.includes(action.agent),
        role,
        roleWorkflowPath: role?.workflows?.worker ?? null,
        selfCheckPath: role?.selfCheck ?? null,
        decisionPolicyPath,
      });
  // Only claim the role as the card's named agent when the manifest actually names
  // this assignee. A fallback reviewer role still guides the handoff, but spawning
  // the default subagent is correct when the assignee is a custom name.
  const agentRole =
    role && role.agent.toLowerCase() === String(action.agent ?? "").toLowerCase()
      ? role.agent
      : null;
  return {
    isReview,
    role: isReview ? "reviewer" : "worker",
    agentRole,
    roleWarnings: roleSet?.warnings ?? [],
    handoff,
  };
}

/** Read a validated role file; a race with an editor degrades to no text. */
function readRoleText(path) {
  if (typeof path !== "string" || path === "") return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}


/** A notify command may hang; the pass must not hang with it. */
export const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * The one alert a cadence emits when no resident pool can dispatch: poll claims
 * nothing and worker/reviewer dispatch is paused. The caller runs once per
 * cadence, so this is "at most one per cadence" without a dedupe file.
 *
 * @param {object} opts
 * @param {(line: string) => void} log
 * @param {{reason?: string|null}} pool
 * @param {(alert: object) => void} [notify]
 */
export function notifyNoResident(opts, log, pool, notify = notifyReal(opts, log)) {
  notify({
    kind: "no_resident",
    severity: "warning",
    actorKind: opts.actorKind,
    reason: pool?.reason ?? "unknown",
    message: "no resident session pool — worker/reviewer dispatch is paused; poll skipped",
    at: new Date().toISOString(),
  });
}

export function notifyReal(opts, log, { timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  return (alert) => {
    if (!opts.notify) return;
    const run = spawnSync(opts.notify, {
      shell: true,
      input: JSON.stringify(alert),
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    // `spawnSync` reports a timeout as ETIMEDOUT on some platforms and as a
    // SIGTERM kill with no status on others; both mean the same thing here.
    if (run.error?.code === "ETIMEDOUT" || (run.signal === "SIGTERM" && run.status === null)) {
      log(`notify timed out after ${timeoutMs}ms`);
    } else if (run.error) {
      log(`notify failed: ${run.error.message}`, { level: "warn" });
    } else if (run.status !== 0) {
      log(`notify exited ${run.status}`);
    }
  };
}

/**
 * Start one continue turn and return as soon as the child exists. Its stderr
 * goes to the loop log, or a failed agent CLI would be silent.
 *
 * @param {{log: string}} opts
 * @param {{command: string, args: string[], env: Record<string,string>, cwd: string|null}} invocation
 * @param {(line: string) => void} log
 * @returns {Promise<{ok: boolean, pid?: number, error?: string}>}
 */
export function spawnContinueTurn(opts, invocation, log) {
  const stderrFd = openAppendFd(opts.log);
  // A missing fd would make the agent's stderr vanish without a trace, which is
  // exactly what this path exists to prevent (see `openAppendFd`'s contract).
  if (stderrFd === null) {
    log("continue: could not open the loop log — the agent's stderr will be discarded", {
      level: "warn",
    });
  }
  return spawnDetached(invocation, stderrFd);
}

// ---------------------------------------------------------------------------
// The continue turn — the scheduler's periodic judgment turn
// ---------------------------------------------------------------------------

/**
 * Run one continue turn: build a bounded `Continue` prompt, take the
 * single-flight lock, start the agent. The prompt runs
 * `passes.mjs patrol → workflow → poll`; poll is last so a review card
 * dispatched in this turn can be claimed immediately.
 *
 * @param {object} opts
 * @param {{
 *   log: (line: string) => void,
 *   continueEnabled?: boolean,
 *   requirePool?: boolean,
 *   spawn?: (opts: object, invocation: object, log: (line: string) => void) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   onSkip?: (holder: object|null) => void,
 *   onAcquired?: (holder: object|null) => void,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runContinue(opts, deps = {}) {
  const log = deps.log ?? createLogger(opts);
  const continueEnabled = deps.continueEnabled ?? true;
  const spawnTurn = deps.spawn ?? spawnContinueTurn;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const onSkip = deps.onSkip ?? null;
  const onAcquired = deps.onAcquired ?? null;

  if (!continueEnabled) {
    log("continue: disabled (--continue=no)");
    return 0;
  }

  const pool = (deps.poolStatus ?? poolStatus)({ opts, isAlive, now });
  const stateDir = dirname(String(opts.state));

  // The resident pool owns the continue turn: this process only queues it, and
  // the control session runs `patrol → workflow → poll` in its own conversation.
  if (pool.live) {
    if (opts.dryRun) {
      log(`continue: would enqueue for the resident control session (${pool.file})`);
      return 0;
    }
    const queued = enqueueContinue(stateDir, { reason: "timer" });
    if (!queued.ok) {
      log(`continue: could not enqueue the control turn: ${queued.error}`, { level: "warn" });
      return 1;
    }
    log(`continue: enqueued for the resident control session${queued.coalesced ? " (coalesced)" : ""}`);
    return 0;
  }

  // The event path may not spend a turn when there is nothing it could
  // dispatch: with no pool, poll claims nothing, so an event-triggered turn
  // would be a patrol + workflow pass bought at the event cadence (60 s) rather
  // than the continue cadence (600 s). The timer still runs that pass, and it
  // owns the one-per-cadence operator alert. Brief refreshes are unaffected.
  if (!pool.live && deps.requirePool === true) {
    log(
      `continue: event dispatch skipped — no resident session pool (${pool.reason ?? "unknown"}); ` +
        "worker dispatch paused",
    );
    return 0;
  }

  // No resident pool: the one-shot turn still runs what it can — patrol and
  // workflow — but it claims nothing. Poll is left out of the prompt entirely,
  // because the cards it would claim could not be dispatched to a project
  // session. One alert per cadence is the operator's signal to start the pool.
  log(
    `continue: no resident session pool (${pool.reason ?? "unknown"}) — ` +
      "patrol + workflow only; worker/reviewer dispatch paused",
  );
  if (!opts.dryRun) {
    notifyNoResident(opts, log, pool, deps.notify ?? notifyReal(opts, log));
  }

  const agentFiles = agentPaths(opts.home, opts.actorKind);
  const roleSet = opts.roles ?? loadRoles({
    explicitDir: opts.rolesDir ?? null,
    loopSkillDir: agentFiles.loopSkill,
    stateDir: agentFiles.stateDir,
  });
  const agent = opts.agents[0];
  const prompt = buildContinuePrompt({
    actorKind: opts.actorKind,
    agent,
    cliCommand: `${quoteArg(process.execPath)} ${quoteArg(opts.cli)} ${loopCommandArgs(opts).map(quoteArg).join(" ")}`,
    continueIntervalSeconds: opts.continueInterval,
    openedBy: opts.openedBy,
    decisionPolicy: roleSet.decisionPolicy,
    includePoll: false,
  });
  const invocation = planContinueInvocation({
    actorKind: opts.actorKind,
    prompt,
    cwd: opts.repo,
  });

  if (opts.dryRun) {
    const shown = invocation.args.map((arg) => (arg === prompt ? "<continue prompt>" : arg));
    log(`continue: would run: ${invocation.command} ${shown.join(" ")} in ${invocation.cwd}`);
    log(prompt);
    return 0;
  }

  // A turn that hangs must not block the loop forever, but it does get much
  // longer than its cadence: the cap is two cadences or two hours, whichever is
  // larger.
  const maxAgeMs = Math.max(2 * opts.continueInterval * 1000, 2 * 60 * 60 * 1000);
  let lock;
  try {
    lock = acquireContinueLock(opts.continueState, { isAlive, now, maxAgeMs });
  } catch (err) {
    log(`continue: could not take the lock (${err.message}) — skipping`);
    return 1;
  }
  if (!lock.acquired) {
    const holder = lock.holder;
    const who = holder === null ? "another turn is starting" : `previous turn pid ${holder.pid} still running`;
    log(`continue: skipped — ${who}`);
    // The event subscriber keeps a pending dispatch instead of dropping one
    // whose turn happened to be in flight.
    onSkip?.(holder);
    return 0;
  }
  onAcquired?.(lock.holder);

  try {
    const outcome = await spawnTurn(opts, invocation, log);
    if (!outcome?.ok) {
      releaseContinueLock(opts.continueState);
      log(`continue: wake failed: ${outcome?.error ?? "unknown error"}`, { level: "error" });
      return 1;
    }
    if (outcome.pid !== undefined && outcome.pid !== null) {
      try {
        recordContinuePid(
          opts.continueState,
          outcome.pid,
          lock.holder?.startedAt ?? new Date(now()).toISOString(),
        );
      } catch (err) {
        log(`continue: could not record the turn pid (${err.message}) — the lock will expire`, {
          level: "warn",
        });
      }
    }
    log(`continue: woke ${opts.actorKind} pid ${outcome.pid ?? "(none)"}`);
    return 0;
  } catch (err) {
    releaseContinueLock(opts.continueState);
    log(`continue: wake failed: ${err.message}`, { level: "error" });
    return 1;
  }
}

/**
 * One continue pass with the real per-kind config and logger.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{onSkip?: Function, onAcquired?: Function, requirePool?: boolean}} [hooks]
 *   `requirePool` is set by the event subscriber: an event may not buy a turn
 *   that could not dispatch anything.
 * @returns {Promise<number>}
 */
export async function runContinueOnce(opts, env = process.env, hooks = {}) {
  const log = createLogger(opts);
  const { continueEnabled } = resolveLoopConfig(opts, env);
  return runContinue(opts, {
    log,
    continueEnabled,
    requirePool: hooks.requirePool === true,
    onSkip: hooks.onSkip,
    onAcquired: hooks.onAcquired,
  });
}
