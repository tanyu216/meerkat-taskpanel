#!/usr/bin/env node
/**
 * The host-external supervisor — the loop Claude Code and Codex do not have.
 *
 * Claude Code and Codex only run when something opens a session; they have no
 * timers. So the "cheap 1-minute scan → atomic claim → wake a worker → 5-minute
 * patrol" loop they need cannot live inside them. It lives here, outside the
 * host, and the host is just the worker that gets woken.
 *
 * One **tick**:
 *
 *   1. **scan** — for each agent, run `taskctl issue candidates` (a local CLI
 *      read: $0, no LLM). An empty scan plans no work, so nothing is spawned.
 *   2. **claim** — for every planned wake, move the card to `in_progress` first.
 *      The board's CAS is the *only* dispatch: if the claim is refused, no
 *      worker is started. Waking is therefore idempotent and bounded.
 *   3. **wake** — start the host worker with a fresh, bounded handoff, then
 *      record its pid in the state file. The wake goes through the host's own
 *      glue (`<host-dir>/bin/wake-<host>.sh`) when one is installed, so the
 *      worker runs in the card's **project target directory**, resolved locally
 *      by the glue from `projects.json` (R1). This process never resolves a
 *      directory — it hands the project identity along and lets the host decide.
 *   4. **patrol** — a slower pass. A heartbeat older than 30 minutes is
 *      escalated and a heartbeat that cannot be read is *reported*, never
 *      silently dropped (that half is unchanged and its envelope is a published
 *      consumer contract). Beside it, the pass covers `PROTOCOL §⑮`: a card
 *      parked on the leader, an unanswered confirmation gate, a defect whose fix
 *      card was never created, a delivery nobody accepted, a stale heartbeat and
 *      a stalled leader — each emitted as the **shared alert tuple** of
 *      `src/shared/sla-patrol.mjs`, the same schema, thresholds, de-duplication
 *      key and working-hours basis as the openclaw-side inspector. The stale
 *      heartbeat goes out **twice on purpose** (the legacy envelope for its own
 *      consumer, the §4 tuple for the shared ledger — §10.4 leaves no other way
 *      for the two mechanisms to de-duplicate the row between them). No LLM turn
 *      by default, and **no alert ever moves a card**.
 *   5. **workflow** — beside the notify-only SLA pass, the one channel that
 *      writes: `issue reconcile`, the review outcomes (apply a reviewer's
 *      `VERDICT:` report to the card it audits), and review dispatch for every
 *      flow-A delivery. It runs inside the same patrol tick, writes as
 *      `--actor-kind system`, and closes the review card last so a crash between
 *      the two halves is recoverable. Off with `--workflow=no`; dispatch needs
 *      `--reviewer`; `--auto-accept-reviews=no` leaves the review card for a
 *      human.
 *
 * The pass also holds one end of the **mutual liveness watchdog** (§8.4): it
 * writes its own last-successful-run marker every pass, and — when `--sla-peer`
 * names the peer's marker — raises `inspector_liveness` if that marker has gone
 * quiet, because a stopped inspector looks exactly like a healthy board. With no
 * peer marker configured the peer's half is an *explicit dependency* rather than
 * a per-period false alarm; see the flag's note in `--help`.
 *
 * The decision half is pure and lives in `src/shared/scheduling.mjs` +
 * `src/shared/sla-patrol.mjs`; this file is the I/O half. That split is what
 * lets `test/scheduling/supervisor.test.mjs` prove "an empty scan spawns
 * nothing" and `test/scheduling/sla-patrol.test.mjs` prove "an idle board alerts
 * nothing" with injected spies instead of a board.
 *
 * It also runs from a **host-installed copy**: `install.sh` copies this file and the
 * `src/shared/` modules it imports into `<host-dir>/meerkat-taskpanel/`, and the
 * scheduling units name that copy, so a loaded unit survives the checkout being moved.
 * The copy has no board beside it, so it takes the checkout's location from the host
 * config — see `defaultRepo`. The relative imports above are why the copy keeps this
 * file's `scripts/` + `src/shared/` shape instead of being flattened.
 *
 * Usage:
 *   node scripts/supervisor.mjs --host claude --agent alice [--once]
 *   node scripts/supervisor.mjs --agent alice,bob --poll-interval 60 --patrol-interval 300
 *
 * Run with: node scripts/supervisor.mjs --help
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PATROL_SECONDS,
  DEFAULT_POLL_SECONDS,
  buildHandoff,
  buildReviewHandoff,
  candidateArgs,
  parseEnvFile,
  planPatrol,
  planTick,
  planWakeInvocation,
  pruneRegistry,
  resolveClaimUnassigned,
  resolveWorkflowConfig,
  wakeCommand,
} from "../src/shared/scheduling.mjs";
import {
  LOOP_ACCEPTOR,
  isReviewCard,
  parseReviewVerdict,
  planWorkflowTick,
  reviewOf,
  reviewRoundOf,
} from "../src/shared/workflow.mjs";
import {
  BOARD_CARD_ID,
  DEFAULT_BOARD_LIMIT,
  DEFAULT_TRAIL_LIMIT,
  LEADER_LOOKBACK_DAYS,
  MECHANISM,
  PEER_LIVENESS_K,
  PEER_MECHANISM,
  PEER_PERIOD_MIN,
  emptySlaLedger,
  partitionSlaAlerts,
  planSlaPatrol,
  pruneSlaLedger,
  recordSlaAlerts,
  stillQualifies,
  trailReadCandidates,
} from "../src/shared/sla-patrol.mjs";
import { isEntryPoint } from "../src/shared/entry-guard.mjs";

// Re-exported so a caller can import the whole supervisor surface from one place.
export {
  buildHandoff,
  buildReviewHandoff,
  candidateArgs,
  planPatrol,
  planSlaPatrol,
  planTick,
  planWakeInvocation,
  pruneRegistry,
  resolveClaimUnassigned,
  resolveWorkflowConfig,
  wakeCommand,
};

/** Host → dot-directory under the target home. */
export const HOST_DIRS = Object.freeze({ claude: ".claude", codex: ".codex", pi: ".agents" });

