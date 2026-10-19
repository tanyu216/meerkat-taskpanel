#!/usr/bin/env node
/**
 * The loop's injected-dependency runners and process spawners.
 *
 * Everything in this module is the **I/O half** of a decision made in
 * `src/shared/`: the runners take their side effects as dependencies so tests
 * can prove "an empty scan spawns nothing" without a board. They are also the
 * legacy surface the supervisor re-exports, so existing tests keep importing
 * from `scripts/supervisor.mjs`.
 *
 * Node builtins only; no network, no dependencies.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync } from "node:fs";

import {
  buildHandoff,
  buildReviewHandoff,
  planPatrol,
  planTick,
  planWakeInvocation,
} from "../../src/shared/scheduling.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  partitionSlaAlerts,
  planSlaPatrol,
  recordSlaAlerts,
  stillQualifies,
} from "../../src/shared/sla-patrol.mjs";
import {
  LOOP_ACCEPTOR,
  isReviewCard,
  parseReviewVerdict,
  planWorkflowTick,
  reviewOf,
  reviewRoundOf,
} from "../../src/shared/workflow.mjs";

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
 * One SLA patrol pass — the `PROTOCOL §⑮` rows beside the heartbeat's.
 *
 * The order here is the contract's, and each step exists for a failure it
 * prevents:
 *
 *   1. **plan** — `planSlaPatrol` decides which (card, row) pairs have crossed a
 *      tier. An idle board plans nothing, which is the whole zero-cost property.
 *   2. **de-duplicate** — keys already in the ledger are dropped *before* any
 *      further reading, so a long-standing alert costs no provider read per tick.
 *   3. **re-check** — the survivors are re-read live and dropped if they no
 *      longer qualify, because the snapshot the plan was built from may be
 *      seconds old and notifying a card that just moved is the stale-alert bug
 *      this patrol already refuses to have. A drop is always returned.
 *   4. **notify, then record** — the ledger is written *after* the send. An
 *      alert a re-check removed must leave no marker behind, or the next tick
 *      would suppress an alert that was never delivered.
 *
 * Nothing here writes a card, and nothing here starts an LLM: the new rows are
 * notifications, full stop. (The opt-in `--patrol-llm` turn stays attached to
 * the legacy `stale` alert, where it was.)
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
    const verdict = stillQualifies(alert, live.card ?? null);
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
 * One workflow pass — the loop's *write* channel, beside the notify-only SLA
 * pass.
 *
 * This is the one place in the supervisor that moves cards, and the order is
 * the recovery protocol:
 *
 *   1. **reconcile** — `issue reconcile` decides container start/close; the
 *      pass only classifies what it reported. A failed reconcile is logged and
 *      the pass continues: outcomes do not depend on it.
 *   2. **read** — the originals a review card names but the snapshot lacks, and
 *      the reports of every `in_review` review card. Both are bounded.
 *   3. **plan** — `planWorkflowTick`; no write happens before it returns.
 *   4. **execute** — each action independently; one failure never stops the
 *      rest. A review card is closed *last*, so a crash between the original's
 *      move and the card's close is recovered on the next pass, never lost.
 *
 * `autoAcceptReviews = false` removes only step 4's review-card close: the
 * verdict on the original is still applied, and the card stays in `in_review`
 * for a human.
 *
 * @param {{
 *   tasks?: object[],
 *   reviewCards?: object[],
 *   config?: object,
 *   boardTruncated?: boolean,
 *   dryRun?: boolean,
 *   reconcile?: () => Promise<{ok: boolean, actions?: object[], error?: string}>,
 *   readCard?: (ref: string) => Promise<{ok: boolean, card?: object, error?: string}>,
 *   readReports?: (ref: string) => Promise<{ok: boolean, reports?: object[], error?: string}>,
 *   createReview?: (action: object) => Promise<{ok: boolean, ref?: string, error?: string}>,
 *   createFixChild?: (action: object) => Promise<{ok: boolean, ref?: string, error?: string}>,
 *   linkFixChild?: (epicRef: string, childRef: string) => Promise<{ok: boolean, error?: string}>,
 *   move?: (ref: string, to: string) => Promise<{ok: boolean, error?: string}>,
 *   comment?: (ref: string, input: {kind: string, body: string}) => Promise<{ok: boolean, error?: string}>,
 *   setMeta?: (ref: string, meta: Record<string, string>) => Promise<{ok: boolean, error?: string}>,
 *   notify?: (alert: object) => void,
 *   now: () => string,
 *   log: (line: string) => void,
 * }} deps
 */
