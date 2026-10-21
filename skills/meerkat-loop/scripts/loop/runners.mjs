#!/usr/bin/env node
/**
 * The loop's runners and process spawners.
 *
 * The runners take their side effects as dependencies, so a test can prove
 * "an empty scan spawns nothing" without a board.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync } from "node:fs";

import {
  buildHandoff,
  buildReviewHandoff,
  planPatrol,
  planTick,
  planWakeInvocation,
} from "../foundation/scheduling.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  partitionSlaAlerts,
  planSlaPatrol,
  recordSlaAlerts,
  stillQualifies,
} from "../foundation/sla-patrol.mjs";
import { openAppendFd } from "./runtime.mjs";

/**
 * One poll pass.
 *
 * @param {{
 *   agents: string[],
 *   registry: object,
 *   config: object,
 *   readCandidates: (agent: string, opts: {claimUnassigned: boolean}) => Promise<object[]>,
 *   claim: (identifier: string, agent: string) => Promise<{ok: boolean, error?: string}>,
 *   spawnWorker: (action: object, card: object|undefined) => Promise<{ok: boolean, pid?: number, error?: string}>,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runPollTick(deps) {
  const { agents, registry, config, readCandidates, claim, spawnWorker, now, log } = deps;

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

  for (const action of actions) {
    if (action.type === "skip") {
      log(`skip ${action.identifier} (${action.why})`);
      continue;
    }

    // Atomic claim first: the board (not the supervisor) decides the winner.
    const verdict = await claim(action.identifier, action.agent);
    if (!verdict?.ok) {
      conflicts += 1;
      log(`claim refused ${action.identifier} (${verdict?.error ?? "conflict"}) — not waking`);
      continue;
    }
    claimed += 1;

    const outcome = await spawnWorker(action, cardById.get(action.identifier));
    if (!outcome?.ok) {
      // Honest failure: a card we could not wake is not "running".
      failed += 1;
      log(`wake failed ${action.identifier}: ${outcome?.error ?? "unknown error"}`);
      continue;
    }
    spawned += 1;
    if (outcome.pid !== undefined && outcome.pid !== null) {
      registry.running[action.identifier] = { agent: action.agent, pid: outcome.pid, startedAt: now() };
    }
    log(`woke ${action.identifier} for ${action.agent} (${action.reason})${outcome.pid ? ` pid ${outcome.pid}` : " [dry-run]"}`);
  }

  return { actions, spawned, claimed, conflicts, failed };
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
 * One SLA patrol pass.
 *
 * The order is load-bearing: plan → drop already-notified keys → re-read the
 * survivors live (a card that just moved must not alert) → notify, *then*
 * record. Writing the ledger before the send would suppress an alert that was
 * never delivered. Nothing here writes a card or starts an LLM.
 *
 * @param {{
 *   cards: object[],
 *   trails: Record<string, object[]>,
 *   ledger: object,
 *   periodSeconds: number,
 *   mechanismHost: string|null,
 *   leaderId?: string|null,
 *   boardTruncated?: boolean,
 *   peerLastOkAt?: string|number|null,
 *   peerRequired?: boolean,
 *   recheck: (cardId: string) => Promise<{checked: boolean, card?: object|null}>,
 *   notify: (alert: object) => void,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runSlaPatrolTick(deps) {
  const { cards, trails, ledger, periodSeconds, mechanismHost, recheck, notify, now, log } = deps;
  const { recheckTrail = null } = deps;
  const stamp = now();
  const planned = planSlaPatrol({
    cards,
    trails,
    now: stamp,
    periodSeconds,
    mechanismHost: mechanismHost ?? null,
    leaderId: deps.leaderId ?? null,
    boardTruncated: deps.boardTruncated === true,
    peerLastOkAt: deps.peerLastOkAt ?? null,
    peerPeriodMinutes: deps.peerPeriodMinutes ?? null,
    peerRequired: deps.peerRequired === true,
    lookbackDays: deps.lookbackDays,
  });

  const { notify: fresh, suppressed } = partitionSlaAlerts(planned.alerts, ledger);
  for (const alert of suppressed) {
    log(`patrol: sla ${alert.alert_id} (${alert.severity}) already notified — suppressed`);
  }

  const dropped = [];
  const survivors = [];
  for (const alert of fresh) {
    // A board-level row (`leader_stalled`, `inspector_liveness`) names no card,
    // so there is nothing to re-read — and asking the provider for the sentinel
    // would log a failure that is not one. §9.6's second look is about *card*
    // rows; these go straight through, which is also what §9.3 requires when a
    // re-check cannot be performed.
    if (alert.card_id === BOARD_CARD_ID) {
      survivors.push(alert);
      continue;
    }
    const live = await recheck(alert.card_id);
    // A re-check that could not run must never be able to silence a real alert
    // (§9.3): an unverifiable card is notified, not dropped. Only a *successful*
    // read that shows the card has moved is grounds for a drop.
    if (live?.checked !== true) {
      log(`patrol: re-check unavailable for ${alert.card_id} — notifying anyway`);
      survivors.push(alert);
      continue;
    }
    const liveCard = live.card ?? null;
    let verdict = stillQualifies(alert, liveCard);
    // A gate's "answered" state is a trail fact the single-card read cannot see.
    // Only a fresh gate alert pays for the second read; a failed one keeps the
    // alert (§9.3 — an unreadable check must never silence a real one).
    if (verdict.ok && alert.sla_row === "confirmation_gate" && typeof recheckTrail === "function") {
      const trailRead = await recheckTrail(alert.card_id);
      if (trailRead?.checked === true) {
        verdict = stillQualifies(alert, liveCard, {
          trail: trailRead.trail,
          leaderId: deps.leaderId ?? null,
        });
      } else {
        log(`patrol: live trail re-check unavailable for ${alert.card_id} — notifying anyway`);
      }
    }
    if (verdict.ok) survivors.push(alert);
    else dropped.push({ card_id: alert.card_id, sla_row: alert.sla_row, reason: verdict.reason });
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
 * `autoAcceptReviews=false` is already in each action's `close_review`.
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
  // Standing-state notices (no reviewer configured, a capped pass, a review
  // waiting for a human by the operator's own --auto-accept-reviews=no)
  // would otherwise re-notify on every pass forever. They are logged; only
  // findings an operator can act on are notified.
  notifyBatch(alerts.filter((alert) => WORKFLOW_NOTIFY_TYPES.has(alert.type)));
  for (const change of changes) {
    log(`workflow: reconcile ${change.action} ${change.epic} (${change.reason})`);
  }

  let executed = 0;
  let failed = 0;

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
    if (action.close_review === false) {
      log(`workflow: review ${action.review_ref} left in_review for human acceptance`);
      return;
    }
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

        // `human-only` + a top-level original: record the verdict, close the
        // review card, leave acceptance to the human. `held` (from the board,
        // which compared the marker with the current round) skips the writes.
        case "approve_hold": {
          if (action.held !== true) {
            await step(comment, "comment", action.original_ref, {
              kind: "note",
              body:
                `Review ${action.review_ref} (round ${action.round}): VERDICT: APPROVE. ` +
                `This board accepts top-level cards by a human, so the card is left in in_review for acceptance.`,
            });
            await step(setMeta, "setMeta", action.original_ref, {
              review_verdict: "approve",
              review_verdict_round: String(action.round),
            });
          }
          await closeReviewCard(
            action,
            `Loop recorded VERDICT: APPROVE for ${action.original_ref}; the card awaits human acceptance.`,
          );
          break;
        }

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
      failed += 1;
      const ref = action.original_ref ?? action.review_ref;
      log(
        `workflow: ${action.type} failed for ${ref} ` +
          `(${err.message}) — leaving the review card for the next pass`,
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
    summary: { ...(plan.summary ?? {}), executed, failed },
    ledger: workingLedger,
  };
}

/**
 * Alerts worth a notification. The rest are log-only standing state
 * (`dispatch_skipped`, `dispatch_capped`, `review_awaiting_human_acceptance`):
 * a tick cannot resolve them, so notifying would repeat every period.
 * A state-based alert may still notify once when the ledger keys it to the
 * state rather than the clock (`actions_capped`, `review_cards_unclosable`).
 */