const USAGE = `Usage: node scripts/supervisor.mjs [options]

A host-external supervisor: scan, claim, wake a worker, patrol.

Options:
  --agent <name>          Agent(s) to work for. Repeatable / comma-separated.
                          Default: $TASKCTL_AGENT, then $USER.
  --host claude|codex|pi  Which worker to wake (default: claude).
  --repo <path>           Repository root (default: this checkout; a host-installed
                          copy takes it from --config instead — see MEERKAT_TASKPANEL_REPO).
  --poll-interval <sec>   Poll cadence in loop mode (default: ${DEFAULT_POLL_SECONDS}).
  --patrol-interval <sec> Patrol cadence in loop mode (default: ${DEFAULT_PATROL_SECONDS}).
  --max-concurrency <n>   Max concurrently running workers (default: ${DEFAULT_MAX_CONCURRENCY}).
  --claim-unassigned=yes|no   Also claim unassigned cards (the public pool). Default: yes.
  --assignee-only         Alias for --claim-unassigned=no.
  --workflow=yes|no       Run the workflow sub-pass (reconcile, review dispatch, verdicts).
                          Default: yes.
  --reviewer <agent>      The independent agent that reviews delivered cards. Unset
                          means review dispatch is off and deliveries wait for a human.
  --auto-accept-reviews=yes|no
                          Let the loop close a review card after applying its verdict.
                          Default: yes; 'no' leaves the review card for a human.
  --workflow-max-actions <n>
                          Max workflow writes per pass (default: 20).
  --once                  Run a single tick and exit (for tests / cron): the poll
                          pass, or the patrol pass with --patrol-only.
  --patrol-only           With --once, run only the patrol pass.
  --patrol-llm=yes|no     Allow patrol to start an LLM turn (default: no).
  --notify <cmd>          Run <cmd> with each patrol alert as JSON on stdin. Both
                          the legacy heartbeat alert and the SLA tuple go here.
  --dry-run               Print intended actions; claim nothing, spawn nothing.
  --log <path>            Append log lines here (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.log).
  --state <path>          Running-registry file (default: <home>/<host-dir>/meerkat-taskpanel/supervisor.state.json).
  --sla-ledger <path>     De-duplication ledger for SLA alerts (default: a
                          sibling of --state). Notification is never suppressed
                          by an unreadable or absent ledger.
  --sla-leader <id>       Who the contract calls "the leader" when a trail entry
                          is attributed (§6.3-D): the author id the leader writes
                          under. Set it to the same identity the peer mechanism
                          uses (${PEER_MECHANISM}) so both share one attribution
                          set. Unset ⇒ the board's own decision authority — an
                          author that is not a worker agent (author_kind=human).
  --sla-last-ok <path>    Where this mechanism publishes its own last-successful-
                          run marker (§8.4; default: a sibling of --state). Every
                          completed pass rewrites it — it is this mechanism's
                          half of the mutual liveness watchdog.
  --sla-peer <path>       The peer inspector's last-ok marker. When given, a
                          marker older than ${PEER_LIVENESS_K} × ${PEER_PERIOD_MIN}min raises
                          inspector_liveness; when unset, the peer's half is
                          recorded as an explicit dependency and nothing alarms.
  --board-limit <n>       Max cards read per patrol pass (default: ${DEFAULT_BOARD_LIMIT}).
  --trail-limit <n>       Max cards whose comment trail is read per pass
                          (default: ${DEFAULT_TRAIL_LIMIT}); a cap is always logged.
  --config <path>         Host config file to read the claim default — and, for a
                          host-installed copy, MEERKAT_TASKPANEL_REPO — from
                          (default: <home>/<host-dir>/meerkat-taskpanel.env).
  --home <path>           Home the defaults are resolved against (default: $HOME).
  --cli <path>            taskctl entry to read/claim through (default: <repo>/src/cli/index.mjs).
  --glue <path>           Wake glue the worker is started through (default:
                          <home>/<host-dir>/bin/wake-<host>.sh). The glue resolves
                          the card's project target directory and runs the worker
                          there; without it the worker runs in --repo.
  --wake-command <cmd>    Your own wake command instead of the built-in host forms
                          (the documented escape hatch for a host this repo does
                          not wire). It is called as: <cmd> <handoff> [<sid>],
                          and is handed TP_PROJECT / TP_PROJECTS_JSON / TP_NODE.
  --projects-json <path>  Host-local project map handed to the glue (default:
                          <home>/<host-dir>/skills/meerkat-taskpanel/projects.json).
  -h, --help              Show this help
`;