export async function runWorkflowTick(deps) {
  const {
    tasks = [],
    reviewCards = [],
    config = {},
    boardTruncated = false,
    dryRun = false,
    reconcile = null,
    readCard = null,
    readReports = null,
    createReview = null,
    createFixChild = null,
    linkFixChild = null,
    move = null,
    comment = null,
    setMeta = null,
    notify = () => {},
    now,
    log,
  } = deps;

  const stamp = now();
  const disabled = { dryRun, actions: [], alerts: [], changes: [], executed: 0, failed: 0, summary: { actions: 0, alerts: 0 } };
  if (config.workflow !== true) return disabled;

  let reconcileActions = [];
  if (typeof reconcile === "function") {
    const result = await reconcile();
    if (result?.ok === false) {
      log(`workflow: reconcile failed (${result.error ?? "unknown"}) — continuing with outcomes`);
    } else {
      reconcileActions = Array.isArray(result?.actions) ? result.actions : [];
    }
  }

  // One snapshot, keyed by both identifier and id: `meta.review_of` may name
  // either, and the caller should never have to know which.
  const all = [];
  const byRef = new Map();
  const add = (task) => {
    const key = String(task?.identifier ?? "");
    if (key === "" || byRef.has(key)) return;
    all.push(task);
    byRef.set(key, task);
    if (typeof task.id === "string" && task.id !== "") byRef.set(task.id, task);
  };
  for (const task of tasks) add(task);
  for (const card of reviewCards) add(card);

  const budget = Number.isFinite(config.maxActions) && config.maxActions >= 0 ? config.maxActions : 20;

  // An original the board read did not include is read on demand — a review
  // card only names a string, and "unseen" must mean unread, not merely paged out.
  let cardReads = 0;
  for (const review of [...all]) {
    if (!isReviewCard(review) || review.status === "done" || review.status === "canceled") continue;
    const ref = reviewOf(review);
    if (byRef.has(ref)) continue;
    if (cardReads >= budget) {
      log(`workflow: original reads capped at ${budget} — ${ref} not read this pass`);
      break;
    }
    cardReads += 1;
    const read = typeof readCard === "function" ? await readCard(ref) : { ok: false, error: "readCard unavailable" };
    if (read?.ok === true && read.card) add(read.card);
    else log(`workflow: could not read original ${ref} (${read?.error ?? "not found"})`);
  }

  const verdicts = {};
  let reportReads = 0;
  for (const review of all) {
    if (!isReviewCard(review) || review.status !== "in_review") continue;
    const ref = String(review.identifier ?? "");
    if (ref === "") continue;
    if (reportReads >= budget) {
      verdicts[ref] = { ok: false, reason: "read_capped" };
      continue;
    }
    reportReads += 1;
    const read = typeof readReports === "function"
      ? await readReports(ref)
      : { ok: false, error: "readReports unavailable" };
    if (read?.ok !== true) {
      log(`workflow: report read failed for ${ref} (${read?.error ?? "unknown"})`);
      continue;
    }
    verdicts[ref] = parseReviewVerdict(read.reports ?? [], reviewRoundOf(review));
  }

  const plan = planWorkflowTick({
    tasks: all,
    verdicts,
    reconcileActions,
    config,
    boardTruncated,
    now: stamp,
  });

  for (const alert of plan.alerts) {
    log(`workflow: ${describeWorkflowAlert(alert)}`);
    // Standing-state notices (no reviewer configured, a capped pass, a review
    // waiting for a human by the operator's own `--auto-accept-reviews=no`)
    // would otherwise re-notify on every pass forever. They are logged;
    // only findings an operator can act on are notified.
    if (WORKFLOW_NOTIFY_TYPES.has(alert.type)) notify(alert);
  }
  for (const change of plan.changes) {
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

  // Closing the review card is the LAST write of every outcome, and the half
  // `autoAcceptReviews=no` removes. A review card that never started can only be
  // `canceled` (the state machine forbids `todo → done`); one waiting for
  // acceptance becomes `done`.
  const closeReviewCard = async (action, note) => {
    if (action.closeReview === false) {
      log(`workflow: review ${action.reviewRef} left in_review for human acceptance`);
      return;
    }
    const status = byRef.get(action.reviewRef)?.status;
    if (status === "done" || status === "canceled") return;
    if (status === "in_review") {
      if (note !== null) await step(comment, "comment", action.reviewRef, { kind: "note", body: note });
      await step(move, "move", action.reviewRef, "done");
      return;
    }
    await step(move, "move", action.reviewRef, "canceled");
  };

  for (const action of plan.actions) {
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
          await step(comment, "comment", action.originalRef, {
            kind: "note",
            body: `Loop acceptance after review ${action.reviewRef} (round ${action.round}): VERDICT: APPROVE.`,
          });
          await step(setMeta, "setMeta", action.originalRef, {
            accepted_by: LOOP_ACCEPTOR,
            accepted_round: String(action.round),
          });
          await step(move, "move", action.originalRef, "done");
          await closeReviewCard(
            action,
            `Loop auto-accepted this review card after applying VERDICT: APPROVE to ${action.originalRef}.`,
          );
          break;

        // `human-only` + a top-level original: record the verdict, close the
        // review card, and leave the acceptance to the human. The marker makes
        // the hold idempotent — a crash after the comment/meta, or a second
        // pass before the human acts, rewrites neither. The close is still the
        // last write, so a failure there is retried without repeating the rest.
        case "approve_hold": {
          const original = byRef.get(action.originalRef);
          const held =
            String(original?.meta?.review_verdict ?? "") === "approve" &&
            String(original?.meta?.review_verdict_round ?? "") === String(action.round);
          if (!held) {
            await step(comment, "comment", action.originalRef, {
              kind: "note",
              body:
                `Review ${action.reviewRef} (round ${action.round}): VERDICT: APPROVE. ` +
                `This board accepts top-level cards by a human, so the card is left in in_review for acceptance.`,
            });
            await step(setMeta, "setMeta", action.originalRef, {
              review_verdict: "approve",
              review_verdict_round: String(action.round),
            });
          }
          await closeReviewCard(
            action,
            `Loop recorded VERDICT: APPROVE for ${action.originalRef}; the card awaits human acceptance.`,
          );
          break;
        }

        case "reject_task": {
          const body = `VERDICT: REJECT (review ${action.reviewRef}, round ${action.round}).\n\n${
            action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
          }`;
          await step(comment, "comment", action.originalRef, { kind: "change", body });
          await step(setMeta, "setMeta", action.originalRef, { rework_round: String(action.reworkRound) });
          await step(move, "move", action.originalRef, "in_progress");
          await step(move, "move", action.originalRef, "todo");
          await closeReviewCard(
            action,
            `Loop closed this review card after moving ${action.originalRef} back to rework.`,
          );
          break;
        }

        case "reject_epic": {
          const body = `VERDICT: REJECT (review ${action.reviewRef}, round ${action.round}).\n\n${
            action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
          }`;
          const created = await step(createFixChild, "create_fix_child", action);
          const childRef = created?.ref ?? created?.identifier ?? created?.task?.identifier ?? null;
          if (childRef === null) throw new Error("create_fix_child returned no ref");
          await step(linkFixChild, "link_fix_child", action.originalRef, childRef);
          await step(comment, "comment", action.originalRef, { kind: "change", body });
          await step(setMeta, "setMeta", action.originalRef, { rework_round: String(action.reworkRound) });
          await step(move, "move", action.originalRef, "in_progress");
          await closeReviewCard(
            action,
            `Loop closed this review card after reopening ${action.originalRef} with fix child ${childRef}.`,
          );
          break;
        }

        case "reject_task_finish":
          await step(move, "move", action.originalRef, "todo");
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
      const ref = action.originalRef ?? action.reviewRef;
      log(
        `workflow: ${action.type} failed for ${ref} ` +
          `(${err.message}) — leaving the review card for the next pass`,
      );
      // A refusal that repeats every pass is a standing alarm, not a one-off:
      // `ACCEPTANCE_FORBIDDEN`/`CHILDREN_OPEN` mean this deployment's copy of
      // the policy (or the board's state) disagrees with the plan, and the loop
      // deliberately leaves the review card in place rather than forcing it.
      notify({ type: "workflow_action_failed", action: action.type, ref, error: err.message });
    }
  }

  return {
    dryRun,
    actions: plan.actions,
    alerts: plan.alerts,
    changes: plan.changes,
    executed,
    failed,
    summary: { ...plan.summary, executed, failed },
  };
}

