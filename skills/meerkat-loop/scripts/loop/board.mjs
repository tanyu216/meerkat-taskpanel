#!/usr/bin/env node
/**
 * The real board I/O behind the deterministic entries.
 *
 * `runners.mjs` holds the injected-dependency passes; this module wires them to
 * `taskctl` and the loop's own files. Only the entries import it.
 */

import { TASKD_KIND } from "../foundation/constants.mjs";
import { MECHANISM, pruneSlaLedger, trailReadCandidates } from "../foundation/sla-patrol.mjs";

import { runSlaPatrolTick, runWorkflowTick, notifyReal } from "./runners.mjs";
import {
  loadSlaLedger,
  readPeerLastOk,
  runCli,
  saveLastOk,
  saveSlaLedger,
} from "./runtime.mjs";

/** How many comments of one card a trail read asks for. */
const COMMENTS_PER_CARD = 200;

/**
 * The `issue create` argv for one review card.
 *
 * `review_of` / `review_round` are declared create fields: the board resolves
 * them and mirrors the meta keys itself. Do not write those meta keys here.
 */
export function reviewCreateArgs(action) {
  return [
    "issue", "create",
    "--project", String(action.project_id ?? ""),
    "--kind", "task",
    "--title", action.title,
    "--description", action.description,
    "--assignee", action.reviewer,
    "--assignee-kind", "agent",
    "--label", "review",
    "--meta", "flow=B",
    "--review-of", action.original_ref,
    "--review-round", String(action.round),
    "--target", action.target,
    "--idem", action.idem,
    ...action.acceptance.flatMap((text) => ["--acceptance", text]),
  ];
}

/**
 * Read the board — patrol's input. One unfiltered read: the SLA rows span
 * `blocked`, `in_review` and `in_progress`, and the acceptance row needs the
 * whole set. `truncated` travels with the data: a read exactly at the cap may
 * have been cut off, and one row's predicate is negative over the whole board.
 */
export function readBoard(opts, log) {
  const read = runCli(opts, opts.agents[0], ["issue", "list", "--limit", String(opts.boardLimit)]);
  if (!read.ok) {
    log(`patrol scan failed: ${read.error}`);
    return { ok: false };
  }
  const tasks = Array.isArray(read.data?.tasks) ? read.data.tasks : [];
  return { ...read, truncated: tasks.length >= opts.boardLimit };
}

/** One card's comment trail, or `null` when it could not be read. */
export function readTrail(opts, log, identifier) {
  const read = runCli(opts, opts.agents[0], ["comment", "list", identifier, "--limit", String(COMMENTS_PER_CARD)]);
  if (!read.ok) {
    log(`patrol: comment read failed for ${identifier}: ${read.error}`);
    return null;
  }
  return read.data.comments ?? [];
}

/** A candidate's live state for the pre-emit re-check; `checked:false` ⇒ unverifiable. */
export function readLiveCard(opts, log, identifier) {
  const read = runCli(opts, opts.agents[0], ["issue", "get", identifier]);
  if (!read.ok) {
    log(`patrol: live re-check failed for ${identifier}: ${read.error}`);
    return { checked: false };
  }
  return { checked: true, card: read.data.task ?? null };
}

/**
 * The SLA half of a patrol pass: read the trails the rows need, decide, re-check
 * the candidates, notify, and remember what was notified.
 */
export async function runSlaPass(opts, log, tasks, periodSeconds, { boardTruncated = false } = {}) {
  const wanted = trailReadCandidates(tasks, { now: new Date().toISOString(), periodSeconds });
  const trails = {};
  const budget = Math.max(0, opts.trailLimit);
  const selected = wanted.slice(0, budget);
  if (wanted.length > selected.length) {
    // Never silent: a capped pass says so rather than looking like a quiet board.
    log(`patrol: trail reads capped at ${budget} — ${wanted.length - selected.length} card(s) not inspected this pass`);
  }
  let trailFailures = 0;
  for (const identifier of selected) {
    const trail = readTrail(opts, log, identifier);
    if (trail === null) trailFailures += 1;
    else trails[identifier] = trail;
  }

  // No peer path means the peer is not installed: record a dependency, not an alarm.
  const peerLastOkAt = opts.slaPeer === null ? null : readPeerLastOk(opts.slaPeer);

  const result = await runSlaPatrolTick({
    cards: tasks,
    trails,
    ledger: loadSlaLedger(opts.slaLedger),
    periodSeconds,
    mechanismHost: `${opts.host}/${opts.agents[0]}`,
    leaderId: opts.slaLeader,
    boardTruncated,
    peerLastOkAt,
    peerRequired: opts.slaPeer !== null,
    lookbackDays: opts.slaLookbackDays,
    recheck: (identifier) => Promise.resolve(readLiveCard(opts, log, identifier)),
    notify: opts.dryRun ? () => {} : notifyReal(opts, log),
    now: () => new Date().toISOString(),
    log,
  });

  if (!opts.dryRun) {
    try {
      saveSlaLedger(opts.slaLedger, pruneSlaLedger(result.ledger, { now: new Date().toISOString() }));
    } catch (err) {
      log(`patrol: could not persist the SLA ledger (${err.message}) — a duplicate is possible, a lost alert is not`);
    }
    // Written after the pass, so it means "a pass completed". A failed write is
    // logged, never fatal — the peer's watchdog is what notices.
    try {
      saveLastOk(opts.slaLastOk, {
        mechanism: MECHANISM,
        at: new Date().toISOString(),
        host: `${opts.host}/${opts.agents[0]}`,
        periodSeconds,
      });
    } catch (err) {
      log(`patrol: could not publish the liveness marker (${err.message}) — the peer's watchdog may report this mechanism silent`);
    }
  }
  log(
    `patrol: sla ${result.alerts.length} alert(s), ${result.suppressed.length} suppressed, ` +
      `${result.dropped.length} dropped, ${trailFailures} trail read(s) failed` +
      `${opts.slaPeer === null ? " [liveness: peer marker not configured — registered as a dependency]" : ""}`,
  );
  return result;
}