// ---------------------------------------------------------------------------
// The pure decision is imported; the two runners below apply it with injected
// side effects, so tests can supply spies.
// ---------------------------------------------------------------------------

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
    // would otherwise re-notify on every 5-minute pass forever. They are logged;
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
      log(
        `workflow: ${action.type} failed for ${action.originalRef ?? action.reviewRef} ` +
          `(${err.message}) — leaving the review card for the next pass`,
      );
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

// ---------------------------------------------------------------------------
// Registry (crash survival) + process liveness
// ---------------------------------------------------------------------------

/** @returns {boolean} whether a pid is still alive. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by another user — still alive.
    return err?.code === "EPERM";
  }
}

/** Read the running registry; a missing/corrupt file is an empty registry, never a crash. */
export function loadRegistry(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.running && typeof parsed.running === "object") return parsed;
  } catch {
    // Missing or unreadable — start clean.
  }
  return { version: 1, running: {} };
}

/** Persist the running registry. */
export function saveRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * The checkout whose `taskctl` this supervisor drives, for a run that was not told.
 *
 * There are two places a supervisor can run from, and they need different answers:
 *
 *   * **from the checkout** (`node scripts/supervisor.mjs`, the documented dev run
 *     and every test) — the board sits beside the executor, so the relative answer is
 *     the right one and nothing else is consulted. This branch is why a dev run never
 *     depends on the machine's host config.
 *   * **from the host** — `install.sh` copies the loop body under
 *     `<host-dir>/meerkat-taskpanel/` so a loaded scheduling unit survives the
 *     checkout moving. That copy has no board of its own, so it falls back to the
 *     location the installer recorded in the host config (`MEERKAT_TASKPANEL_REPO`).
 *
 * An unreadable or key-less config falls back to the executor's own location, which
 * is what a copy written by an older installer has — the tick still runs, and
 * re-running `install.sh` records the path.
 *
 * @param {string | null} configPath the host config file to consult
 * @param {string} [beside] the executor's own directory — injectable so the
 *   host-installed branch is testable without a second checkout on disk
 * @returns {string} an absolute directory
 */
export function defaultRepo(configPath, beside = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  if (existsSync(join(beside, "src", "cli", "index.mjs"))) return beside;
  const recorded = configPath === null ? null : readConfigFile(configPath).MEERKAT_TASKPANEL_REPO;
  return recorded ? resolve(recorded) : beside;
}