/**
 * The workflow alerts worth a notification. The rest are log-only standing
 * state: `dispatch_skipped` (no reviewer configured, or a truncated read),
 * `dispatch_capped` (a bounded pass did less than asked) and
 * `review_awaiting_human_acceptance` (the operator chose `auto-accept=no`) are
 * conditions a tick cannot resolve and would repeat every period.
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
]);

function describeWorkflowAlert(alert) {
  const detail = alert.original ?? alert.epic ?? "";
  return `alert ${alert.type}${alert.reason === undefined ? "" : ` (${alert.reason})`}${detail === "" ? "" : ` ${detail}`}`;
}

function describeWorkflowAction(action) {
  switch (action.type) {
    case "create_review":
      return `create review ${action.idem} for ${action.originalRef}`;
    case "approve":
      return `approve ${action.originalRef} (round ${action.round}) and close ${action.reviewRef}`;
    case "approve_hold":
      return `record approval of ${action.originalRef} (round ${action.round}) and leave it for a human`;
    case "reject_task":
    case "reject_epic":
      return `${action.type} ${action.originalRef} (round ${action.round})`;
    case "reject_task_finish":
      return `finish the rework move for ${action.originalRef}`;
    case "close_review":
    case "cancel_review":
      return `${action.type} ${action.reviewRef} (${action.reason})`;
    default:
      return action.type;
  }
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
    // The resolved glue is `opts.glue` — the `--glue` flag, else the host default
    // `parseArgs` fills in. There is **no** `opts.gluePath`, and reading one here
    // handed the planner `undefined`: `existsSync(undefined)` (DEP0187) is false, so
    // `glueInstalled` was false on every wake and every wake took the direct branch.
    // An installed glue was named in the tick line and still never used — R1's "the
    // worker runs in the card's target directory" had silently stopped happening.
    // Read the field that is actually assigned.
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

    // The glue is a resolver, not a worker: it either resolves the card's target
    // directory, `cd`s, and execs the host CLI — or it refuses and exits 3 with
    // the reason on stderr. That reason has to reach a human, so a glue's stderr
    // is appended to the supervisor log; a parent process here cannot see it
    // otherwise (the child is detached), and a refused wake must never be silent.
    // A directly-spawned host CLI keeps its output discarded: a long-running
    // worker's chatter does not belong in the supervisor's log.
    const stderrFd = invocation.via === "glue" ? openAppendFd(opts.log) : null;
    const release = () => {
      if (stderrFd === null) return;
      try {
        closeSync(stderrFd);
      } catch {
        // Closing twice, or after a failed open, must never take the tick down.
      }
    };

    return new Promise((resolveResult) => {
      const child = spawn(invocation.command, invocation.args, {
        detached: true,
        stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
        // The identity rides in the environment so a glue (and the `wake-cwd`
        // helper behind it) can resolve the card's target directory locally.
        env: { ...process.env, ...invocation.env },
        ...(invocation.cwd === null ? {} : { cwd: invocation.cwd }),
      });
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
  };
}

export function notifyReal(opts, log) {
  return (alert) => {
    if (!opts.notify) return;
    const run = spawnSync(opts.notify, { shell: true, input: JSON.stringify(alert), encoding: "utf8" });
    if (run.error) log(`notify failed: ${run.error.message}`);
  };
}

/**
 * Start one continue turn and return as soon as the child exists.
 *
 * A continue turn is detached exactly like a worker wake: the supervisor does
 * not wait for it. Its stderr is appended to the loop log because a failed
 * host CLI is otherwise silent — the parent cannot see a detached child's
 * output.
 *
 * @param {{log: string}} opts
 * @param {{command: string, args: string[], env: Record<string,string>, cwd: string|null}} invocation
 * @param {(line: string) => void} log
 * @returns {Promise<{ok: boolean, pid?: number, error?: string}>}
 */
export function spawnContinueTurn(opts, invocation, log) {
  const stderrFd = openAppendFd(opts.log);
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
        // Closing twice must never take the turn down.
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
