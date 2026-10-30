#!/usr/bin/env node
/**
 * The real board I/O behind the deterministic passes.
 *
 * `runners.mjs` holds the injected-dependency passes; this module wires them to
 * `taskctl` and the loop's own files. Only the entries import it.
 */

import { dirname } from "node:path";

import { ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
import { resolveWakeTarget } from "../foundation/project-dir.mjs";
import { planStrandedTodoAlerts } from "../foundation/scheduling.mjs";
import { reviewIdentityOf } from "../foundation/review-identity.mjs";
import {
  BOARD_CARD_ID,
  MECHANISM,
  buildSlaAlert,
  inspectorLivenessDetection,
  pruneSlaLedger,
} from "../foundation/sla-patrol.mjs";

import { isQuestionSettled, newestQuestion } from "./questions.mjs";
import { findWorkspace, mergeWorkspace } from "./workspace.mjs";
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
/**
 * A board refusal, keeping the code and the item list the loop classifies on.
 *
 * `runCli` reads the whole error envelope; every seam used to forward only the
 * message, so the executor's `err.code` was always `undefined` and the codes it
 * branches on (`EXPECTED_ACCEPTANCE_SKIP_CODES`, `ACCEPTANCE_INCOMPLETE`) could
 * never match. The readable `error` stays first: callers log it verbatim.
 */
export function boardRefusal(read) {
  if (!read || read.error === undefined) return read;
  return {
    ok: false,
    error: read.error,
    ...(typeof read.code === "string" ? { code: read.code } : {}),
    ...(read.details === undefined ? {} : { details: read.details }),
    ...(read.hint === undefined ? {} : { hint: read.hint }),
  };
}

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
    // 0038 — a review card is flow B and is never itself reviewed.
    "--acceptance-mode", "off",
    "--meta", "flow=B",
    "--review-of", action.original_ref,
    "--review-round", String(action.round),
    "--target", action.target,
    "--idem", action.idem,
    ...action.acceptance.flatMap((text) => ["--acceptance", text]),
  ];
}

/**
 * Read every project's reviewer override (0031).
 *
 * The loop uses this at start-up to merge project reviewers into its scan/wake
 * set and to fail fast when a `required` project has no effective reviewer. It
 * is a board read, so a failure is returned rather than thrown; the caller
 * decides whether it can continue (the workflow pass cannot enforce the
 * required-project promise without it).
 *
 * @param {object} opts
 * @param {(message: string) => void} log
 * @returns {{ok: boolean, projects: object[], error?: string}}
 */
export function readProjectReviewers(opts, log) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, projects: [], error: "no agent configured" };
  const read = runCli(opts, agent, ["project", "list"]);
  if (!read.ok) {
    log(`project list failed: ${read.error}`);
    return { ok: false, projects: [], error: read.error };
  }
  return { ok: true, projects: Array.isArray(read.data?.projects) ? read.data.projects : [] };
}

