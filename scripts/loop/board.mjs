#!/usr/bin/env node
/**
 * The real board I/O behind the deterministic entries.
 *
 * `runners.mjs` holds the injected-dependency passes; this module wires them to
 * `taskctl` and to the files the loop owns. It is deliberately separate from
 * the scheduler: the scheduler reads no board, and only the entries import
 * this module.
 *
 * Node builtins only; no network, no dependencies.
 */

import { MECHANISM, pruneSlaLedger, trailReadCandidates } from "../../src/shared/sla-patrol.mjs";

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
 * Read the board — patrol's input.
 *
 * One unfiltered read, not a read per status: the SLA rows span `blocked`,
 * `in_review` and `in_progress`, and the acceptance row needs the whole card set
 * anyway (its open predicate is "no card records `review_of = <this card>`").
 * `planPatrol` then narrows to `in_progress` exactly as it always did, so the
 * heartbeat half sees the same cards it saw before.
 */
export function readBoard(opts, log) {
  const read = runCli(opts, opts.agents[0], ["issue", "list", "--limit", String(opts.boardLimit)]);
  if (!read.ok) {
    log(`patrol scan failed: ${read.error}`);
    return { ok: false };
  }
  // A board read that came back exactly at the cap may have been cut off, and
  // one row's open predicate ("no fix card exists") is a *negative* over the
  // whole board — so the truncation has to travel with the data rather than be
  // rediscovered. The decision half then reports the affected row as open but
  // undecidable instead of quietly calling it decided (§6.3-B).
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

  // The peer's marker, read once (§8.4). No path configured means the peer's
  // half has not landed — the pass records that as an explicit dependency (a
  // startup line and the `--sla-peer` note) rather than alarming every period.
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
    // With no peer path configured the peer cannot be *required*: there is
    // nothing to read, and "absent ⇒ down" would be a permanent false alarm in
    // exactly the deployment that has not installed the peer yet.
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
    // Publish our own last-ok marker (§8.4). It is written **after** the pass,
    // so it means "a pass completed", and a failure to write it is logged but
    // never fatal — the peer's watchdog is what notices, and that is the point.
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
 * The review cards currently waiting for acceptance.
 *
 * A targeted read rather than a filter over the large board read: a workflow
 * pass must not miss a review card because the unfiltered snapshot was capped,
 * and "which cards still owe a verdict" is exactly a status query.
 */
export function readReviewCards(opts, log) {
  const read = runCli(opts, opts.agents[0], [
    "issue", "list", "--status", "in_review", "--limit", String(opts.boardLimit),
  ]);
  if (!read.ok) {
    log(`workflow: review-card read failed: ${read.error}`);
    return [];
  }
  return Array.isArray(read.data?.tasks) ? read.data.tasks : [];
}

/**
 * The real-I/O half of the workflow pass. Every write goes through `taskctl`
 * with `--actor-kind system`: an automated acceptance must be attributable as
 * the loop's act, not a human's (the board's default actor kind is `human`).
 */
export async function runWorkflowPass(opts, config, log, { tasks = [], boardTruncated = false } = {}) {
  if (config.workflow !== true) return null;
  const agent = opts.agents[0];
  const system = { actorKind: "system" };
  const invoke = (args) => runCli(opts, agent, args, system);

  const result = await runWorkflowTick({
    tasks,
    reviewCards: readReviewCards(opts, log),
    config,
    boardTruncated,
    dryRun: opts.dryRun,
    reconcile: () => {
      const read = invoke(["issue", "reconcile", ...(opts.dryRun ? ["--dry-run"] : [])]);
      return read.ok ? { ok: true, actions: read.data.actions ?? [] } : { ok: false, error: read.error };
    },
    readCard: (ref) => {
      const read = runCli(opts, agent, ["issue", "get", ref]);
      return read.ok ? { ok: true, card: read.data.task ?? null } : { ok: false, error: read.error };
    },
    readReports: (ref) => {
      const read = runCli(opts, agent, ["report", "list", ref]);
      return read.ok ? { ok: true, reports: read.data.reports ?? [] } : { ok: false, error: read.error };
    },
    createReview: (action) => {
      const read = invoke([
        "issue", "create",
        "--project", String(action.projectId ?? ""),
        "--kind", "task",
        "--title", action.title,
        "--description", action.description,
        "--assignee", action.reviewer,
        "--assignee-kind", "agent",
        "--label", "review",
        "--meta", `review_of=${action.originalRef}`,
        "--meta", "flow=B",
        "--meta", `review_round=${action.round}`,
        "--target", action.target,
        "--idem", action.idem,
        ...action.acceptance.flatMap((text) => ["--acceptance", text]),
      ]);
      return read.ok ? { ok: true, ref: read.data.task?.identifier ?? null } : { ok: false, error: read.error };
    },
    createFixChild: (action) => {
      const read = invoke([
        "issue", "create",
        "--project", String(action.projectId ?? ""),
        "--kind", "task",
        "--title", `Rework ${action.originalRef}: ${String(action.originalTitle ?? "").slice(0, 100)}`,
        "--description",
        `Rejected by review ${action.reviewRef} (round ${action.round}).\n\n${
          action.findings === "" ? "(the reviewer recorded no findings)" : action.findings
        }`,
        ...(action.assigneeId === null ? [] : ["--assignee-id", String(action.assigneeId)]),
        "--meta", `rework_of=${action.originalRef}`,
        "--meta", `rework_round=${action.reworkRound}`,
        "--target", `rework:${action.originalRef}:r${action.reworkRound}`,
        "--idem", `loop-rework|${action.originalRef}|r${action.reworkRound}`,
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
    now: () => new Date().toISOString(),
    log,
  });

  log(
    `workflow: ${result.executed} action(s) executed, ${result.failed} failed, ` +
      `${result.alerts.length} alert(s)${opts.dryRun ? " (dry-run)" : ""}`,
  );
  return result;
}