/** @param {string[]} argv */
export function parseArgs(argv, env = process.env) {
  const opts = {
    agents: [],
    host: "claude",
    repo: null,   // resolved below: --repo, else defaultRepo()
    pollInterval: DEFAULT_POLL_SECONDS,
    patrolInterval: DEFAULT_PATROL_SECONDS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    claimUnassigned: undefined,
    workflow: undefined,
    reviewer: undefined,
    autoAcceptReviews: undefined,
    workflowMaxActions: undefined,
    once: false,
    patrolOnly: false,
    patrolLlm: false,
    notify: null,
    dryRun: false,
    log: null,
    state: null,
    slaLedger: null,
    slaLeader: null,
    slaLastOk: null,
    slaPeer: null,
    slaLookbackDays: null,
    boardLimit: DEFAULT_BOARD_LIMIT,
    trailLimit: DEFAULT_TRAIL_LIMIT,
    config: null,
    home: env.HOME || env.USERPROFILE || homedir(),
    cli: null,
    glue: null,
    projectsJson: null,
    wakeCommand: null,
    help: false,
  };

  const number = (flag, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a number, got '${raw}'`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = (flag) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (arg === "--agent") opts.agents.push(...take("--agent").split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg.startsWith("--agent=")) opts.agents.push(...arg.slice(8).split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--host") opts.host = take("--host");
    else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
    else if (arg === "--repo") opts.repo = resolve(take("--repo"));
    else if (arg.startsWith("--repo=")) opts.repo = resolve(arg.slice(7));
    else if (arg === "--poll-interval") opts.pollInterval = number("--poll-interval", take("--poll-interval"));
    else if (arg.startsWith("--poll-interval=")) opts.pollInterval = number("--poll-interval", arg.slice(16));
    else if (arg === "--patrol-interval") opts.patrolInterval = number("--patrol-interval", take("--patrol-interval"));
    else if (arg.startsWith("--patrol-interval=")) opts.patrolInterval = number("--patrol-interval", arg.slice(18));
    else if (arg === "--max-concurrency") opts.maxConcurrency = number("--max-concurrency", take("--max-concurrency"));
    else if (arg.startsWith("--max-concurrency=")) opts.maxConcurrency = number("--max-concurrency", arg.slice(18));
    else if (arg === "--claim-unassigned") opts.claimUnassigned = take("--claim-unassigned");
    else if (arg.startsWith("--claim-unassigned=")) opts.claimUnassigned = arg.slice(19);
    else if (arg === "--assignee-only") opts.claimUnassigned = "no";
    else if (arg === "--workflow") opts.workflow = take("--workflow");
    else if (arg.startsWith("--workflow=")) opts.workflow = arg.slice(11);
    else if (arg === "--reviewer") opts.reviewer = take("--reviewer");
    else if (arg.startsWith("--reviewer=")) opts.reviewer = arg.slice(11);
    else if (arg === "--auto-accept-reviews") opts.autoAcceptReviews = take("--auto-accept-reviews");
    else if (arg.startsWith("--auto-accept-reviews=")) opts.autoAcceptReviews = arg.slice(22);
    else if (arg === "--workflow-max-actions") opts.workflowMaxActions = take("--workflow-max-actions");
    else if (arg.startsWith("--workflow-max-actions=")) opts.workflowMaxActions = arg.slice(23);
    else if (arg === "--once") opts.once = true;
    else if (arg === "--patrol-only") opts.patrolOnly = true;
    else if (arg === "--patrol-llm") opts.patrolLlm = true;
    else if (arg.startsWith("--patrol-llm=")) opts.patrolLlm = /^(yes|true|1|y|on)$/i.test(arg.slice(13));
    else if (arg === "--notify") opts.notify = take("--notify");
    else if (arg.startsWith("--notify=")) opts.notify = arg.slice(9);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--log") opts.log = take("--log");
    else if (arg.startsWith("--log=")) opts.log = arg.slice(6);
    else if (arg === "--state") opts.state = take("--state");
    else if (arg.startsWith("--state=")) opts.state = arg.slice(8);
    else if (arg === "--sla-ledger") opts.slaLedger = take("--sla-ledger");
    else if (arg.startsWith("--sla-ledger=")) opts.slaLedger = arg.slice(13);
    else if (arg === "--sla-leader") opts.slaLeader = take("--sla-leader");
    else if (arg.startsWith("--sla-leader=")) opts.slaLeader = arg.slice(13);
    else if (arg === "--sla-last-ok") opts.slaLastOk = take("--sla-last-ok");
    else if (arg.startsWith("--sla-last-ok=")) opts.slaLastOk = arg.slice(14);
    else if (arg === "--sla-peer") opts.slaPeer = take("--sla-peer");
    else if (arg.startsWith("--sla-peer=")) opts.slaPeer = arg.slice(11);
    else if (arg === "--board-limit") opts.boardLimit = number("--board-limit", take("--board-limit"));
    else if (arg.startsWith("--board-limit=")) opts.boardLimit = number("--board-limit", arg.slice(14));
    else if (arg === "--trail-limit") opts.trailLimit = number("--trail-limit", take("--trail-limit"));
    else if (arg.startsWith("--trail-limit=")) opts.trailLimit = number("--trail-limit", arg.slice(14));
    else if (arg === "--config") opts.config = take("--config");
    else if (arg.startsWith("--config=")) opts.config = arg.slice(9);
    else if (arg === "--home") opts.home = resolve(take("--home"));
    else if (arg.startsWith("--home=")) opts.home = resolve(arg.slice(7));
    else if (arg === "--cli") opts.cli = take("--cli");
    else if (arg.startsWith("--cli=")) opts.cli = arg.slice(6);
    else if (arg === "--glue") opts.glue = take("--glue");
    else if (arg.startsWith("--glue=")) opts.glue = arg.slice(7);
    else if (arg === "--projects-json") opts.projectsJson = take("--projects-json");
    else if (arg.startsWith("--projects-json=")) opts.projectsJson = arg.slice(16);
    else if (arg === "--wake-command") opts.wakeCommand = take("--wake-command");
    else if (arg.startsWith("--wake-command=")) opts.wakeCommand = arg.slice(15);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  if (opts.agents.length === 0) {
    const fallback = env.TASKCTL_AGENT || env.USER || env.LOGNAME || "agent";
    opts.agents = [fallback];
  }
  if (!(opts.host in HOST_DIRS)) throw new Error(`unknown host '${opts.host}' (expected claude|codex|pi)`);

  const hostDir = HOST_DIRS[opts.host];
  opts.log ??= join(opts.home, hostDir, "meerkat-taskpanel", "supervisor.log");
  opts.state ??= join(opts.home, hostDir, "meerkat-taskpanel", "supervisor.state.json");
  // The ledger sits beside the state file by default, so a host with a custom
  // --state keeps one directory for everything the supervisor remembers.
  opts.slaLedger ??= join(dirname(opts.state), "sla-ledger.json");
  // The liveness marker goes beside them, for the same reason — and it is the
  // path a peer deployment points its own `--sla-peer` at (`<mech>-last-ok.json`
  // is this mechanism's name for it, mirroring the peer's `sla-scan` marker).
  opts.slaLastOk ??= join(dirname(opts.state), "loop-patrol-last-ok.json");
  // The leader identity is deployable, not hard-coded (§3 of the contract).
  opts.slaLeader ??= env.MEERKAT_TASKPANEL_SLA_LEADER ?? null;
  opts.slaPeer ??= env.MEERKAT_TASKPANEL_SLA_PEER ?? null;
  // The leader lookback is a mechanism parameter with a default, not a knob a
  // deployment normally touches — it is read here so `planSlaPatrol`'s caller
  // states it rather than leaving it implicit.
  opts.slaLookbackDays ??= LEADER_LOOKBACK_DAYS;
  opts.config ??= join(opts.home, hostDir, "meerkat-taskpanel.env");
  opts.repo ??= defaultRepo(opts.config);
  opts.cli ??= join(opts.repo, "src", "cli", "index.mjs");
  // The two host-local artefacts a wake needs: the glue that owns the working
  // directory, and the project map it resolves that directory from. Both live
  // under the host's dot-directory, exactly where `install.sh` put them.
  opts.glue ??= join(opts.home, hostDir, "bin", `wake-${opts.host}.sh`);
  opts.projectsJson ??= join(opts.home, hostDir, "skills", "meerkat-taskpanel", "projects.json");
  return opts;
}

// ---------------------------------------------------------------------------
// Real (default) dependencies
// ---------------------------------------------------------------------------

/**
 * Run the taskctl CLI and parse its `--json` envelope. Returns `{ok, data|error}`.
 *
 * `actorKind` is not cosmetic: without it every write this supervisor performs
 * defaults to `human` on the board, which is how a loop claim used to read as a
 * person's act. Claims pass the host (`claude`/`codex`/`pi`); the workflow
 * pass's writes pass `system`, so an automated acceptance is attributable and
 * the SLA attribution rules can exclude it.
 */
function runCli(opts, agent, args, { input = null, actorKind = null } = {}) {
  const globals = ["--json", "--agent", agent, ...(actorKind === null ? [] : ["--actor-kind", actorKind])];
  const run = spawnSync(process.execPath, [opts.cli, ...globals, ...args], {
    encoding: "utf8",
    input,
    env: process.env,
  });
  if (run.error) return { ok: false, error: run.error.message };
  try {
    const parsed = JSON.parse(run.stdout ?? "");
    return parsed?.ok === true ? { ok: true, data: parsed.data ?? {} } : { ok: false, error: parsed?.error?.message ?? `exit ${run.status}` };
  } catch {
    return { ok: false, error: (run.stderr ?? "").trim() || `exit ${run.status}` };
  }
}

function readConfigFile(path) {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** An append fd for the log, or `null` when it cannot be opened. Never throws. */
function openAppendFd(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, "a");
  } catch {
    return null;
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

function notifyReal(opts, log) {
  return (alert) => {
    if (!opts.notify) return;
    const run = spawnSync(opts.notify, { shell: true, input: JSON.stringify(alert), encoding: "utf8" });
    if (run.error) log(`notify failed: ${run.error.message}`);
  };
}

/**
 * The SLA de-duplication ledger.
 *
 * A file beside the supervisor's own state, not a card: the loop holds no write
 * capability onto card state (§9.1), and the contract's card-trail backend is a
 * *shared* substrate for two mechanisms that may run on different hosts. This
 * mechanism therefore de-duplicates within itself and records that choice as a
 * deliberate deviation — the cross-mechanism residual is at most one duplicate
 * notification per key until the peer's marker is wired (§8.3 rule 5).
 *
 * Every failure is soft: an unreadable ledger reads as empty, so the pass
 * notifies rather than suppressing. A duplicate is admissible; a lost alert is
 * not.
 */
export function loadSlaLedger(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.seen && typeof parsed.seen === "object") {
      return { version: 1, seen: parsed.seen };
    }
  } catch {
    // Missing or unreadable — start clean and notify (never suppress on a failed read).
  }
  return emptySlaLedger();
}

/** Persist the ledger. A failure here can only cost a duplicate, never an alert. */
export function saveSlaLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * The mutual liveness watchdog's two files (§8.4).
 *
 * Each mechanism publishes a **last-successful-run marker** and watches the
 * peer's. The marker is a plain `{mechanism, last_ok, ...}` object written
 * atomically (temp + rename) so a reader never sees half a file. Reading the
 * peer's is deliberately failure-tolerant: an unreadable marker reads as
 * `null`, and what `null` *means* is the decision half's business — this half
 * does not get to turn a parse error into a silence.
 */
export function saveLastOk(path, { mechanism, at, host = null, periodSeconds = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ mechanism, last_ok: at, mechanism_host: host, cadence_period_min: periodSeconds === null ? null : periodSeconds / 60 }, null, 2)}\n`,
  );
  renameSync(tmp, path);
}

