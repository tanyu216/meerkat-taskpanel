#!/usr/bin/env node
/**
 * `taskctl loop doctor` — one read-only daily-inspection report.
 *
 * The loop's other read verbs each answer one question (`status`: is the process
 * up; `console`: what is waiting on a human). A human keeping a team alive has to
 * ask all of them, then read the log and the queue by hand. This verb asks them
 * together and adds the facts the answers do not carry: whether the patrol is
 * still *completing*, which cards are stuck, and which cards keep going round
 * the same loop (rework rounds, review reopens, dispatch retries, failed
 * subagents).
 *
 * **It is not a pass.** It claims nothing, dispatches nothing, starts no process,
 * writes no state and opens no logger — an inspection that changed the thing it
 * inspected would be worth nothing. Every existing judgement is reused, never
 * restated: the verdict is `probeSupervisor`, the board read is `readBoard` (one
 * call, the patrol's own view), the stale-heartbeat line is `planPatrol`, and the
 * review line is the workflow's `review_aging` setting resolved once. The
 * `looping` section adds judgements no other pass owns, judged over the same
 * snapshot and the queue/ledger rows already read; the review-reopen bound is
 * mirrored from the workflow's own constant (the orchestrator may import only
 * `foundation`), never re-invented.
 *
 * Exit codes: 0 whenever a report was produced — a report that says "attention"
 * is a successful inspection. 2 on a usage error, 1 only when no report could be
 * built at all. Automation reads `attention` from `--json`; a non-zero code here
 * would make an unhealthy loop indistinguishable from a broken doctor.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ROUTE_UNASSIGNED_MS } from "../foundation/constants.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { QUEUE_FILES, SESSION_DEFAULTS } from "../foundation/loop-state.mjs";
import { resolveWakeTarget } from "../foundation/project-dir.mjs";
import { reviewIdentityOf } from "../foundation/review-identity.mjs";
import { PATROL_STALE_MS, planPatrol } from "../foundation/scheduling.mjs";
import { TERMINAL_STATUSES } from "../foundation/sla-patrol.mjs";
import { readBoard } from "./board.mjs";
import {
  DEFERRAL_THRESHOLD,
  readDeferralLedger,
} from "./deferrals.mjs";
import { liveSubagents, readLedger } from "./ledger.mjs";
import { parseArgs } from "./options.mjs";
import { readCards } from "./queue.mjs";
import { isProcessAlive, readPeerMarker } from "./runtime.mjs";
import { readWorkerSessions } from "./worker-session.mjs";
import { probeSupervisor } from "./status.mjs";
import {
  isStaleWorkspaceRecord,
  readWorkspaceRegistry,
  registryPath,
  runGit,
} from "./workspace.mjs";

/** How many log lines the report carries, and how many bytes it will read for them. */
export const LOG_TAIL_LINES = 40;
export const LOG_TAIL_BYTES = 64 * 1024;
/**
 * How much of one line survives. The live log embeds whole assistant messages in
 * `msg="…"`, so an uncapped line turns a 40-line tail into pages of one report.
 */
export const LOG_TAIL_LINE_CHARS = 200;

/**
 * When a card is treated as going round in circles.
 *
 * Round 1 is the first delivery; every rejection, rework or audited reopen bumps
 * `delivery_round`, so 4 means the work came back three times. These are review
 * thresholds: `doctor` reports them, it never acts on them.
 */
export const LOOP_REWORK_ROUND_MIN = 4;
/**
 * The review-reopen bound, mirrored from `DEFAULT_REVIEW_REOPEN_MAX`
 * (`src/core/domain/workflow.mjs`) because the orchestrator may import only
 * `foundation` (`test/orchestrator/imports.test.mjs`). If that bound ever becomes
 * configurable (`resolveWorkflowConfig` does not expose it today), this must read
 * the same config instead of the default.
 */
export const LOOP_REVIEW_REOPEN_MIN = 2;
/** A review card's own round bumps by one per reopen — it leaves `in_review`. */
export const LOOP_REVIEW_ROUND_MIN = LOOP_REVIEW_REOPEN_MIN + 1;
/** Five handoffs for one card inside the queue's 24h retention. */
export const LOOP_DISPATCH_ROWS_MIN = 5;
/** Two handoffs that each exhausted their own attempt budget. */
export const LOOP_DISPATCH_FAILED_MIN = 2;
/** Three failed subagent rows for one card inside the ledger's 7-day retention. */
export const LOOP_SUBAGENT_FAILED_MIN = 3;

/** Ledger statuses that mean the subagent did not finish its work. */
const LEDGER_FAILURE_STATUSES = new Set(["failed", "interrupted", "stale"]);

/** The peer-marker rule: a marker older than this many cadences means "stalled". */
const PEER_LIVENESS_K = 3;

export const USAGE = `Usage: taskctl loop doctor [--state <path>] [--log <path>] [--config <path>]

One read-only inspection: the supervisor verdict, the resolved scan set, the
patrol's last-successful-run marker, the tail of the loop log, the dispatch queue
and the subagent ledger, the cards that look stuck, and the cards that keep
looping (rework rounds, review reopens, dispatch retries, failed subagents).

It writes nothing, claims nothing and starts no process. The exit code is 0
whenever a report was produced; read \`attention\` from --json.`;

// ---------------------------------------------------------------------------
// The log tail — a bounded read of a file that rotates under us
// ---------------------------------------------------------------------------

/**
 * The last `maxBytes` of a file, or `null` when it is not there.
 *
 * A start offset inside the file almost always lands mid-line; that partial line
 * is dropped so the report never shows a fragment as if it were a log entry.
 */
function readTailBytes(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { error: error.message };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return { text: "", truncated: false };
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return { text, truncated: false };
    const firstBreak = text.indexOf("\n");
    return {
      text: firstBreak === -1 ? "" : text.slice(firstBreak + 1),
      truncated: true,
    };
  } finally {
    closeSync(fd);
  }
}

function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One line, capped. The report keeps the logfmt prefix, which is the readable half. */
function capLine(line) {
  return line.length > LOG_TAIL_LINE_CHARS ? `${line.slice(0, LOG_TAIL_LINE_CHARS)}…` : line;
}

/** A record's free text, folded onto one line and capped for the human page. */
function oneLine(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  return capLine(value.replace(/\s+/g, " ").trim());
}

/**
 * The live log's tail, with the rotated generation used only when the live file
 * is missing or too short — enough to fill `LOG_TAIL_LINES` without reading two
 * files' worth of bytes.
 */