/**
 * The real-I/O half of the workflow pass. Every write goes through `taskctl`
 * as `--actor-kind taskd`, so an automated acceptance is attributable as the
 * board's act, not a human's.
 */
export async function runWorkflowPass(opts, config, log) {
  if (config.workflow !== true) return null;
  const agent = opts.agents[0];
  const automation = { actorKind: TASKD_KIND };
  const invoke = (args) => runCli(opts, agent, args, automation);

  // One call does the board's container reconcile and returns the plan.
  const args = ["issue", "reconcile", "--workflow"];
  if (opts.dryRun) args.push("--dry-run");
  if (config.reviewer !== null) args.push("--reviewer", config.reviewer);
  args.push("--auto-accept-reviews", config.autoAcceptReviews === false ? "no" : "yes");
  args.push("--review-aging-ms", String(config.reviewAgingMs));
  args.push("--max-actions", String(config.maxActions));
  args.push("--board-limit", String(opts.boardLimit));

  const planRead = invoke(args);
  const planData = planRead.ok ? planRead.data ?? {} : null;
  if (planData === null || planData.workflow === undefined || planData.workflow === null) {
    log(
      `workflow: issue reconcile --workflow returned no plan ` +
        `(${planRead.ok ? "the board did not answer with a workflow plan" : planRead.error ?? "unknown"})`,
    );
    return {
      dryRun: opts.dryRun,
      actions: [],
      alerts: [],
      changes: [],
      executed: 0,
      failed: 1,
      summary: { actions: 0, alerts: 0 },
    };
  }
  log(
    `workflow: reconcile${opts.dryRun ? " (dry-run)" : ""} ${planData.scanned ?? 0} container(s), ` +
      `${Array.isArray(planData.actions) ? planData.actions.length : 0} action(s)`,
  );

  const result = await runWorkflowTick({
    plan: planData.workflow,
    config,
    dryRun: opts.dryRun,
    createReview: (action) => {
      const read = invoke(reviewCreateArgs(action));
      return read.ok ? { ok: true, ref: read.data.task?.identifier ?? null } : { ok: false, error: read.error };
    },
    createFixChild: (action) => {
      const read = invoke([
        "issue", "create",
        "--project", String(action.project_id ?? ""),
        "--kind", "task",
        "--title", `Rework ${action.original_ref}: ${String(action.original_title ?? "").slice(0, 100)}`,
        "--description",
        `Rejected by review ${action.review_ref} (round ${action.round}).\n\n${
          action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
        }`,
        ...(action.assignee_id === null ? [] : ["--assignee-id", String(action.assignee_id)]),
        "--meta", `rework_of=${action.original_ref}`,
        "--meta", `rework_round=${action.rework_round}`,
        "--target", `rework:${action.original_ref}:r${action.rework_round}`,
        "--idem", `loop-rework|${action.original_ref}|r${action.rework_round}`,
      ]);
      return read.ok ? { ok: true, ref: read.data.task?.identifier ?? null } : { ok: false, error: read.error };
    },
    linkFixChild: (epicRef, childRef) => {
      const listed = runCli(opts, agent, ["relation", "list", epicRef]);
      if (listed.ok && Array.isArray(listed.data.children) && listed.data.children.some((edge) => edge.target === childRef)) {
        return { ok: true };
      }
      const added = invoke(["relation", "add", epicRef, "--type", "parent", "--target", childRef]);
      return added.ok ? { ok: true } : { ok: false, error: added.error };
    },
    move: (ref, to) => {
      const read = invoke(["issue", "move", ref, to]);
      return read.ok ? { ok: true } : { ok: false, error: read.error };
    },
    comment: (ref, { kind, body }) => {
      const read = invoke(["comment", "add", ref, "--kind", kind, "--body", body]);
      return read.ok ? { ok: true } : { ok: false, error: read.error };
    },
    setMeta: (ref, meta) => {
      // `issue meta` merges. `issue update --meta` replaces the whole object,
      // which would erase the card's acceptance list, target and review keys.
      const read = invoke([
        "issue", "meta", ref,
        ...Object.entries(meta).flatMap(([key, value]) => ["--meta", `${key}=${value}`]),
      ]);
      return read.ok ? { ok: true } : { ok: false, error: read.error };
    },
    notify: opts.dryRun ? () => {} : notifyReal(opts, log),
    log,
  });

  log(
    `workflow: ${result.executed} action(s) executed, ${result.failed} failed, ` +
      `${result.alerts.length} alert(s)${opts.dryRun ? " (dry-run)" : ""}`,
  );
  return result;
}