/** The peer's last-successful-run marker's `last_ok`, or `null` when unreadable. */
export function readPeerLastOk(path) {
  if (path === null || path === undefined) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const value = parsed?.last_ok ?? parsed?.lastOk ?? null;
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    // Absent, unreadable or malformed all mean the same thing here: the peer has
    // not published a usable marker. Whether that is an alarm or a dependency is
    // decided above this line.
    return null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`supervisor: ${err.message}\n`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`supervisor: ${line}\n`);
    if (!opts.dryRun) {
      try {
        mkdirSync(dirname(opts.log), { recursive: true });
        appendFileSync(opts.log, `${stamped}\n`);
      } catch {
        // Logging must never take the supervisor down.
      }
    }
  };

  const configFile = readConfigFile(opts.config);
  const claimUnassigned = resolveClaimUnassigned({
    flag: opts.claimUnassigned,
    // legacy-name-compat: accept the pre-rename env var too.
    env: env.MEERKAT_TASKPANEL_CLAIM_UNASSIGNED ?? env.TASKPANEL_CLAIM_UNASSIGNED,
    file: configFile,
  });
  const workflow = resolveWorkflowConfig({
    flags: {
      workflow: opts.workflow,
      reviewer: opts.reviewer,
      autoAcceptReviews: opts.autoAcceptReviews,
      workflowMaxActions: opts.workflowMaxActions,
    },
    env,
    file: configFile,
  });
  // A reviewer that is also listed as a worker keeps the normal worker lane (and
  // claims from the public pool); a dedicated reviewer is scanned for review
  // cards only.
  const reviewerIsWorker = workflow.reviewer !== null && opts.agents.includes(workflow.reviewer);
  const config = {
    maxConcurrency: opts.maxConcurrency,
    claimUnassigned,
    patrolLlm: opts.patrolLlm,
    host: opts.host,
    // The escape hatch the docs promise (and the Pi glue points at): an operator
    // who needs a wake form this repo does not ship supplies their own command.
    wakeCommand: opts.wakeCommand,
    workflow: workflow.workflow,
    reviewer: workflow.reviewer,
    reviewerIsWorker,
    autoAcceptReviews: workflow.autoAcceptReviews,
    maxActions: workflow.maxActions,
  };

  const registry = opts.dryRun
    ? { version: 1, running: {} }
    : pruneRegistry(loadRegistry(opts.state), isProcessAlive);

  // The poll scans the workers, plus a dedicated reviewer when one is configured
  // — a review card is an ordinary claimable card, so the reviewer's wake rides
  // the same 1-minute scan and the same cost gate as any worker.
  const scanAgents =
    workflow.workflow && workflow.reviewer !== null && !reviewerIsWorker
      ? [...opts.agents, workflow.reviewer]
      : [...opts.agents];

  const deps = {
    agents: scanAgents,
    registry,
    config,
    readCandidates: (agent, { claimUnassigned: pool }) => {
      const dedicatedReviewer = config.reviewer !== null && agent === config.reviewer && !reviewerIsWorker;
      // A dedicated reviewer never takes the public pool, and only sees review
      // cards: handing it an ordinary card would be a self-review waiting to
      // happen (the card's own assignee is not necessarily the reviewer, but the
      // reviewer's lane is read-and-verdict, not work).
      const read = runCli(opts, agent, candidateArgs(agent, dedicatedReviewer ? false : pool));
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
      // The claim is the host's act, not a person's: the board defaults an
      // unlabelled write to `human`, which made every loop claim look manual.
      const moved = runCli(opts, agent, ["issue", "move", identifier, "in_progress"], { actorKind: opts.host });
      return moved.ok ? { ok: true } : { ok: false, error: moved.error };
    },
    spawnWorker: opts.dryRun ? async () => ({ ok: true, pid: null }) : spawnWorkerReal(opts, config, log),
    now: () => new Date().toISOString(),
    log,
  };

  // Say it up front, every tick: whether a wake can resolve a target directory.
  // A missing glue is not fatal, but it must never be a surprise discovered only
  // after a worker has already run somewhere unintended.
  const gluePresent = opts.glue !== null && existsSync(opts.glue);
  const wakeForm = opts.wakeCommand === null ? `glue=${gluePresent ? opts.glue : "none"}` : `wake_command=${opts.wakeCommand}`;
  log(
    `tick: host=${opts.host} agents=${opts.agents.join(",")} claim_unassigned=${claimUnassigned ? "yes" : "no"} ` +
      `${wakeForm} projects_json=${opts.projectsJson}${opts.dryRun ? " (dry-run)" : ""}`,
  );
  if (!gluePresent && opts.wakeCommand === null && !opts.dryRun) {
    log(`warning: no wake glue at ${opts.glue} — workers will run in ${opts.repo} without a project target directory`);
  }
  // The two SLA settings a deployment has to get right are stated up front, for
  // the same reason as the glue line: a mis-set leader identity silently changes
  // which events count as "the leader acted", and a missing peer marker silently
  // disables half a contract. Neither may be discovered from a quiet board.
  log(
    `sla: leader=${opts.slaLeader === null ? "board-authority(author_kind=human)" : opts.slaLeader} ` +
      `last_ok=${opts.slaLastOk} peer=${opts.slaPeer === null ? "not configured (dependency registered)" : opts.slaPeer}`,
  );
  // The workflow channel is the one that writes cards, so its two policy
  // settings are stated the same way: a deployment must never have to infer
  // "who reviews" or "who closes the review card" from a quiet board.
  log(
    `workflow: ${config.workflow ? "on" : "off"} ` +
      `reviewer=${config.reviewer === null ? "not configured" : `${config.reviewer}${reviewerIsWorker ? " (also a worker)" : ""}`} ` +
      `auto_accept_reviews=${config.autoAcceptReviews ? "yes" : "no"} max_actions=${config.maxActions}`,
  );

  let failed = 0;

  if (!opts.patrolOnly) {
    const poll = await runPollTick(deps);
    failed += poll.failed;
    log(`poll: ${poll.actions.length} action(s), ${poll.spawned} woke, ${poll.conflicts} refused, ${poll.failed} failed`);
  }

  if (opts.once) {
    // Each scheduling unit drives exactly one layer: the poll line above, or the
    // patrol pass here. Keeping them separate is the whole point of the two-layer
    // design — a 1-minute poll must not sweep every in_progress card every minute.
    if (opts.patrolOnly) {
      // A dry run reads the board too: every read below is free and read-only,
      // and the workflow pass's whole output in dry-run is what it *would* do.
      const read = readBoard(opts, log);
      const tasks = read.ok ? read.data.tasks ?? [] : [];
      const patrol = await runPatrolTick({
        tasks,
        config,
        spawnPatrol: async (alert) => {
          if (opts.dryRun) return { ok: false };
          const card = { identifier: alert.identifier };
          return spawnWorkerReal(opts, config, log)({ identifier: alert.identifier, agent: alert.agent ?? opts.agents[0] }, card);
        },
        notify: opts.dryRun ? () => {} : notifyReal(opts, log),
        now: () => new Date().toISOString(),
        log,
      });
      log(`patrol: ${patrol.alerts.length} alert(s), ${patrol.spawns} LLM turn(s)`);
      // Same guard as the heartbeat pass: `--dry-run` reads nothing, so it
      // reports nothing. The SLA pass is a notification pass, not a planner.
      if (read.ok) {
        await runSlaPass(opts, log, tasks, opts.patrolInterval, { boardTruncated: read.truncated === true });
        // The workflow pass is isolated: a failure here must not turn a patrol
        // tick into an error, and the poll's exit code still decides the run.
        try {
          await runWorkflowPass(opts, config, log, {
            tasks,
            boardTruncated: read.truncated === true,
          });
        } catch (err) {
          log(`workflow error: ${err.message}`);
        }
      }
    }
    if (!opts.dryRun) saveRegistry(opts.state, registry);
    return failed > 0 ? 1 : 0;
  }

  // Loop mode: poll and patrol on their own cadences.
  const pollTimer = setInterval(async () => {
    try {
      const poll = await runPollTick(deps);
      log(`poll: ${poll.actions.length} action(s), ${poll.spawned} woke, ${poll.conflicts} refused, ${poll.failed} failed`);
      if (!opts.dryRun) saveRegistry(opts.state, registry);
    } catch (err) {
      log(`poll error: ${err.message}`);
    }
  }, Math.max(1, opts.pollInterval) * 1000);

  const patrolTimer = setInterval(async () => {
    try {
      const read = readBoard(opts, log);
      const tasks = read.ok ? read.data.tasks ?? [] : [];
      await runPatrolTick({
        tasks,
        config,
        spawnPatrol: async () => ({ ok: false }),
        notify: notifyReal(opts, log),
        now: () => new Date().toISOString(),
        log,
      });
      if (read.ok) {
        await runSlaPass(opts, log, tasks, opts.patrolInterval, { boardTruncated: read.truncated === true });
        // Overlap is tolerable here: reconcile is idempotent and the state
        // machine refuses an illegal transition, so two passes racing over one
        // card produce at most a refused move, never a duplicate write.
        try {
          await runWorkflowPass(opts, config, log, {
            tasks,
            boardTruncated: read.truncated === true,
          });
        } catch (err) {
          log(`workflow error: ${err.message}`);
        }
      }
    } catch (err) {
      log(`patrol error: ${err.message}`);
    }
  }, Math.max(1, opts.patrolInterval) * 1000);

  // The ref'd timers keep the loop alive; a signal persists the registry first.
  const shutdown = () => {
    clearInterval(pollTimer);
    clearInterval(patrolTimer);
    if (!opts.dryRun) saveRegistry(opts.state, registry);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Loop mode never resolves: the supervisor is a daemon until signalled.
  return await new Promise(() => {});
}

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
function readBoard(opts, log) {
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
function readTrail(opts, log, identifier) {
  const read = runCli(opts, opts.agents[0], ["comment", "list", identifier, "--limit", String(COMMENTS_PER_CARD)]);
  if (!read.ok) {
    log(`patrol: comment read failed for ${identifier}: ${read.error}`);
    return null;
  }
  return read.data.comments ?? [];
}

/** A candidate's live state for the pre-emit re-check; `checked:false` ⇒ unverifiable. */
function readLiveCard(opts, log, identifier) {
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
async function runSlaPass(opts, log, tasks, periodSeconds, { boardTruncated = false } = {}) {
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
function readReviewCards(opts, log) {
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
async function runWorkflowPass(opts, config, log, { tasks = [], boardTruncated = false } = {}) {
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
      const read = invoke([
        "issue", "update", ref,
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

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