const WORKFLOW_NOTIFY_TYPES = new Set([
  "reconcile",
  "self_review_not_independent",
  "review_done_but_original_open",
  "verdict_unreadable",
  "verdict_conflict",
  "review_report_not_by_reviewer",
  "review_aging",
  "original_unseen",
  "original_unexpected_status",
  "review_stale_round",
  "actions_capped",
  "review_cards_unclosable",
]);

function describeWorkflowAlert(alert) {
  const detail = alert.original ?? alert.epic ?? "";
  return `alert ${alert.type}${alert.reason === undefined ? "" : ` (${alert.reason})`}${detail === "" ? "" : ` ${detail}`}`;
}

function describeWorkflowAction(action) {
  switch (action.type) {
    case "create_review":
      return `create review ${action.idem} for ${action.original_ref}`;
    case "approve":
      return `approve ${action.original_ref} (round ${action.round}) and close ${action.review_ref}`;
    case "approve_hold":
      return `record approval of ${action.original_ref} (round ${action.round}) and leave it for a human`;
    case "reject_task":
    case "reject_epic":
      return `${action.type} ${action.original_ref} (round ${action.round})`;
    case "reject_task_finish":
      return `finish the rework move for ${action.original_ref}`;
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

export function spawnWorkerReal(opts, config, log) {
  return (action, card) => {
    // A review card takes the reviewer handoff. The candidate projection carries
    // `review_of`, so the decision needs no second read; the agent-name fallback
    // keeps an older projection (one written before those fields existed) working
    // for a dedicated reviewer.
    const reviewer = config.reviewer ?? null;
    const dedicatedReviewer =
      reviewer !== null && config.reviewerIsWorker !== true && action.agent === reviewer;
    const isReview = (typeof card?.review_of === "string" && card.review_of !== "") || dedicatedReviewer;
    const prompt = isReview
      ? buildReviewHandoff({ card: card ?? { identifier: action.identifier }, agent: action.agent, host: opts.host })
      : buildHandoff({
          card: card ?? { identifier: action.identifier },
          agent: action.agent,
          host: opts.host,
          review: reviewer !== null,
        });
    // The parsed field is `opts.glue`; there is no `gluePath`.
    const invocation = planWakeInvocation({
      host: opts.host,
      prompt,
      wakeCommand: config.wakeCommand ?? null,
      gluePath: opts.glue,
      glueInstalled: opts.glue !== null && existsSync(opts.glue),
      project: card?.project ?? null,
      projectsJson: opts.projectsJson,
      nodePath: process.execPath,
      cwd: opts.repo,
    });
    if (invocation.warning) log(`wake ${action.identifier}: ${invocation.warning}`);

    // A glue's refusal explains itself on stderr; append it to the loop log, or
    // a refused wake is silent. A directly-spawned CLI's chatter is discarded.
    const stderrFd = invocation.via === "glue" ? openAppendFd(opts.log) : null;
    return spawnDetached(invocation, stderrFd);
  };
}

/** A notify command may hang; the pass must not hang with it. */
export const NOTIFY_TIMEOUT_MS = 10_000;

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
      log(`notify failed: ${run.error.message}`);
    } else if (run.status !== 0) {
      log(`notify exited ${run.status}`);
    }
  };
}

/**
 * Start one continue turn and return as soon as the child exists. Its stderr
 * goes to the loop log, or a failed host CLI would be silent.
 *
 * @param {{log: string}} opts
 * @param {{command: string, args: string[], env: Record<string,string>, cwd: string|null}} invocation
 * @param {(line: string) => void} log
 * @returns {Promise<{ok: boolean, pid?: number, error?: string}>}
 */
export function spawnContinueTurn(opts, invocation, log) {
  return spawnDetached(invocation, openAppendFd(opts.log));
}