function logTail(path) {
  const base = { path: path ?? null, lines: [], truncated: false, missing: false, error: null };
  if (typeof path !== "string" || path === "") {
    return { ...base, source: "missing", missing: true };
  }

  const live = readTailBytes(path, LOG_TAIL_BYTES);
  if (live !== null && live.error !== undefined) {
    return { ...base, source: "live", error: live.error };
  }
  if (live !== null) {
    const lines = splitLines(live.text);
    let truncated = live.truncated || lines.length > LOG_TAIL_LINES;
    let tail = lines.slice(-LOG_TAIL_LINES);
    let source = "live";
    if (lines.length < LOG_TAIL_LINES) {
      const rotated = readTailBytes(`${path}.1`, LOG_TAIL_BYTES);
      if (rotated !== null && rotated.error === undefined) {
        const older = splitLines(rotated.text);
        truncated = truncated || rotated.truncated || older.length > LOG_TAIL_LINES - lines.length;
        tail = [...older.slice(-(LOG_TAIL_LINES - lines.length)), ...tail];
      }
    }
    return { ...base, source, lines: tail.map(capLine), truncated };
  }

  const rotated = readTailBytes(`${path}.1`, LOG_TAIL_BYTES);
  if (rotated !== null && rotated.error !== undefined) {
    return { ...base, source: "rotated", error: rotated.error };
  }
  if (rotated !== null) {
    const lines = splitLines(rotated.text);
    return {
      ...base,
      source: "rotated",
      lines: lines.slice(-LOG_TAIL_LINES).map(capLine),
      truncated: rotated.truncated || lines.length > LOG_TAIL_LINES,
    };
  }
  return { ...base, source: "missing", missing: true };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Newest first, with an unreadable age last — the order a human triages in. */
/** One `git` read against a checkout: its stdout, or `null` when git cannot say. */
function gitRead(git, dir, args) {
  const read = git("git", ["-C", String(dir), ...args]);
  if (read === null || read.status !== 0) return null;
  return String(read.stdout ?? "");
}

/** `git worktree list --porcelain` → `[{path, branch}]`; a detached head has no branch. */
function parseWorktrees(text) {
  const rows = [];
  let current = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      if (current !== null) rows.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (current !== null && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (current !== null) rows.push(current);
  return rows;
}

/** `git branch --no-merged` → the set of branch names that are not in HEAD. */
function parseUnmerged(text) {
  return new Set(
    String(text ?? "")
      .split("\n")
      .map((line) => line.replace(/^[*+ ]+/, "").trim())
      .filter((line) => line !== ""),
  );
}

function byAgeDesc(left, right) {
  const a = left.age_ms ?? -1;
  const b = right.age_ms ?? -1;
  if (a !== b) return b - a;
  return String(left.ref ?? "").localeCompare(String(right.ref ?? ""));
}

function countStatuses(rows) {
  const counts = {};
  for (const row of rows) {
    const status = String(row?.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The looping judgements — pure, over rows the report already read
// ---------------------------------------------------------------------------

/** A non-negative integer, or a digit-only string, else 0. */
function intOrZero(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

/** A handoff row's attempt counter, tolerating a missing or malformed value. */
function attemptsOf(row) {
  const value = Number(row?.attempts ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The card a queue/ledger row belongs to, or `null` when it names none. */
function refOf(row) {
  const value = typeof row?.card === "string" ? row.card.trim() : "";
  return value === "" ? null : value;
}

/** Does the board snapshot know this card is finished? Unknown stays unfiltered. */
function knownTerminal(ref, boardByRef) {
  const status = boardByRef.get(ref)?.status;
  return typeof status === "string" && TERMINAL_STATUSES.includes(status);
}

/** `age_ms` for a card's current status, or `null` when the timestamp is unreadable. */
function ageSince(since, nowMs) {
  const at = since === null || since === undefined ? Number.NaN : Date.parse(String(since));
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
}

/**
 * The two board-side loop findings: a card whose work keeps coming back, and a
 * review card the loop keeps re-dispatching.
 *
 * `byId` resolves a review card's structural `review_of_id` to its original's
 * identifier; the list projection does not pass one, so `review_of` alone falls
 * back to the `meta.review_of` mirror and a column-only review card reads `null`.
 */
function boardLoopFindings(tasks, byId, nowMs) {
  const rework = [];
  const reviews = [];
  for (const task of tasks) {
    const ref = typeof task?.identifier === "string" ? task.identifier : "";
    if (ref === "") continue;
    if (TERMINAL_STATUSES.includes(String(task?.status ?? ""))) continue;
    const identity = reviewIdentityOf(task, { byId });
    const since = task.status_changed_at ?? task.created_at ?? null;
    if (identity.isReview) {
      const retries = intOrZero(task?.meta?.review_retry);
      if (retries < LOOP_REVIEW_REOPEN_MIN && identity.ownRound < LOOP_REVIEW_ROUND_MIN) continue;
      reviews.push({
        ref,
        title: task.title ?? null,
        original: identity.originalRef ?? task.review_of ?? null,
        retries,
        own_round: identity.ownRound,
        audited_round: identity.auditedRound,
        status: task.status ?? null,
        since,
        age_ms: ageSince(since, nowMs),
      });
      continue;
    }
    if (identity.ownRound < LOOP_REWORK_ROUND_MIN) continue;
    rework.push({
      ref,
      title: task.title ?? null,
      kind: task.kind ?? null,
      round: identity.ownRound,
      status: task.status ?? null,
      since,
      age_ms: ageSince(since, nowMs),
    });
  }
  rework.sort((left, right) => right.round - left.round || left.ref.localeCompare(right.ref));
  reviews.sort(
    (left, right) =>
      right.retries - left.retries ||
      right.own_round - left.own_round ||
      left.ref.localeCompare(right.ref),
  );
  return { rework_rounds: rework, review_reopens: reviews };
}

/**
 * Handoff rows that keep failing for one card.
 *
 * Question-lane rows are keyed by the question, not by the card's dispatch, so
 * they are excluded here; they are still counted by the aggregate `queue.failed`.
 * Rows the board knows belong to a finished card are history, not a live loop.
 */
function queueLoopFindings(rows, boardByRef) {
  const groups = new Map();
  for (const row of rows) {
    if (String(row?.queue_kind ?? "handoff") === "question") continue;
    const ref = refOf(row);
    if (ref === null || knownTerminal(ref, boardByRef)) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(row);
  }
  const findings = [];
  for (const [ref, group] of groups) {
    const failedRows = group.filter((row) => String(row?.status ?? "") === "failed");
    if (group.length < LOOP_DISPATCH_ROWS_MIN && failedRows.length < LOOP_DISPATCH_FAILED_MIN) {
      continue;
    }
    const board = boardByRef.get(ref) ?? null;
    findings.push({
      ref,
      title: board?.title ?? null,
      status: board?.status ?? null,
      rows: group.length,
      failed: failedRows.length,
      // The row arrays are append-ordered (`enqueueCard`) and pruned in place, so
      // the last entry is the newest handoff and the last failed entry the newest
      // failure.
      last_status: group.at(-1)?.status ?? null,
      max_attempts: Math.max(...group.map(attemptsOf)),
      last_error: failedRows.at(-1)?.lastError ?? null,
    });
  }
  findings.sort(
    (left, right) =>
      right.failed - left.failed ||
      right.rows - left.rows ||
      right.max_attempts - left.max_attempts ||
      left.ref.localeCompare(right.ref),
  );
  return findings;
}

/**
 * Cards whose admission keeps failing.
 *
 * The ledger is the only durable record of an admission failure: a deferred card
 * is never enqueued, so the queue's attempt counters never see it. An unknown
 * card (a truncated board) stays unfiltered, like the other local halves.
 */
function deferralLoopFindings(rows, boardByRef, nowMs) {
  const findings = [];
  for (const entry of rows) {
    const ref = String(entry?.identifier ?? "").trim();
    if (ref === "") continue;
    if (knownTerminal(ref, boardByRef)) continue;
    const count = Number(entry?.count ?? 0);
    if (!Number.isFinite(count) || count < DEFERRAL_THRESHOLD) continue;
    const board = boardByRef.get(ref) ?? null;
    findings.push({
      ref,
      title: board?.title ?? null,
      status: board?.status ?? null,
      round: entry.round ?? null,
      count,
      code: typeof entry.code === "string" ? entry.code : null,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      first_at: entry.first_at ?? null,
      last_at: entry.last_at ?? null,
      age_ms: ageSince(entry.first_at ?? null, nowMs),
    });
  }
  findings.sort(
    (left, right) => right.count - left.count || left.ref.localeCompare(right.ref),
  );
  return findings;
}

/**
 * Failed subagent rows that keep accumulating for one card.
 *
 * Question-role rows are deliberately included: a subagent that cannot start for
 * the same card is the same loop whatever lane asked for it.
 */
function ledgerLoopFindings(rows, boardByRef) {
  const groups = new Map();
  for (const row of rows) {
    if (!LEDGER_FAILURE_STATUSES.has(String(row?.status ?? ""))) continue;
    const ref = refOf(row);
    if (ref === null || knownTerminal(ref, boardByRef)) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(row);
  }
  const findings = [];
  for (const [ref, group] of groups) {
    if (group.length < LOOP_SUBAGENT_FAILED_MIN) continue;
    const statuses = { failed: 0, interrupted: 0, stale: 0 };
    let newest = null;
    let newestAt = Number.NEGATIVE_INFINITY;
    for (const row of group) {
      statuses[String(row.status)] += 1;
      const at = Date.parse(String(row?.lastSeenAt ?? row?.startedAt ?? ""));
      if (Number.isFinite(at) && at > newestAt) {
        newest = row;
        newestAt = at;
      }
    }
    const board = boardByRef.get(ref) ?? null;
    findings.push({
      ref,
      title: board?.title ?? null,
      status: board?.status ?? null,
      failures: group.length,
      statuses,
      last_result: newest?.lastResult ?? null,
      last_seen_at: newest?.lastSeenAt ?? newest?.startedAt ?? null,
    });
  }
  findings.sort(
    (left, right) => right.failures - left.failures || left.ref.localeCompare(right.ref),
  );
  return findings;
}

function patrolReport(opts, nowMs) {
  const markerPath = opts.slaLastOk ?? null;
  const marker = readPeerMarker(markerPath);
  if (marker === null) {
    return { marker: markerPath, last_ok: null, age_ms: null, cadence_min: null, overdue: null };
  }
  const at = Date.parse(marker.lastOk);
  const ageMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : null;
  const cadenceMin = marker.periodMinutes;
  // No cadence, no threshold: the marker declares its own period, and inventing
  // one here would make an unconfigured deployment look permanently late.
  const overdue =
    ageMs === null || cadenceMin === null
      ? null
      : ageMs > PEER_LIVENESS_K * cadenceMin * 60_000;
  return {
    marker: markerPath,
    last_ok: marker.lastOk,
    age_ms: ageMs,
    cadence_min: cadenceMin,
    overdue,
  };
}

/**
 * Build the report. Exported so the CLI and the tests drive it without a process.
 *
 * @param {object} opts the loop's parsed options
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{run?: Function, isAlive?: Function, now?: Function, git?: Function}} [deps]
 */
export function doctorReport(opts, env = process.env, deps = {}) {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const git = deps.git ?? runGit;
  const errors = [];
  const skipped = [];

  // 1. The supervisor, and the scan set it resolved. A probe failure must not
  // stop the report: the local files are still worth reading.
  let supervisor = null;
  try {
    supervisor = probeSupervisor(opts, deps);
  } catch (error) {
    errors.push(`supervisor: ${error.message}`);
  }

  // The scan set is discovered roles plus the reviewer. A writer identity is not
  // a claim identity, so `--agent` never stands in for it; when nothing is
  // discovered the report says so, which is itself the finding.
  const agents = Array.isArray(supervisor?.agents) ? supervisor.agents : [];

  // 2. The patrol's own marker: a loop whose process is up but whose patrol no
  // longer completes looks healthy on `status` alone.
  let patrol = { marker: null, last_ok: null, age_ms: null, cadence_min: null, overdue: null };
  try {
    patrol = patrolReport(opts, nowMs);
  } catch (error) {
    errors.push(`patrol: ${error.message}`);
  }

  // 3. One board read — the patrol's view, so "stuck" means the same thing here
  // as it does to the pass that will act on it.
  let tasks = [];
  const board = { total: 0, truncated: false, counts: {}, error: null };
  try {
    const read = readBoard(
      {
        ...opts,
        // The read is attributed to the loop's own writer identity, never to a
        // discovered role the loop merely scans for.
        agents: Array.isArray(opts.agents) && opts.agents.length > 0 ? [...opts.agents] : ["agent"],
        // An inspection must never start a board as a side effect.
        cliEnv: { ...(opts.cliEnv ?? {}), TASKD_NO_AUTOSTART: "1" },
      },
      () => {},
    );
    if (!read.ok) {
      board.error = read.error ?? "board read failed";
      errors.push(`board: ${board.error}`);
    } else {
      tasks = Array.isArray(read.data?.tasks) ? read.data.tasks : [];
      board.total = tasks.length;
      board.truncated = read.truncated === true;
      board.counts = countStatuses(tasks);
    }
  } catch (error) {
    board.error = error.message;
    errors.push(`board: ${error.message}`);
  }

  // One projection of the snapshot, shared by the stuck and looping judgements.
  // An unreadable board yields empty maps, so every card-keyed section behaves as
  // before and the local loop halves still report.
  const boardByRef = new Map(tasks.map((task) => [task?.identifier, task]));
  const byId = new Map(tasks.map((task) => [task?.id, task?.identifier]));

  // 4. The log.
  let log;
  try {
    log = logTail(opts.log);
    if (log.error !== null) errors.push(`log: ${log.error}`);
  } catch (error) {
    log = { path: opts.log ?? null, source: "missing", lines: [], truncated: false, missing: true, error: error.message };
    errors.push(`log: ${error.message}`);
  }

  // 5. The queue and the subagent ledger, both beside the worker registry.
  const stateDir = dirname(String(opts.state));
  let queueRows = [];
  let ledgerRows = [];
  const queue = {
    file: join(stateDir, QUEUE_FILES.cards),
    depth: 0,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    dispatched: 0,
    total: 0,
    error: null,
  };
  try {
    const read = readCards(stateDir);
    if (read.error !== null) {
      queue.error = read.error;
      errors.push(`queue: ${read.error}`);
    }
    const cards = Array.isArray(read.value?.cards) ? read.value.cards : [];
    queueRows = cards;
    queue.total = cards.length;
    queue.pending = cards.filter((card) => card?.status === "pending").length;
    queue.processing = cards.filter((card) => card?.status === "processing").length;
    queue.done = cards.filter((card) => card?.status === "done").length;
    queue.failed = cards.filter((card) => card?.status === "failed").length;
    queue.dispatched = cards.filter((card) => card?.status === "dispatched").length;
    queue.depth = queue.pending + queue.processing;
  } catch (error) {
    queue.error = error.message;
    errors.push(`queue: ${error.message}`);
  }

  const subagents = {
    file: join(stateDir, QUEUE_FILES.ledger),
    live: 0,
    total: 0,
    by_status: {},
    error: null,
  };
  try {
    const read = readLedger(stateDir);
    if (read.error !== null) {
      subagents.error = read.error;
      errors.push(`subagents: ${read.error}`);
    }
    const rows = Array.isArray(read.value?.subagents) ? read.value.subagents : [];
    ledgerRows = rows;
    subagents.total = rows.length;
    subagents.live = liveSubagents(read.value).length;
    subagents.by_status = countStatuses(rows);
  } catch (error) {
    subagents.error = error.message;
    errors.push(`subagents: ${error.message}`);
  }

  // 6. The cards that look stuck, judged by the rule that already owns that
  // judgement: the patrol's stale-heartbeat plan. `in_review` is reported as a
  // fact, not a judgement — `review_aging` belongs to the workflow pass and
  // applies to *review* cards that are **not** in_review (`docs/lifecycle.md`).
  // Applying it here would call every delivery waiting for acceptance "aged".
  const stuck = { in_progress: [], total: 0 };
  const waiting = { in_review: [], total: 0 };
  if (board.error === null) {
    stuck.in_progress = planPatrol({ tasks, now: nowMs })
      .map((alert) => ({
        ref: alert.identifier,
        title: boardByRef.get(alert.identifier)?.title ?? null,
        agent: alert.agent ?? null,
        reason: alert.type,
        detail: alert.type === "heartbeat-unreadable" ? (alert.reason ?? null) : null,
        heartbeat_at: alert.heartbeatAt ?? null,
        age_ms: alert.ageMs ?? null,
        threshold_ms: alert.type === "stale" ? PATROL_STALE_MS : null,
      }))
      .sort(byAgeDesc);

    waiting.in_review = tasks
      .filter((task) => task?.status === "in_review")
      .map((task) => {
        const since = task.status_changed_at ?? task.created_at ?? null;
        const at = since === null || since === undefined ? Number.NaN : Date.parse(since);
        return {
          ref: task.identifier,
          title: task.title ?? null,
          since: since ?? null,
          age_ms: Number.isFinite(at) ? Math.max(0, nowMs - at) : null,
          review: reviewIdentityOf(task).isReview,
        };
      })
      .sort(byAgeDesc);
  }
  stuck.total = stuck.in_progress.length;
  waiting.total = waiting.in_review.length;

  // 6b. The admission-deferral ledger. A missing file is a fresh install, not an
  // error; only a malformed one is reported.
  let deferralRows = [];
  try {
    const read = readDeferralLedger(stateDir);
    if (read.error !== null) errors.push(`deferrals: ${read.error}`);
    deferralRows = Object.values(read.value.cards ?? {});
  } catch (error) {
    errors.push(`deferrals: ${error.message}`);
  }

  // 7. The cards that look like they are looping. The board half reuses the
  // same snapshot; the local halves read the queue and ledger rows the sections
  // above already loaded — no second file read. A card the board knows is
  // finished is dropped from the local halves: its failures are history. When
  // the board cannot be read that filter is unavailable and the local halves
  // still report, which is the conservative direction for an inspection.
  const boardLoop =
    board.error === null
      ? boardLoopFindings(tasks, byId, nowMs)
      : { rework_rounds: [], review_reopens: [] };
  // Cards the loop has already parked (a loop breaker wrote `meta.loop_hold_code`
  // and moved them to `blocked`). They are current state, not history: a human
  // must decide, and the row says which cycle and E-code asked.
  const heldCards =
    board.error === null
      ? tasks
          .filter((task) => {
            if (String(task?.status ?? "") !== "blocked") return false;
            const code = task?.meta?.loop_hold_code;
            return typeof code === "string" && code !== "";
          })
          .map((task) => {
            const since = task.status_changed_at ?? task.updated_at ?? task.created_at ?? null;
            const at = since === null ? Number.NaN : Date.parse(since);
            return {
              ref: task.identifier,
              title: task.title ?? null,
              code: task.meta.loop_hold_code,
              e_code: task.meta.loop_hold_e_code ?? null,
              round: task.delivery_round ?? null,
              since: since ?? null,
              age_ms: Number.isFinite(at) ? Math.max(0, nowMs - at) : null,
            };
          })
          .sort(byAgeDesc)
      : [];
  // The other three dead ends, each read from the source that owns it: the
  // board for a human wait and an unowned card, the queue for a director row
  // that exhausted its bound, and the session records for a live agent child
  // whose row outlived the turn bound.
  const awaitingCards =
    board.error === null
      ? tasks
          .filter((task) => String(task?.status ?? "") === "awaiting")
          .map((task) => {
            const since = task.status_changed_at ?? task.created_at ?? null;
            const at = Date.parse(String(since ?? ""));
            return {
              ref: task.identifier,
              title: task.title ?? null,
              reason: task.awaiting_reason ?? null,
              since: since ?? null,
              age_ms: Number.isFinite(at) ? Math.max(0, nowMs - at) : null,
            };
          })
          .sort(byAgeDesc)
      : [];

  const questionLane = (() => {
    const byCard = new Map();
    for (const row of queueRows) {
      if (String(row?.queue_kind ?? "") !== "question") continue;
      if (String(row?.status ?? "") !== "failed") continue;
      const ref = String(row?.card ?? "");
      if (ref === "") continue;
      const entry =
        byCard.get(ref) ?? {
          ref,
          lane: row?.triage === true ? "triage" : row?.route === true ? "route" : "question",
          rows: 0,
          attempts: 0,
          last_error: null,
          last_at: null,
        };
      entry.rows += 1;
      entry.attempts += Math.max(1, Number(row?.attempts ?? 0));
      if (entry.last_error === null) entry.last_error = row?.lastError ?? null;
      const at = String(row?.completedAt ?? row?.enqueuedAt ?? "");
      if (entry.last_at === null || (at !== "" && at > entry.last_at)) entry.last_at = at || null;
      byCard.set(ref, entry);
    }
    return [...byCard.values()];
  })();

  // An accepted producer whose required handoff has no decision for its
  // current round. A triage row that is still pending/processing suppresses the
  // finding (the decision is in flight); a freshly accepted card gets a grace
  // window so the next poll can enqueue the row first.
  const HANDOFF_TRIAGE_GRACE_MS = 10 * 60_000;
  const openTriage = new Set(
    queueRows
      .filter(
        (row) =>
          row?.triage === true &&
          String(row?.status ?? "") !== "done" &&
          String(row?.status ?? "") !== "failed",
      )
      .map((row) => String(row?.card ?? "")),
  );
  const handoffUnconsumed =
    board.error === null
      ? tasks
          .filter((task) => {
            if (String(task?.status ?? "") !== "done") return false;
            if (String(task?.kind ?? "") === "epic") return false;
            if (reviewIdentityOf(task).isReview) return false;
            const meta = task?.meta ?? {};
            if (String(meta.stage_handoff ?? "") !== "required") return false;
            const round = Number(task?.delivery_round);
            if (!Number.isFinite(round)) return false;
            if (Number(meta.handoff_consumed_round) === round) return false;
            if (Number(meta.handoff_declined_round) === round) return false;
            const ref = String(task?.identifier ?? "");
            if (ref === "" || openTriage.has(ref)) return false;
            const at = Date.parse(String(task?.status_changed_at ?? ""));
            if (Number.isFinite(at) && nowMs - at < HANDOFF_TRIAGE_GRACE_MS) return false;
            return true;
          })
          .map((task) => ({
            ref: task.identifier,
            title: task.title ?? null,
            round: Number(task.delivery_round),
            since: task.status_changed_at ?? null,
            age_ms: Number.isFinite(Date.parse(String(task.status_changed_at ?? "")))
              ? Math.max(0, nowMs - Date.parse(String(task.status_changed_at)))
              : null,
          }))
          .sort(byAgeDesc)
      : [];

  const unownedCards =
    board.error === null
      ? tasks
          .filter(
            (task) =>
              String(task?.status ?? "") === "todo" &&
              String(task?.kind ?? "") !== "epic" &&
              (() => {
                const assignee = task?.assignee ?? {};
                const id = typeof assignee.id === "string" ? assignee.id : "";
                const name = typeof assignee.display_name === "string" ? assignee.display_name : "";
                return id === "" && name === "";
              })(),
          )
          .map((task) => {
            const since = task.updated_at ?? task.created_at ?? null;
            const at = Date.parse(String(since ?? ""));
            return {
              ref: task.identifier,
              title: task.title ?? null,
              since: since ?? null,
              age_ms: Number.isFinite(at) ? Math.max(0, nowMs - at) : null,
            };
          })
          .filter((card) => card.age_ms !== null && card.age_ms >= ROUTE_UNASSIGNED_MS)
          .sort(byAgeDesc)
      : [];

  const orphanedRows = (() => {
    const read = readWorkerSessions(stateDir);
    const turnMs =
      Number(opts.sessionTurnTimeoutMs) > 0
        ? Number(opts.sessionTurnTimeoutMs)
        : SESSION_DEFAULTS.turnTimeoutMs;
    const bound = 2 * turnMs;
    const alive = typeof deps.isAlive === "function" ? deps.isAlive : isProcessAlive;
    const owners = new Map();
    for (const [key, record] of Object.entries(read.workers ?? {})) {
      const pid = Number(record?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) continue;
      const since = Date.parse(
        String(record?.startedAt ?? record?.lastUsedAt ?? record?.lastHeartbeatAt ?? ""),
      );
      const age = Number.isFinite(since) ? Math.max(0, nowMs - since) : null;
      const owner = { key, pid, age };
      if (typeof record?.cwd === "string" && record.cwd !== "") owners.set(record.cwd, owner);
      owners.set(key, owner);
    }
    const rows = [];
    for (const row of queueRows) {
      if (String(row?.status ?? "") !== "processing") continue;
      // A review card now runs in its own claimed session, so a stale review
      // handoff is the same finding as a stale worker one.
      const owner = owners.get(String(row?.target_dir ?? row?.claimedBy ?? ""));
      if (owner === undefined || owner.age === null || owner.age < bound) continue;
      rows.push({
        ref: row?.card ?? null,
        owner: owner.key,
        pid: owner.pid,
        age_ms: owner.age,
        bound_ms: bound,
      });
    }
    return rows.sort(byAgeDesc);
  })();

  const looping = {
    rework_rounds: boardLoop.rework_rounds,
    review_reopens: boardLoop.review_reopens,
    dispatch_retries: queueLoopFindings(queueRows, boardByRef),
    subagent_failures: ledgerLoopFindings(ledgerRows, boardByRef),
    deferrals: deferralLoopFindings(deferralRows, boardByRef, nowMs),
    held: heldCards,
    awaiting: awaitingCards,
    question_lane: questionLane,
    unowned: unownedCards,
    orphaned: orphanedRows,
    total: 0,
  };
  // One card, one count: a card may be named by more than one list, and the
  // attention total must not double-count it.
  const loopRefs = new Set();
  for (const list of [
    looping.rework_rounds,
    looping.review_reopens,
    looping.dispatch_retries,
    looping.subagent_failures,
    looping.deferrals,
    looping.held,
    looping.awaiting,
    looping.question_lane,
    looping.unowned,
    looping.orphaned,
  ]) {
    for (const card of list) {
      if (typeof card.ref === "string" && card.ref !== "") loopRefs.add(card.ref);
    }
  }
  looping.total = loopRefs.size;

  // An approval the board refused leaves `meta.accepted_by` on a card that is
  // still `in_review`: the marker records an acceptance the row never reached.
  // The workflow pass now routes that refusal back for a new round (which bumps
  // the round and turns the marker into history), so what remains here is a
  // card the reopen has not reached yet — or a verdict written before it could.
  const blockedAcceptance = { cards: [], total: 0 };
  if (board.error === null) {
    blockedAcceptance.cards = tasks
      .filter((task) => {
        if (task?.status !== "in_review") return false;
        const acceptedBy = task?.meta?.accepted_by;
        const acceptedRound = task?.meta?.accepted_round;
        if (typeof acceptedBy !== "string" || acceptedBy === "") return false;
        if (acceptedRound === undefined || acceptedRound === null || String(acceptedRound) === "") {
          return false;
        }
        return String(acceptedRound) === String(task?.delivery_round ?? "");
      })
      .map((task) => {
        const since = task.status_changed_at ?? task.created_at ?? null;
        const at = since === null || since === undefined ? Number.NaN : Date.parse(since);
        return {
          ref: task.identifier,
          title: task.title ?? null,
          round: task.delivery_round ?? null,
          accepted_by: task.meta.accepted_by,
          since: since ?? null,
          age_ms: Number.isFinite(at) ? Math.max(0, nowMs - at) : null,
        };
      })
      .sort(byAgeDesc);
  }
  blockedAcceptance.total = blockedAcceptance.cards.length;

  // 8. Acceptances whose lane never landed. `done` is the board's answer, not
  // git's: a card worked in a tree the loop never registered is accepted with
  // its branch still unmerged, and nothing else looks. Only `done` counts — a
  // `canceled` branch is abandoned work, and an active lane is correctly open.
  // The project's directory comes from the loop's own map (`projects.json`), not
  // from the card: `meta.target` is an opaque label, not a checkout path.
  const unlanded = { cards: [], total: 0 };
  if (board.error === null) {
    const byProject = new Map();
    for (const task of tasks) {
      if (task?.status !== "done" || reviewIdentityOf(task).isReview) continue;
      const project = String(task?.project_id ?? task?.project ?? "").trim();
      if (project === "") continue;
      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project).push(task);
    }
    for (const [project, cards] of byProject) {
      const target = resolveWakeTarget({ project, projectsJson: opts.projectsJson });
      if (target.ok !== true) {
        skipped.push(`unlanded: ${project} (${target.code})`);
        continue;
      }
      const worktreeText = gitRead(git, target.dir, ["worktree", "list", "--porcelain"]);
      const unmergedText = gitRead(git, target.dir, ["branch", "--no-merged", "HEAD"]);
      if (worktreeText === null || unmergedText === null) {
        skipped.push(`unlanded: ${project} (git unavailable)`);
        continue;
      }
      const worktrees = parseWorktrees(worktreeText);
      const open = parseUnmerged(unmergedText);
      for (const task of cards) {
        const ref = String(task.identifier ?? "");
        if (ref === "") continue;
        // Two ways a lane outlives the card: its worktree is still on disk, or
        // (after a cleanup) only the branch is. The worktree is matched by path
        // because a session's own name never has to follow the loop's.
        const tree = worktrees.find((row) => {
          const name = basename(row.path);
          return name === ref || name.startsWith(`${ref}-`);
        });
        if (tree !== undefined && tree.branch !== null && open.has(tree.branch)) {
          unlanded.cards.push({ ref, title: task.title ?? null, branch: tree.branch, path: tree.path });
          continue;
        }
        const branch = [...open].find(
          (name) => name === `lane/${ref}` || name.startsWith(`lane/${ref}-`),
        );
        if (branch !== undefined) {
          unlanded.cards.push({ ref, title: task.title ?? null, branch, path: null });
        }
      }
    }
    unlanded.cards.sort((left, right) => left.ref.localeCompare(right.ref));
  }
  unlanded.total = unlanded.cards.length;

  // A registry record whose tree and branch are both gone cannot be landed and
  // can only mislead a rework. Only cards the board snapshot knows are judged;
  // an unknown card (or a failed board read) is left alone.
  const workspaces = { file: registryPath(stateDir), total: 0, stale: [], error: null };
  try {
    const registry = readWorkspaceRegistry(stateDir);
    workspaces.total = registry.workspaces.length;
    if (board.error === null) {
      for (const record of registry.workspaces) {
        const task = boardByRef.get(record.identifier);
        if (task === undefined || TERMINAL_STATUSES.includes(String(task.status ?? ""))) {
          continue;
        }
        if (isStaleWorkspaceRecord(record, { run: git })) {
          workspaces.stale.push({
            ref: record.identifier,
            round: record.round ?? null,
            branch: record.branch ?? null,
            path: record.path ?? null,
            project_dir: record.project_dir ?? null,
          });
        }
      }
    }
  } catch (error) {
    workspaces.error = error.message;
    errors.push(`workspaces: ${error.message}`);
  }

  // 8. The card-own worker sessions. A blocked/stale record means a resume was
  // attempted and failed; a missing worktree means the session cannot run where
  // it was created. A missing file is a fresh install, not an error.
  const workers = {
    total: 0,
    running: 0,
    by_status: {},
    by_resume_state: {},
    blocked: [],
    stale: [],
    missing_worktree: [],
    error: null,
  };
  try {
    const read = readWorkerSessions(stateDir);
    const records = Object.entries(read.workers ?? {});
    workers.total = records.length;
    for (const [key, record] of records) {
      const status = String(record?.status ?? "idle");
      workers.by_status[status] = (workers.by_status[status] ?? 0) + 1;
      if (status === "running") workers.running += 1;
      const resumeState = String(record?.resumeState ?? "fresh");
      workers.by_resume_state[resumeState] = (workers.by_resume_state[resumeState] ?? 0) + 1;
      if (record?.blocked === true || status === "blocked") {
        workers.blocked.push({ key, card: record?.card ?? null, error: record?.lastError ?? null });
      }
      if (status === "stale") {
        workers.stale.push({ key, card: record?.card ?? null, error: record?.lastError ?? null });
      }
      if (
        typeof record?.worktree === "string" &&
        record.worktree !== "" &&
        !existsSync(record.worktree)
      ) {
        workers.missing_worktree.push({
          key,
          card: record?.card ?? null,
          worktree: record.worktree,
        });
      }
    }
    if (read.error !== null) workers.error = read.error;
  } catch (error) {
    workers.error = error.message;
    errors.push(`workers: ${error.message}`);
  }

  const attentionReasons = [];
  if (stuck.total > 0) attentionReasons.push(`stuck_cards: ${stuck.total}`);
  if (looping.total > 0) attentionReasons.push(`looping: ${looping.total}`);
  if (blockedAcceptance.total > 0) {
    attentionReasons.push(`blocked_acceptance: ${blockedAcceptance.total}`);
  }
  if (unlanded.total > 0) attentionReasons.push(`unlanded: ${unlanded.total}`);
  if (workspaces.stale.length > 0) {
    attentionReasons.push(`stale_workspaces: ${workspaces.stale.length}`);
  }
  const workerIssues = new Set([
    ...workers.blocked.map((record) => record.key),
    ...workers.stale.map((record) => record.key),
  ]);
  if (workerIssues.size > 0) {
    attentionReasons.push(`workers: ${workerIssues.size}`);
  }
  if (workers.missing_worktree.length > 0) {
    attentionReasons.push(`worker_worktrees: ${workers.missing_worktree.length}`);
  }
  if (queue.failed > 0) attentionReasons.push(`queue: ${queue.failed} failed`);
  if (handoffUnconsumed.length > 0) {
    attentionReasons.push(`handoff_unconsumed: ${handoffUnconsumed.length}`);
  }
  if (supervisor?.verdict === "absent" || supervisor?.verdict === "partial") {
    attentionReasons.push(`supervisor: ${supervisor.verdict}`);
  }
  if (board.truncated) attentionReasons.push("board: read truncated");
  if (patrol.overdue === true) attentionReasons.push("patrol: marker overdue");
  if (errors.length > 0) attentionReasons.push(`errors: ${errors.length}`);
  if (skipped.length > 0) attentionReasons.push(`skipped: ${skipped.length}`);

  return {
    read_only: true,
    ok: errors.length === 0 && skipped.length === 0,
    attention: attentionReasons.length > 0,
    attention_reasons: attentionReasons,
    generated_at: new Date(nowMs).toISOString(),
    supervisor,
    agents,
    // Where each discovered role is installed and where it will run; the same
    // report `loop status` prints, carried here so a daily inspection can see a
    // role stranded on a kind whose CLI cannot start.
    roles: Array.isArray(supervisor?.roles) ? supervisor.roles : [],
    patrol,
    board,
    log,
    queue,
    subagents,
    stuck_cards: stuck,
    looping,
    waiting,
    handoff_unconsumed: handoffUnconsumed,
    blocked_acceptance: blockedAcceptance,
    unlanded,
    workspaces,
    workers,
    errors,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// The page a human reads
// ---------------------------------------------------------------------------

function minutes(ms) {
  return `${Math.round(ms / 60_000)}m`;
}

function humanReport(report) {
  const lines = [`loop doctor  ${report.generated_at}`];

  const pool = report.supervisor?.pool;
  for (const line of report.roles ?? []) lines.push(`  ${line}`);
  lines.push(
    `supervisor  ${report.supervisor?.verdict ?? "unknown"}` +
      (pool?.live === true ? `  pool pid ${pool.poolPid}` : ""),
  );
  lines.push(`agents      ${report.agents.length > 0 ? report.agents.join(", ") : "(none resolved)"}`);

  const patrolDetail = [];
  if (report.patrol.age_ms !== null) patrolDetail.push(`${minutes(report.patrol.age_ms)} ago`);
  if (report.patrol.cadence_min !== null) patrolDetail.push(`cadence ${report.patrol.cadence_min}m`);
  if (report.patrol.overdue === true) patrolDetail.push("OVERDUE");
  lines.push(
    report.patrol.last_ok === null
      ? `patrol      no marker${report.patrol.marker ? ` (${report.patrol.marker})` : ""}`
      : `patrol      last_ok ${report.patrol.last_ok}` +
          (patrolDetail.length > 0 ? ` (${patrolDetail.join(", ")})` : ""),
  );

  const counts = Object.entries(report.board.counts)
    .map(([status, count]) => `${status} ${count}`)
    .join(", ");
  lines.push(
    `board       ${report.board.total} card(s)${counts === "" ? "" : ` — ${counts}`}` +
      (report.board.truncated ? "  TRUNCATED (may be a lower bound)" : "") +
      (report.board.error === null ? "" : `  ERROR ${report.board.error}`),
  );

  if (report.log.missing) {
    lines.push(`log         ${report.log.path ?? "(none)"} (missing)`);
  } else if (report.log.error !== null) {
    lines.push(`log         ${report.log.path} (unreadable: ${report.log.error})`);
  } else {
    lines.push(
      `log         ${report.log.path} (last ${report.log.lines.length} lines` +
        `${report.log.truncated ? ", older lines dropped" : ""})`,
    );
    for (const line of report.log.lines) lines.push(`  ${line}`);
  }

  lines.push(
    `queue       depth ${report.queue.depth} (pending ${report.queue.pending}, ` +
      `processing ${report.queue.processing}, failed ${report.queue.failed})`,
  );
  lines.push(`subagents   live ${report.subagents.live} / total ${report.subagents.total}`);
  lines.push(
    `workers     running ${report.workers.running} / total ${report.workers.total}` +
      (report.workers.blocked.length + report.workers.stale.length > 0
        ? ` (blocked ${report.workers.blocked.length}, stale ${report.workers.stale.length})`
        : ""),
  );

  lines.push(`stuck       ${report.stuck_cards.total} card(s): ${report.stuck_cards.in_progress.length} in_progress`);
  for (const card of report.stuck_cards.in_progress) {
    const why =
      card.reason === "stale"
        ? `stale ${minutes(card.age_ms)} > ${minutes(card.threshold_ms)}`
        : `heartbeat-unreadable (${card.detail ?? "unknown"})`;
    lines.push(`  ${card.ref}  in_progress  ${why}  ${card.title ?? ""}`.trimEnd());
  }

  const loopKinds = [
    ["rework", report.looping.rework_rounds.length],
    ["review-reopen", report.looping.review_reopens.length],
    ["dispatch", report.looping.dispatch_retries.length],
    ["subagent", report.looping.subagent_failures.length],
    ["deferred", report.looping.deferrals.length],
    ["held", report.looping.held.length],
    ["awaiting", report.looping.awaiting.length],
    ["question-lane", report.looping.question_lane.length],
    ["unowned", report.looping.unowned.length],
    ["orphaned", report.looping.orphaned.length],
  ];
  const loopListed = loopKinds.reduce((sum, [, count]) => sum + count, 0);
  lines.push(
    `looping     ${report.looping.total} card(s) — ${loopKinds
      .map(([name, count]) => `${name} ${count}`)
      .join(", ")}` + (loopListed > report.looping.total ? " (a card can appear in more than one list)" : ""),
  );
  for (const card of report.looping.rework_rounds) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref}  rework  round ${card.round}  ${card.status ?? "?"}  ${age}` +
        `${card.kind === "epic" ? "  [epic]" : ""}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.review_reopens) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref}  review-reopen  retries ${card.retries}  own round ${card.own_round}` +
        `  audits ${card.audited_round ?? "?"}  ${card.status ?? "?"}  ${age}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.dispatch_retries) {
    const last = card.last_status === null ? "" : `, last ${card.last_status}`;
    const detail = oneLine(card.last_error);
    lines.push(
      `  ${card.ref}  dispatch  ${card.rows} handoff(s) (${card.failed} failed${last})` +
        `  ${card.status ?? "?"}${detail === "" ? "" : `  ${detail}`}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.subagent_failures) {
    const detail = oneLine(card.last_result);
    lines.push(
      `  ${card.ref}  subagent  ${card.failures} failure(s)` +
        `  ${card.status ?? "?"}${detail === "" ? "" : `  ${detail}`}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.deferrals) {
    const detail = oneLine(card.reason);
    lines.push(
      `  ${card.ref}  deferred  ${card.count}x  ${card.code ?? "?"}` +
        `  ${card.status ?? "?"}${detail === "" ? "" : `  ${detail}`}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.held) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref}  held  ${card.code}${card.e_code === null ? "" : ` ${card.e_code}`}` +
        `  round ${card.round ?? "?"}  blocked ${age}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.awaiting) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref}  awaiting  ${card.reason ?? "?"}  ${age}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.question_lane) {
    const detail = oneLine(card.last_error);
    lines.push(
      `  ${card.ref}  ${card.lane}-lane  ${card.rows} row(s), ${card.attempts} attempt(s)` +
        `${detail === "" ? "" : `  ${detail}`}  ${card.title ?? ""}`.trimEnd(),
    );
  }
  for (const card of report.looping.unowned) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(`  ${card.ref}  unowned  ${age}  ${card.title ?? ""}`.trimEnd());
  }
  for (const card of report.looping.orphaned) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref ?? "?"}  orphaned  pid ${card.pid}  ${age} > ${minutes(card.bound_ms)}` +
        `  ${card.title ?? ""}`.trimEnd(),
    );
  }
  if (report.workspaces.stale.length > 0) {
    lines.push(
      `workspaces  ${report.workspaces.stale.length} stale record(s) for non-terminal cards ` +
        "— the tree and branch are both gone",
    );
    for (const record of report.workspaces.stale) {
      lines.push(
        `  ${record.ref}  r${record.round ?? "?"}  ${record.branch ?? "?"}  ${record.path ?? ""}`.trimEnd(),
      );
    }
  }

  const oldest = report.waiting.in_review.reduce(
    (max, card) => (card.age_ms !== null && (max === null || card.age_ms > max) ? card.age_ms : max),
    null,
  );
  lines.push(
    `waiting     ${report.waiting.total} in_review` +
      (oldest === null ? "" : ` (oldest ${minutes(oldest)})`) +
      " — age only; review aging is the workflow pass's",
  );
  for (const card of report.waiting.in_review) {
    const age = card.age_ms === null ? "?" : minutes(card.age_ms);
    lines.push(
      `  ${card.ref}  in_review  ${age}${card.review ? "  [review]" : ""}  ${card.title ?? ""}`.trimEnd(),
    );
  }

  if (report.blocked_acceptance.total > 0) {
    lines.push(
      `blocked     ${report.blocked_acceptance.total} accepted but still in_review ` +
        "— the board refused the close",
    );
    for (const card of report.blocked_acceptance.cards) {
      const age = card.age_ms === null ? "?" : minutes(card.age_ms);
      lines.push(
        `  ${card.ref}  in_review  round ${card.round ?? "?"}  ${age}  ` +
          `[${card.accepted_by}]  ${card.title ?? ""}`.trimEnd(),
      );
    }
  }

  if (report.unlanded.total > 0) {
    lines.push(
      `unlanded    ${report.unlanded.total} done card(s) whose branch is not merged ` +
        "— `done` is the board's answer, not git's",
    );
    for (const card of report.unlanded.cards) {
      lines.push(
        `  ${card.ref}  done  ${card.branch}${card.path === null ? "" : `  ${card.path}`}  ` +
          `${card.title ?? ""}`.trimEnd(),
      );
    }
  }

  lines.push(`errors      ${report.errors.length === 0 ? "none" : report.errors.join("; ")}`);
  lines.push(
    `attention   ${report.attention ? `yes — ${report.attention_reasons.join("; ")}` : "no"}`,
  );
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [deps]
 * @param {{out?: Function, err?: Function}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env, deps = {}, io = {}) {
  const writeOut = io.out ?? ((text) => process.stdout.write(text));
  const writeErr = io.err ?? ((text) => process.stderr.write(text));
  const json = argv.includes("--json");

  let opts;
  try {
    opts = parseArgs(
      argv.filter((arg) => arg !== "--json"),
      env,
    );
  } catch (error) {
    writeErr(`doctor: ${error.message}\n`);
    return 2;
  }
  if (opts.help) {
    writeOut(`${USAGE}\n`);
    return 0;
  }

  let report;
  try {
    report = doctorReport(opts, env, deps);
  } catch (error) {
    writeErr(`doctor: ${error.message}\n`);
    return 1;
  }
  writeOut(`${json ? JSON.stringify(report, null, 2) : humanReport(report)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
