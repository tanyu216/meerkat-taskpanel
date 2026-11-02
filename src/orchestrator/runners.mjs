#!/usr/bin/env node
/**
 * The loop's runners and process spawners.
 *
 * The runners take their side effects as dependencies, so a test can prove
 * "an empty scan spawns nothing" without a board.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildHandoff,
  buildResidentEnvelope,
  buildReviewEnvelope,
  buildReviewHandoff,
  planPatrol,
  planTick,
} from "../foundation/scheduling.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  partitionSlaAlerts,
  recordSlaAlerts,
} from "../foundation/sla-patrol.mjs";
import {
  loadRoles,
  roleVariant,
  selectRole,
  selectWorkerRole,
  skillLoadMode,
} from "../foundation/roles.mjs";
import { resolveRolePlatform } from "../foundation/role-platforms.mjs";
import { DEFERRAL_HOLD } from "./deferrals.mjs";
import { resolveLoopConfig } from "./options.mjs";
import * as passes from "./passes.mjs";
import { poolStatus } from "./session.mjs";
import { workerKey } from "./worker-session.mjs";
import {
  acquireContinueLock,
  createLogger,
  isProcessAlive,
  releaseContinueLock,
} from "./runtime.mjs";

/** Rows about the board, not one card — a single-card re-read cannot decide them. */
const BOARD_LEVEL_ROWS = new Set(["leader_stalled", "inspector_liveness"]);

