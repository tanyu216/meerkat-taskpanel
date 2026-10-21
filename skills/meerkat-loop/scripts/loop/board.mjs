#!/usr/bin/env node
/**
 * The real board I/O behind the deterministic entries.
 *
 * `runners.mjs` holds the injected-dependency passes; this module wires them to
 * `taskctl` and the loop's own files. Only the entries import it.
 */

import { TASKD_KIND } from "../foundation/constants.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  buildSlaAlert,
  inspectorLivenessDetection,
  pruneSlaLedger,
} from "../foundation/sla-patrol.mjs";

import { notifySlaAlerts, runWorkflowTick, notifyReal } from "./runners.mjs";
import {
  loadSlaLedger,
  readPeerMarker,
  runCli,
  saveLastOk,
  saveSlaLedger,
} from "./runtime.mjs";

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
 * Read the board — the legacy stale-heartbeat patrol's input. The SLA rows come
 * from `sla list` (the board computes them); this one read is what the older
 * `{stale: […]}` envelope still uses, and its shape is a published consumer
 * contract.
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

/** The shared flag projection for the two SLA reads. */
function slaArgs(opts, periodSeconds) {
  const args = [];
  // An explicit flag overrides the board's own `TASKD_SLA_PERIOD_SECONDS`; the
  // default omits it, so two inspectors with different cadences stay comparable
  // through the board's configured period.
  if (opts.patrolIntervalExplicit === true) args.push("--period", String(periodSeconds));
  if (opts.slaLeader !== null) args.push("--leader", opts.slaLeader);
  return args;
}

/** Every open SLA row the board computes. */
export function readSlaAlerts(opts, periodSeconds = opts.patrolInterval) {
  return runCli(opts, opts.agents[0], [
    "sla",
    "list",
    ...slaArgs(opts, periodSeconds),
    "--limit",
    String(opts.boardLimit),
    "--trail-limit",
    String(opts.trailLimit),
  ]);
}

/** One card's rows — the pre-emit re-read. */
export function readSlaCard(opts, ref, periodSeconds = opts.patrolInterval) {
  return runCli(opts, opts.agents[0], ["sla", "get", ref, ...slaArgs(opts, periodSeconds)]);
}

/**
 * The SLA half of a patrol pass: ask the board for the rows, add this
 * mechanism's own peer-liveness row, let `notifySlaAlerts` de-duplicate and
 * re-check, then remember what went out.
 *
 * The board computes; the loop delivers. `inspector_liveness` is the one row
 * that stays here, because it watches a marker file on this host — the board
 * cannot see it. Its parameters still come from the board's published config.
 *
 * A failed read is **not** a silent skip: the caller turns this into a failed
 * patrol (exit 1), which is the visible signal a silent inspector must produce.
 */
export async function runSlaPass(opts, log, periodSeconds = opts.patrolInterval) {
  const read = readSlaAlerts(opts, periodSeconds);
  if (!read.ok) {
    log(`patrol: SLA read failed: ${read.error}`);
    return { ok: false };
  }
  const payload = read.data ?? {};
  const config = payload.config ?? {};
  const boardPeriod = Number.isFinite(config.period_seconds) && config.period_seconds > 0
    ? config.period_seconds
    : periodSeconds;
  const alerts = Array.isArray(payload.alerts) ? [...payload.alerts] : [];
  if (!Array.isArray(payload.alerts)) {
    log("patrol: the board published no sla alerts — treating this pass as empty");
  }
  if (payload.board_truncated === true) {
    log("patrol: the board snapshot was capped — a negative row predicate may be undecidable");
  }
  if (payload.trails_truncated === true) {
    log("patrol: the board capped its trail reads — some trail-derived rows may be unverified");
  }
  for (const warning of Array.isArray(payload.warnings) ? payload.warnings : []) {
    log(`patrol: ${warning}`);
  }

  const now = new Date().toISOString();
  const peer = opts.slaPeer === null ? null : readPeerMarker(opts.slaPeer);
  const liveness = inspectorLivenessDetection({
    peerLastOkAt: peer?.lastOk ?? null,
    now,
    k: config.peer_liveness_k,
    peerPeriodMinutes: peer?.periodMinutes ?? config.peer_period_min,
    peerRequired: opts.slaPeer !== null,
  });
  if (liveness !== null) {
    const alert = buildSlaAlert({
      id: BOARD_CARD_ID,
      detection: liveness,
      periodMin: boardPeriod / 60,
      mechanism: MECHANISM,
      mechanismHost: `${opts.host}/${opts.agents[0]}`,
      now,
    });
    if (alert !== null) alerts.push(alert);
  }

  const result = await notifySlaAlerts({
    alerts,
    ledger: loadSlaLedger(opts.slaLedger),
    mechanism: MECHANISM,
    mechanismHost: `${opts.host}/${opts.agents[0]}`,
    recheck: (ref) => {
      const live = readSlaCard(opts, ref, boardPeriod);
      if (!live.ok) return { checked: false };
      return { checked: true, alerts: Array.isArray(live.data?.alerts) ? live.data.alerts : [] };
    },
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
    // logged, never fatal — the peer's watchdog is what notices. The period is
    // the *effective* one (the board may have configured it).
    try {
      saveLastOk(opts.slaLastOk, {
        mechanism: MECHANISM,
        at: new Date().toISOString(),
        host: `${opts.host}/${opts.agents[0]}`,
        periodSeconds: boardPeriod,
      });
    } catch (err) {
      log(`patrol: could not publish the liveness marker (${err.message}) — the peer's watchdog may report this mechanism silent`);
    }
  }
  log(
    `patrol: sla ${result.alerts.length} alert(s), ${result.suppressed.length} suppressed, ` +
      `${result.dropped.length} dropped` +
      `${opts.slaPeer === null ? " [liveness: peer marker not configured — registered as a dependency]" : ""}`,
  );
  return { ok: true, ...result };
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
    ledger: loadSlaLedger(opts.workflowLedger),
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

  if (!opts.dryRun && typeof opts.workflowLedger === "string" && opts.workflowLedger !== "") {
    try {
      saveSlaLedger(
        opts.workflowLedger,
        pruneSlaLedger(result.ledger, { now: new Date().toISOString() }),
      );
    } catch (err) {
      log(
        `workflow: could not persist the workflow ledger (${err.message}) — ` +
          "a duplicate is possible, a lost alert is not",
      );
    }
  }

  log(
    `workflow: ${result.executed} action(s) executed, ${result.failed} failed, ` +
      `${result.alerts.length} alert(s)${opts.dryRun ? " (dry-run)" : ""}`,
  );
  return result;
}