/** A non-empty trimmed string, or `null`. */
function textOf(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Every `in_progress` card whose newest agent question nobody has answered.
 *
 * The question lane's input. A review card is skipped (a reviewer never asks)
 * and so is an epic (it is not a worker's card). The read is bounded by
 * `--board-limit`; one card whose comments cannot be read is logged and
 * skipped, not fatal.
 *
 * @param {object} opts
 * @param {(message: string) => void} log
 * @param {Function} [run] the `runCli` seam, injectable for tests
 * @returns {{ok: boolean, rows: object[], error: string|null}}
 */
export function readOpenQuestions(opts, log, run = runCli) {
  const agent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : null;
  if (agent === null) return { ok: false, rows: [], error: "no agent configured" };
  const read = run(opts, agent, [
    "issue",
    "list",
    "--status",
    "in_progress",
    "--limit",
    String(opts.boardLimit),
  ]);
  if (!read.ok) {
    log(`question lane: issue list failed: ${read.error}`);
    return { ok: false, rows: [], error: read.error };
  }
  const tasks = Array.isArray(read.data?.tasks) ? read.data.tasks : [];
  const rows = [];
  for (const task of tasks) {
    if (textOf(task?.kind) === "epic") continue;
    // A review card has no question lane of its own; the one identity reader
    // agrees with the workflow and the SLA patrol on what "is a review" means.
    if (reviewIdentityOf(task).isReview) continue;
    const project = textOf(task?.project);
    const ref = textOf(task?.identifier);
    if (project === null || ref === null) continue;

    const comments = run(opts, agent, ["comment", "list", ref, "--limit", "20"]);
    if (!comments.ok) {
      log(`question lane: ${ref} comments unreadable: ${comments.error}`);
      continue;
    }
    const list = Array.isArray(comments.data?.comments) ? comments.data.comments : [];
    const question = newestQuestion(list);
    if (question === null || isQuestionSettled(list, question)) continue;

    rows.push({
      ref,
      project,
      agent: textOf(task?.assignee?.display_name) ?? textOf(task?.assignee?.id) ?? agent,
      question_id: textOf(question?.id) ?? `${ref}:${String(question?.created_at ?? "")}`,
      body: String(question?.body ?? ""),
      asked_at: textOf(question?.created_at),
    });
  }
  return { ok: true, rows, error: null };
}

/**
 * Read the board — the legacy stale-heartbeat patrol's input. The SLA rows come
 * from `sla list` (the board computes them); this one read is what the older
 * per-card heartbeat alert stream (`{type: "stale" | "heartbeat-unreadable", …}`)
 * still uses, and its shape is a published consumer contract.
 */
export function readBoard(opts, log) {
  const read = runCli(opts, opts.agents[0], ["issue", "list", "--limit", String(opts.boardLimit)]);
  if (!read.ok) {
    log(`patrol scan failed: ${read.error}`);
    // The message rides on the result too: a caller that shows the report to a
    // human (the doctor) cannot read the patrol's log.
    return { ok: false, error: read.error };
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
      mechanismActor: `${opts.actorKind}/${opts.agents[0]}`,
      now,
    });
    if (alert !== null) alerts.push(alert);
  }

  const result = await notifySlaAlerts({
    alerts,
    ledger: loadSlaLedger(opts.slaLedger),
    mechanism: MECHANISM,
    mechanismActor: `${opts.actorKind}/${opts.agents[0]}`,
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
        actor: `${opts.actorKind}/${opts.agents[0]}`,
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
 * as the board's own kind (`system`), under the automation identity
 * `Orchestrator`: an automated acceptance is the board's act, not a human's and
 * not the first worker's — and not the reviewer's either, which matters because
 * the actor who wrote a verdict may not close the card it reviewed.
 */
/**
 * The `todo` cards no scan can claim, read from the board and turned into
 * workflow alerts. Two reads: the whole `todo` set — an assignee outside the scan
 * set strands a card whatever the pool policy — and, only under
 * `claim_unassigned: no`, the public pool, where being unowned is the normal
 * state rather than a defect.
 */
function strandedTodoAlerts(opts, config, invoke, log) {
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const agent = agents[0];
  if (typeof agent !== "string" || agent === "") return [];
  const todoRead = invoke(["issue", "list", "--status", "todo", "--limit", String(opts.boardLimit)]);
  if (!todoRead.ok) {
    log(`workflow: stranded-todo read failed (${todoRead.error ?? "unknown"})`);
    return [];
  }
  const todoTasks = Array.isArray(todoRead.data?.tasks) ? todoRead.data.tasks : [];
  let unassignedPool = [];
  if (config.claimUnassigned === false) {
    const poolRead = invoke(["issue", "candidates", "--assignee", agent, "--include-unassigned"]);
    if (poolRead.ok) {
      unassignedPool = Array.isArray(poolRead.data?.candidates) ? poolRead.data.candidates : [];
    } else {
      log(`workflow: stranded-pool read failed (${poolRead.error ?? "unknown"})`);
    }
  }
  return planStrandedTodoAlerts({
    todoTasks,
    unassignedPool,
    agents,
    reviewer: config.reviewer,
    claimUnassigned: config.claimUnassigned,
    now: Date.now(),
  });
}

export async function runWorkflowPass(opts, config, log) {
  if (config.workflow !== true) return null;
  const automation = { actorKind: SYSTEM_KIND };
  const invoke = (args) => runCli(opts, ORCHESTRATOR_ACTOR_ID, args, automation);

  // One call does the board's container reconcile and returns the plan.
  const args = ["issue", "reconcile", "--workflow"];
  if (opts.dryRun) args.push("--dry-run");
  if (config.reviewer !== null) args.push("--reviewer", config.reviewer);
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

  // Stranded `todo` cards ride with the board's plan: the workflow tick logs and
  // notifies every alert the same way, and the ledger de-duplicates them by state.
  const stranded = strandedTodoAlerts(opts, config, invoke, log);
  const workflowPlan = stranded.length === 0
    ? planData.workflow
    : {
        ...planData.workflow,
        alerts: [...(Array.isArray(planData.workflow.alerts) ? planData.workflow.alerts : []), ...stranded],
      };

  const result = await runWorkflowTick({
    plan: workflowPlan,
    config,
    dryRun: opts.dryRun,
    ledger: loadSlaLedger(opts.workflowLedger),
    createReview: (action) => {
      const read = invoke(reviewCreateArgs(action));
      return read.ok ? { ok: true, ref: read.data.task?.identifier ?? null } : boardRefusal(read);
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
        // 0038 — a fix child is a loop artifact: no review, no human gate.
        "--acceptance-mode", "off",
        "--meta", `rework_of=${action.original_ref}`,
        "--meta", `rework_round=${action.rework_round}`,
        "--target", `rework:${action.original_ref}:r${action.rework_round}`,
        "--idem", `loop-rework|${action.original_ref}|r${action.rework_round}`,
      ]);
      return read.ok ? { ok: true, ref: read.data.task?.identifier ?? null } : boardRefusal(read);
    },
    linkFixChild: (epicRef, childRef) => {
      const listed = runCli(opts, ORCHESTRATOR_ACTOR_ID, ["relation", "list", epicRef]);
      if (listed.ok && Array.isArray(listed.data.children) && listed.data.children.some((edge) => edge.target === childRef)) {
        return { ok: true };
      }
      const added = invoke(["relation", "add", epicRef, "--type", "parent", "--target", childRef]);
      return added.ok ? { ok: true } : boardRefusal(added);
    },
    move: (ref, to) => {
      const read = invoke(["issue", "move", ref, to]);
      return read.ok ? { ok: true } : boardRefusal(read);
    },
    comment: (ref, { kind, body }) => {
      const read = invoke(["comment", "add", ref, "--kind", kind, "--body", body]);
      return read.ok ? { ok: true } : boardRefusal(read);
    },
    setMeta: (ref, meta) => {
      // `issue meta` merges. `issue update --meta` replaces the whole object,
      // which would erase the target and review keys (the acceptance baseline is
      // a column since 0032, immune to --meta).
      const read = invoke([
        "issue", "meta", ref,
        ...Object.entries(meta).flatMap(([key, value]) => ["--meta", `${key}=${value}`]),
      ]);
      return read.ok ? { ok: true } : boardRefusal(read);
    },
    appendAcceptance: (ref, items) => {
      // Append-only and idempotent at the board: a normalised duplicate is
      // ignored, and the baseline is unlocked once the rework move has landed.
      const read = invoke([
        "issue", "update", ref,
        ...items.flatMap((item) => ["--acceptance", String(item)]),
      ]);
      return read.ok ? { ok: true } : boardRefusal(read);
    },
    // Acceptance lands the work: the lane branch is merged into the project's
    // current branch *before* the card reaches `done`. A failed merge keeps the
    // card in `in_review` (the verdict is already recorded) and leaves the
    // worktree and branch for a human; the next tick retries.
    land: (action) => {
      if (opts.dryRun) return { ok: true };
      const stateDir = dirname(String(opts.state));
      const record = findWorkspace(stateDir, {
        identifier: action.original_ref,
        round: action.round,
      });
      // No record: a shared-mode card, or one delivered before worktrees. There
      // is nothing to merge.
      if (record === null) return { ok: true };
      // The project's own rules are read live, not frozen at admission: a
      // declared `merge_ref` names the branch acceptance must land on.
      const target = record.project ? resolveWakeTarget({ project: record.project }) : null;
      const entry = target !== null && target.ok === true ? (target.entry ?? null) : null;
      const merged = mergeWorkspace({ workspace: record, entry });
      if (merged.ok === true) return { ok: true };
      log(
        `workflow: landing ${action.original_ref} blocked (${merged.code}: ${merged.message}) — ` +
          "the card stays in in_review",
      );
      return {
        ok: false,
        error: `${merged.code}: ${merged.message}`,
        code: merged.code,
        conflicts: merged.conflicts ?? [],
      };
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
      `${result.blocked ?? 0} blocked, ` +
      `${result.alerts.length} alert(s)${opts.dryRun ? " (dry-run)" : ""}`,
  );
  return result;
}