/**
 * One poll pass.
 *
 * `dispatch` is the side effect of a successful claim. In the resident model it
 * writes the card queue (the pool spawns the session); the legacy
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
 *   admit?: (action: object, card: object|undefined) => Promise<{ok: boolean, why?: string, code?: string, accounted?: boolean}>,
 *   release?: (identifier: string) => Promise<unknown>,
 *   recordDefer?: (identifier: string, failure: {code: string, reason: string, round: number}) => void,
 *   clearDeferral?: (identifier: string) => void,
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
    // Checked before admission and claim: a role no available kind carries must
    // not leave the card claimed on a platform that cannot start.
    authorize = null,
    admit = null,
    release = null,
    recordDefer = null,
    clearDeferral = null,
    moveBack = null,
    holdCard = null,
    limit = Number.POSITIVE_INFINITY,
    verb = "woke",
    // The claim identity for a card no scan agent owns. The pool lists an
    // unassigned card for every scanner, so taking the scan order's first name
    // would make Jobs the default worker by accident. Explicit, or the scan
    // agent as the documented fallback.
    defaultAgent = null,
    now,
    log,
  } = deps;

  const candidates = [];
  for (const agent of agents) {
    const found = await readCandidates(agent, { claimUnassigned: config.claimUnassigned === true });
    for (const candidate of found ?? []) {
      const unassigned =
        candidate.agent === null ||
        candidate.agent === undefined ||
        candidate.agent === "" ||
        candidate.reason === "unassigned";
      const who =
        unassigned && typeof defaultAgent === "string" && defaultAgent !== ""
          ? defaultAgent
          : candidate.agent ?? agent;
      candidates.push({ ...candidate, agent: who, ...(unassigned ? { unassigned: true } : {}) });
    }
  }

  const actions = planTick({ candidates, registry, config });
  const cardById = new Map();
  for (const candidate of candidates) cardById.set(String(candidate.identifier), candidate);

  let spawned = 0;
  let claimed = 0;
  let conflicts = 0;
  let failed = 0;
  let deferred = 0;

  /**
   * Park a card whose streak reached the hold bound.
   *
   * The ledger entry is the evidence; the board status is the hold. On success
   * the streak is cleared — if a human moves the card back, it starts a fresh,
   * still-bounded run instead of being held on the first failure.
   */
  const holdIfExhausted = async (identifier, entry) => {
    if (entry === null || entry === undefined) return;
    if (Number(entry.count ?? 0) < DEFERRAL_HOLD) return;
    if (holdCard === null) return;
    const held = await holdCard(identifier, {
      code: entry.code ?? "ADMISSION_FAILED",
      reason: entry.reason ?? "",
    });
    if (held?.ok === true) {
      clearDeferral?.(identifier);
      log(
        `hold ${identifier}: parked after ${entry.count} consecutive ${entry.code ?? "admission"} failures`,
        { level: "warn" },
      );
    } else {
      log(`hold ${identifier}: could not park the card (${held?.error ?? "unknown error"})`, {
        level: "error",
      });
    }
  };

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
    if (authorize !== null) {
      const verdict = authorize(action, card);
      if (verdict?.ok === false) {
        deferred += 1;
        log(`defer ${action.identifier} (${verdict.why ?? "no platform carries the role"})`);
        continue;
      }
    }
    // The claim budget is checked **before** the claim: a card with no place to
    // run must stay `todo`, where the next turn can offer it again. Admission
    // registers the brief watch first; a terminal card is written once and
    // skipped, never claimed.
    const admitted = admit === null ? { ok: true } : await admit(action, card);
    if (admitted?.ok !== true) {
      deferred += 1;
      // Card-scoped failures are the ones that can loop forever. Budget and
      // concurrency backpressure are not counted (`accounted: false`).
      if (admitted?.accounted === true) {
        const entry = recordDefer?.(action.identifier, {
          code: admitted.code ?? "ADMISSION_FAILED",
          reason: admitted.why ?? "not admitted",
          round: Number(card?.delivery_round ?? 1),
          version: card?.version ?? null,
        });
        await holdIfExhausted(action.identifier, entry);
      }
      log(`defer ${action.identifier} (${admitted?.why ?? "not admitted"})`);
      continue;
    }
    // Admission succeeded: whatever was wrong last pass is gone. A later
    // dispatch failure is a different, tracked gap.
    clearDeferral?.(action.identifier);

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
      // Give back what this pass reserved (brief watch, a workspace it created):
      // no subagent will use them.
      if (release !== null) await release(action.identifier);
      // Hand the claim back instead of leaving the card `in_progress` until the
      // board's 30-minute stale recovery. A dispatch failure must be visible and
      // retryable, not a silent lock held by a worker that never started.
      if (moveBack !== null) {
        const moved = await moveBack(action.identifier, action.agent);
        if (moved?.ok !== true) {
          log(
            `release claim failed for ${action.identifier}: ${moved?.error ?? "unknown error"}`,
            { level: "warn" },
          );
        }
      }
      const entry = recordDefer?.(action.identifier, {
        code: "DISPATCH_FAILED",
        reason: outcome?.error ?? "dispatch failed",
        round: Number(card?.delivery_round ?? 1),
        version: card?.version ?? null,
      });
      await holdIfExhausted(action.identifier, entry);
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
 * claims a card and never moves one: the director answers the question
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
      dispatch_key: question.question_id,
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
 *   appendAcceptance?: (ref: string, items: string[]) => Promise<{ok: boolean, error?: string}>,
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
    appendAcceptance = null,
    // Landing runs before a card is moved to `done`: the lane branch is merged
    // into the project's current branch. `null` keeps the old (shared-tree)
    // behaviour for a caller that does not wire it.
    land = null,
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
  let blocked = 0;

  const step = async (fn, name, ...args) => {
    if (typeof fn !== "function") throw new Error(`${name} is not wired`);
    const result = await fn(...args);
    if (result?.ok === false) {
      // The board's refusal keeps its code: the catch classifies on it. Without
      // this, every board refusal looked like an unclassified failure.
      const error = new Error(result.error ?? `${name} failed`);
      if (typeof result.code === "string") error.code = result.code;
      if (result.details !== undefined) error.details = result.details;
      if (result.hint !== undefined) error.hint = result.hint;
      throw error;
    }
    return result;
  };

  // A rejection's must-fix items become acceptance criteria, so the next
  // round's report template and the next review card both owe an answer. The
  // append is skipped when the plan already found every item in the baseline.
  const appendMustFix = async (action) => {
    const items = Array.isArray(action.must_fix) ? action.must_fix : [];
    if (items.length === 0) return;
    await step(appendAcceptance, "appendAcceptance", action.original_ref, items);
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

  /**
   * The board refused an acceptance because the delivery report cannot close the
   * card. Re-trying the same move changes nothing — the report binds its round —
   * so the refusal is routed back to the worker as a new delivery round, using
   * the same two-hop reopen `reject_task` uses (its crash recovery then applies
   * unchanged), and the review card is closed.
   *
   * The `accepted_by` marker written before the refused move is left alone: the
   * round bump makes it a mark from an earlier round, which is exactly how the
   * planner's `held` rule already reads one.
   */
  const routeAcceptanceBlocked = async (action, err) => {
    const ref = action.original_ref ?? action.review_ref;
    const details = err.details ?? {};
    const items = [...(details.blocking ?? []), ...(details.unsupported ?? [])]
      .map((item) => {
        const status = typeof item?.status === "string" ? ` (${item.status})` : "";
        return `- ${item?.text ?? item?.key ?? "an acceptance item"}${status}`;
      })
      .join("\n");
    const body =
      `The board refused the acceptance: ${err.message}\n\n` +
      (items === "" ? "" : `Unanswered:\n${items}\n\n`) +
      "Work that already landed is not rolled back — this round is missing evidence. " +
      "Deliver a new round that answers these items.";
    await step(comment, "comment", ref, { kind: "change", body });
    // `in_review → in_progress` bumps the delivery round (and so unfreezes the
    // baseline); the second hop releases the card to `todo`.
    await step(move, "move", ref, "in_progress");
    await step(move, "move", ref, "todo");
    if (action.type === "approve") {
      await closeReviewCard(
        action,
        `Loop closed this review card because the board refused the approval of ${ref}: ` +
          "its delivery report cannot close the card.",
      );
    }
  };

  /**
   * The landing marker for the acceptance write, or nothing.
   *
   * A card worked in a tree the loop did not create has no lane to merge, so
   * there is no commit to name — and writing an empty one would make "unknown"
   * look like "unlanded". Absence is the honest answer.
   */
  const landingMeta = (merged, clock) => {
    const sha = typeof merged?.sha === "string" ? merged.sha.trim() : "";
    return sha === "" ? {} : { landed_sha: sha, landed_at: clock() };
  };

  for (const action of actions) {
    if (dryRun) {
      log(`workflow: would ${describeWorkflowAction(action)}`);
      continue;
    }
    // The merge `land` performed for *this* action, if it performed one. Reset
    // per action so an earlier acceptance's commit cannot be attributed to this.
    let landed = null;
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
          // Land first: a card reaches `done` only after its lane branch is in
          // the project's current branch. A failed merge throws before any
          // board write and is retried on the next tick.
          landed = typeof land === "function" ? await step(land, "land", action) : null;
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, {
              accepted_by: action.accepted_by,
              accepted_round: String(action.round),
              auto_accepted: "1",
              ...landingMeta(landed, now),
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
          // Land before the acceptance writes: `done` means the work is in the
          // project's current branch. A conflict leaves the card in `in_review`
          // with its verdict recorded and the lane branch intact.
          landed = typeof land === "function" ? await step(land, "land", action) : null;
          // Marker first, note second (the same order as `auto_accept`): a crash
          // between them is recovered by `held` on the next pass — land/move/
          // close re-run and the note is not posted twice. The marker is the
          // acceptance of record; the note is informational, so losing it is
          // preferable to duplicating it.
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, {
              accepted_by: action.accepted_by,
              accepted_round: String(action.round),
              ...landingMeta(landed, now),
            });
            await step(comment, "comment", action.original_ref, {
              kind: "note",
              body: `Loop acceptance after review ${action.review_ref} (round ${action.round}): VERDICT: APPROVE.`,
            });
          }
          await step(move, "move", action.original_ref, "done");
          await closeReviewCard(
            action,
            `Loop auto-accepted this review card after applying VERDICT: APPROVE to ${action.original_ref}.`,
          );
          break;

        // Review is mode-independent; only the close differs. A `human` original
        // gets the round-scoped verdict recorded and its review card closed, but
        // is left in `in_review` for a person to close through the ordinary
        // acceptance gate. The marker makes a crash between the writes and the
        // close recoverable (`held`).
        case "record_verdict":
          if (action.held !== true) {
            // Marker first, note second (the same order as `auto_accept` and
            // `approve`): a crash between them is recovered by `held` and the
            // note is not posted twice.
            await step(setMeta, "setMeta", action.original_ref, {
              review_verdict: "approve",
              review_verdict_round: String(action.round),
            });
            await step(comment, "comment", action.original_ref, {
              kind: "note",
              body:
                `Review ${action.review_ref} (round ${action.round}): VERDICT: APPROVE. ` +
                "This card's acceptance_mode is `human`, so the verdict is recorded " +
                "and the card stays in in_review for a person to close.",
            });
          }
          await closeReviewCard(
            action,
            `Loop closed this review card after recording VERDICT: APPROVE on ${action.original_ref}; ` +
              "the original awaits a person's close.",
          );
          break;

        case "reject_task": {
          const body = `VERDICT: REJECT (review ${action.review_ref}, round ${action.round}).\n\n${
            action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
          }`;
          // Marker first, note second: a refused move below is retried on the
          // next pass (`held`) without re-posting the same rejection.
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, { rework_round: String(action.rework_round) });
            await step(comment, "comment", action.original_ref, { kind: "change", body });
          }
          await step(move, "move", action.original_ref, "in_progress");
          // The round bump on the move above is what unlocks the baseline; the
          // items land before the card is released to `todo`, so the next
          // round's report template and the next review card both carry them.
          await appendMustFix(action);
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
          // Marker first, note second (see `reject_task`): `held` retries the
          // reopen without re-posting the rejection.
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, { rework_round: String(action.rework_round) });
            await step(comment, "comment", action.original_ref, { kind: "change", body });
          }
          await step(move, "move", action.original_ref, "in_progress");
          // The fix child is `acceptance_mode=off` and is never reviewed, so the
          // epic's own baseline is what the next review card copies.
          await appendMustFix(action);
          await closeReviewCard(
            action,
            `Loop closed this review card after reopening ${action.original_ref} with fix child ${childRef}.`,
          );
          break;
        }

        case "reject_task_finish":
          await appendMustFix(action);
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

        case "hold_card": {
          // The board decided; the loop parks the card. Meta first (the hold
          // epoch and the crash marker), then the question, then the move, then
          // the review close — the same recoverable order as `reject_task`.
          // `held:true` is a crash recovery: only the move is retried.
          if (action.held !== true) {
            await step(setMeta, "setMeta", action.original_ref, action.marker ?? {});
            await step(comment, "comment", action.original_ref, {
              kind: "question",
              body:
                action.question ??
                `The loop parked ${action.original_ref} after repeated rounds (${action.code ?? "loop breaker"}).`,
            });
          }
          await step(move, "move", action.original_ref, "blocked", {
            blockedReason: action.blocked_reason ?? "decision",
          });
          if (
            action.close_review === true &&
            typeof action.review_ref === "string" &&
            action.review_ref !== ""
          ) {
            await closeReviewCard(
              { ...action, review_status: action.review_status ?? "in_review" },
              `Loop closed this review card because ${action.original_ref} was parked ` +
                `(${action.code ?? "loop breaker"}).`,
            );
          }
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
      // An acceptance the board refuses is neither transient nor a plan race:
      // re-planning produces the same action, because the delivery report binds
      // its round. It is routed back as a new round (see the function above).
      if (
        err.code === "ACCEPTANCE_INCOMPLETE" &&
        (action.type === "approve" || action.type === "auto_accept")
      ) {
        const key = `acceptance_blocked|${action.type}|${ref}|r${action.round}`;
        try {
          await routeAcceptanceBlocked(action, err);
        } catch (routeErr) {
          failed += 1;
          log(
            `workflow: ${action.type} blocked for ${ref} (${err.message}), and the reopen failed ` +
              `(${routeErr.message}) — the next pass retries`,
            { level: "error" },
          );
          notifyBatch([
            { type: "acceptance_blocked", action: action.type, ref, round: action.round,
              error: err.message, route_error: routeErr.message, dedupKey: key },
          ]);
          continue;
        }
        blocked += 1;
        log(
          `workflow: ${action.type} refused for ${ref} (${err.message}) — reopened for a new delivery round`,
          { level: "warn" },
        );
        notifyBatch([
          { type: "acceptance_blocked", action: action.type, ref, round: action.round,
            error: err.message, dedupKey: key },
        ]);
        continue;
      }
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
      const baseKey = `workflow_action_failed|${action.type}|${ref}|${err.message}`;
      const batch = [
        {
          type: "workflow_action_failed",
          action: action.type,
          ref,
          error: err.message,
          dedupKey: baseKey,
        },
      ];
      // The first refusal notifies once. A refusal that outlives the window is
      // a standing alarm, so it is re-sent once per bucket: the ledger supplies
      // the original `first_seen`, and a bucket is a *new key*, which is the
      // same rule the SLA channel uses for a tier promotion.
      const firstSeen = workingLedger?.seen?.[baseKey]?.first_seen;
      const firstSeenAt = typeof firstSeen === "string" ? Date.parse(firstSeen) : Number.NaN;
      const nowAt = Date.parse(now());
      if (Number.isFinite(firstSeenAt) && Number.isFinite(nowAt)) {
        const ageMs = nowAt - firstSeenAt;
        if (ageMs >= WORKFLOW_ACTION_ESCALATE_MS) {
          batch.push({
            type: "workflow_action_failed_escalated",
            action: action.type,
            ref,
            error: err.message,
            first_seen: firstSeen,
            age_ms: ageMs,
            dedupKey:
              `workflow_action_failed_escalated|${action.type}|${ref}` +
              `|b${Math.floor(ageMs / WORKFLOW_ACTION_ESCALATE_MS)}`,
          });
        }
      }
      notifyBatch(batch);
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
    blocked,
    summary: { ...(plan.summary ?? {}), executed, failed, skipped, blocked },
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
/** A standing workflow-action failure re-notifies once per this bucket. */
const WORKFLOW_ACTION_ESCALATE_MS = 24 * 60 * 60 * 1000;

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
  // A `todo` card no scan can claim: notify once per card state, not per tick.
  "unowned_todo",
  // Raised by the failed-action catch itself (which calls `notifyBatch` directly
  // rather than through this filter), so it is listed for consistency: a later
  // refactor that routes every alert through the filter must not drop it.
  "workflow_action_failed_escalated",
  // Same reason: the refused-acceptance route notifies directly.
  "acceptance_blocked",
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
    case "record_verdict":
      return `record the APPROVE on ${action.original_ref} (round ${action.round}) and close ${action.review_ref}`;
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
export function resolveRoleTarget(opts, config, action, card) {
  // The card data states the lane a review needs; the assignee selects the role
  // within it. A review card whose assignee names no installed reviewer-lane
  // role is not dispatched (the caller reports it); it is never swapped to a
  // different role. `config` is still accepted for the supervisor's dispatch
  // path until the reviewer configuration layer is removed.
  void config;
  const review = typeof card?.review_of === "string" && card.review_of !== "";

  // The role layer is optional. `opts.roles` is the injected/preloaded form the
  // tests use; production scans the installed role skills each dispatch (the
  // files are small, and a role edit must not need a pool restart). A malformed
  // role degrades to no role, never an exception.
  const primaryKind = typeof opts.actorKind === "string" && opts.actorKind !== "" ? opts.actorKind : "claude";
  const roleSet = opts.roles ?? loadRoles({
    home: typeof opts.home === "string" ? opts.home : null,
    primaryKind,
    kindOrder: opts.kindOrder,
    explicitDir: opts.rolesDir ?? null,
  });
  const role = review
    ? selectRole(roleSet, action.agent, "reviewer")
    : (selectRole(roleSet, action.agent, "worker") ?? selectWorkerRole(roleSet));

  // Installation location is the routing. The chosen kind can fall back to
  // another kind that also carries this role, and it can be `null` — then the
  // caller must not claim or dispatch (the skill would not be there).
  const platform = role === null
    ? { effective: primaryKind, fallback: null }
    : resolveRolePlatform(role, {
        primaryKind,
        order: opts.kindOrder,
        available: opts.kindAvailable ?? null,
      });
  const actorKind = platform.effective;
  return {
    isReview: review,
    executorReady: !review || role !== null,
    roleSet,
    role,
    primaryKind,
    actorKind,
    platformFallback: platform.fallback ?? null,
    files: role === null ? null : roleVariant(role, actorKind),
  };
}

export function wakeHandoff(opts, config, action, card, resident = false) {
  const target = resolveRoleTarget(opts, config, action, card);
  const { isReview, executorReady, roleSet, role, actorKind, files } = target;
  const decisionPolicyPath = roleSet?.decisionPolicy?.path ?? null;
  // The resident pool loads the role skill when the session opens — a
  // `/<skill>` message on a host that expands it, or inside the adapter
  // (`developerInstructions`, `--append-system-prompt`). A resident session's
  // envelope then carries the card and the board moves, not the role layer or
  // the skill paths: a review card gets its own lean envelope, exactly like a
  // worker. A deployment without a role, or with a role whose SKILL.md is
  // missing, keeps the full handoff: there is no skill to load.
  const skillMode = skillLoadMode(actorKind);
  const skillReady =
    skillMode === "opener" ||
    (skillMode === "inline" && typeof files?.workflow === "string");
  const lean = resident === true && role !== null && skillReady;
  // An inline lane got no opener message, so the envelope carries the
  // attribution the agent must put on every board write.
  const flags =
    skillMode === "inline"
      ? `${action.agent ? `--agent ${action.agent} ` : ""}--actor-kind=${actorKind}`
      : null;

  const handoff = lean
    ? isReview
      ? buildReviewEnvelope({
          card: card ?? { identifier: action.identifier },
          flags,
        })
      : buildResidentEnvelope({
          card: card ?? { identifier: action.identifier },
          decisionPolicyPath,
          flags,
        })
    : isReview
      ? buildReviewHandoff({
          card: card ?? { identifier: action.identifier },
          agent: action.agent,
          actorKind,
          role,
          roleWorkflowPath: files?.workflow ?? null,
          reviewerPrompt: readRoleText(files?.reviewerPrompt),
          reviewerPromptPath: files?.reviewerPrompt ?? null,
          decisionPolicyPath,
        })
      : buildHandoff({
          card: card ?? { identifier: action.identifier },
          agent: action.agent,
          actorKind,
          role,
          roleWorkflowPath: files?.workflow ?? null,
          selfCheckPath: files?.selfCheck ?? null,
          decisionPolicyPath,
        });
  // Only claim the role as the card's named agent when the manifest actually names
  // this assignee. A worker card may still fall back to the default worker role;
  // the handoff is built from the selected role either way.
  const agentRole =
    role && role.agent.toLowerCase() === String(action.agent ?? "").toLowerCase()
      ? role.agent
      : null;
  return {
    isReview,
    executorReady,
    role: isReview ? "reviewer" : "worker",
    agentRole,
    // `null` means "no kind that carries this role can start": the caller must
    // report and refuse the dispatch instead of spawning on a wrong platform.
    actorKind,
    platformFallback: target.platformFallback,
    roleWarnings: roleSet?.warnings ?? [],
    handoff,
  };
}

/**
 * The queue row's handoff fields, shared by poll and patrol. Every row names
 * its own card session; a review card is no different from a worker card.
 *
 * @param {{opts: object, config: object, action: object, card?: object, projectDir?: string|null, round?: number, resident?: boolean}} input
 */
export function buildHandoffRow(input = {}) {
  const { opts, config, action, card, projectDir = null, round = 1, resident = false } = input;
  const result = wakeHandoff(opts, config, action, card, resident === true);
  return {
    ...result,
    // The queue row carries the kind so the pool keys the session by
    // (actor_kind, worker_key) and never resumes a session across kinds.
    actor_kind: result.actorKind,
    worker_key: workerKey(action.identifier, round),
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
const NOTIFY_TIMEOUT_MS = 10_000;

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

// ---------------------------------------------------------------------------
// The tick — the supervisor runs the deterministic passes in-process
// ---------------------------------------------------------------------------

/**
 * Run one tick: take the single-flight lock, then run
 * `patrol → workflow → poll` in this process. Poll is last so a review card
 * dispatched in this tick can be claimed immediately. No agent is spawned here;
 * the resident pool opens worker/reviewer/director sessions from the queue.
 *
 * @param {object} opts
 * @param {{
 *   log?: (line: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   continueEnabled?: boolean,
 *   requirePool?: boolean,
 *   runPatrol?: Function,
 *   runWorkflow?: Function,
 *   runPoll?: Function,
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
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const onSkip = deps.onSkip ?? null;
  const onAcquired = deps.onAcquired ?? null;
  const env = deps.env ?? process.env;
  const runPatrol = deps.runPatrol ?? passes.runPatrolOnce;
  const runWorkflow = deps.runWorkflow ?? passes.runWorkflowOnce;
  const runPoll = deps.runPoll ?? passes.runPollOnce;

  if (!continueEnabled) {
    log("tick: disabled (--continue=no)");
    return 0;
  }

  // An event may not buy a tick that could dispatch nothing. The timer still
  // runs: patrol + workflow are useful without a pool, and poll reports why it
  // claims nothing.
  if (deps.requirePool === true) {
    const pool = (deps.poolStatus ?? poolStatus)({ opts, isAlive, now });
    if (!pool.live) {
      log(
        `tick: event dispatch skipped — no resident session pool (${pool.reason ?? "unknown"}); ` +
          "worker dispatch paused",
      );
      return 0;
    }
  }

  if (opts.dryRun) {
    log(
      `tick: would run patrol → workflow${deps.requirePool === true ? "" : " → poll"} ` +
        `on ${opts.actorKind}`,
    );
    return 0;
  }

  // A tick that hangs must not block the next one forever, but it does get much
  // longer than its cadence: the cap is two cadences or two hours, whichever is
  // larger.
  const maxAgeMs = Math.max(2 * opts.continueInterval * 1000, 2 * 60 * 60 * 1000);
  let lock;
  try {
    lock = acquireContinueLock(opts.continueState, { isAlive, now, maxAgeMs });
  } catch (err) {
    log(`tick: could not take the lock (${err.message}) — skipping`);
    return 1;
  }
  if (!lock.acquired) {
    const holder = lock.holder;
    const who = holder === null ? "another tick is starting" : `previous tick pid ${holder.pid} still running`;
    log(`tick: skipped — ${who}`);
    // The event subscriber keeps a pending dispatch instead of dropping one
    // whose tick happened to be in flight.
    onSkip?.(holder);
    return 0;
  }
  onAcquired?.(lock.holder);

  try {
    await runPatrol(opts, env);
    await runWorkflow(opts, env);
    await runPoll(opts, env);
    return 0;
  } catch (err) {
    log(`tick: pass failed: ${err.message}`, { level: "error" });
    return 1;
  } finally {
    releaseContinueLock(opts.continueState);
  }
}

/**
 * One tick with the real per-kind config and logger.
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{onSkip?: Function, onAcquired?: Function, requirePool?: boolean}} [hooks]
 *   `requirePool` is set by the event subscriber: an event keeps the tick to
 *   patrol + workflow when no pool could dispatch its work.
 * @returns {Promise<number>}
 */
export async function runContinueOnce(opts, env = process.env, hooks = {}) {
  const log = createLogger(opts);
  const { continueEnabled } = resolveLoopConfig(opts, env);
  return runContinue(opts, {
    log,
    env,
    continueEnabled,
    requirePool: hooks.requirePool === true,
    onSkip: hooks.onSkip,
    onAcquired: hooks.onAcquired,
  });
}
