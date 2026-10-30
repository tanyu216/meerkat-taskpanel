#!/usr/bin/env node
/**
 * `taskctl loop doctor` — one read-only daily-inspection report.
 *
 * The loop's other read verbs each answer one question (`status`: is the process
 * up; `console`: what is waiting on a human; `compat`: can this loop drive this
 * board). A human keeping a team alive has to ask all of them, then read the log
 * and the queue by hand. This verb asks them together and adds the two facts the
 * answers do not carry: whether the patrol is still *completing*, and which cards
 * are stuck.
 *
 * **It is not a pass.** It claims nothing, dispatches nothing, starts no process,
 * writes no state and opens no logger — an inspection that changed the thing it
 * inspected would be worth nothing. Every judgement is reused, never restated:
 * the verdict is `probeSupervisor`, the board read is `readBoard` (one call, the
 * patrol's own view), the stale-heartbeat line is `planPatrol`, and the review
 * line is the workflow's `review_aging` setting resolved once.
 *
 * Exit codes: 0 whenever a report was produced — a report that says "attention"
 * is a successful inspection. 2 on a usage error, 1 only when no report could be
 * built at all. Automation reads `attention` from `--json`; a non-zero code here
 * would make an unhealthy loop indistinguishable from a broken doctor.
 */

import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkBoard } from "../foundation/board-compat.mjs";
import { isEntryPoint } from "../foundation/entry-guard.mjs";
import { QUEUE_FILES } from "../foundation/loop-state.mjs";
import { reviewIdentityOf } from "../foundation/review-identity.mjs";
import { PATROL_STALE_MS, planPatrol } from "../foundation/scheduling.mjs";
import { readBoard } from "./board.mjs";
import { liveSubagents, readLedger } from "./ledger.mjs";
import { parseArgs } from "./options.mjs";
import { readCards } from "./queue.mjs";
import { readPeerMarker } from "./runtime.mjs";
import { probeSupervisor } from "./status.mjs";

/** How many log lines the report carries, and how many bytes it will read for them. */
export const LOG_TAIL_LINES = 40;
export const LOG_TAIL_BYTES = 64 * 1024;
/**
 * How much of one line survives. The live log embeds whole assistant messages in
 * `msg="…"`, so an uncapped line turns a 40-line tail into pages of one report.
 */
export const LOG_TAIL_LINE_CHARS = 200;

/** The peer-marker rule: a marker older than this many cadences means "stalled". */
const PEER_LIVENESS_K = 3;

export const USAGE = `Usage: taskctl loop doctor [--state <path>] [--log <path>] [--config <path>]

One read-only inspection: the supervisor verdict, the resolved scan set, board
compatibility, the patrol's last-successful-run marker, the tail of the loop log,
the dispatch queue and the subagent ledger, and the cards that look stuck.

It writes nothing, claims nothing and starts no process. The exit code is 0
whenever a report was produced; read \`attention\` from --json.`;

function defaultBoardRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

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
 * @param {{run?: Function, isAlive?: Function, now?: Function, boardRun?: Function}} [deps]
 */
export function doctorReport(opts, env = process.env, deps = {}) {
  const now = deps.now ?? Date.now;
  const nowMs = now();
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

  const fromProbe = Array.isArray(supervisor?.agents) ? supervisor.agents : [];
  const agents = fromProbe.length > 0 ? fromProbe : Array.isArray(opts.agents) ? [...opts.agents] : [];

  // 2. The patrol's own marker: a loop whose process is up but whose patrol no
  // longer completes looks healthy on `status` alone.
  let patrol = { marker: null, last_ok: null, age_ms: null, cadence_min: null, overdue: null };
  try {
    patrol = patrolReport(opts, nowMs);
  } catch (error) {
    errors.push(`patrol: ${error.message}`);
  }

  // 3. The board interface, asked with the same `--cli` the reads use.
  let compat = null;
  if (typeof opts.cli !== "string" || opts.cli === "") {
    skipped.push("compat: no --cli resolved");
  } else {
    try {
      const run = deps.boardRun ?? defaultBoardRun;
      compat = checkBoard({ command: process.execPath, args: [opts.cli, "--version", "--json"], run });
    } catch (error) {
      errors.push(`compat: ${error.message}`);
      compat = { ok: false, code: "BOARD_UNREACHABLE", message: error.message };
    }
  }

  // 4. One board read — the patrol's view, so "stuck" means the same thing here
  // as it does to the pass that will act on it.
  let tasks = [];
  const board = { total: 0, truncated: false, counts: {}, error: null };
  try {
    const read = readBoard(
      {
        ...opts,
        agents: agents.length > 0 ? agents : ["agent"],
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

  // 5. The log.
  let log;
  try {
    log = logTail(opts.log);
    if (log.error !== null) errors.push(`log: ${log.error}`);
  } catch (error) {
    log = { path: opts.log ?? null, source: "missing", lines: [], truncated: false, missing: true, error: error.message };
    errors.push(`log: ${error.message}`);
  }

  // 6. The queue and the subagent ledger, both beside the worker registry.
  const stateDir = dirname(String(opts.state));
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
    subagents.total = rows.length;
    subagents.live = liveSubagents(read.value).length;
    subagents.by_status = countStatuses(rows);
  } catch (error) {
    subagents.error = error.message;
    errors.push(`subagents: ${error.message}`);
  }

  // 7. The cards that look stuck, judged by the rule that already owns that
  // judgement: the patrol's stale-heartbeat plan. `in_review` is reported as a
  // fact, not a judgement — `review_aging` belongs to the workflow pass and
  // applies to *review* cards that are **not** in_review (`docs/lifecycle.md`).
  // Applying it here would call every delivery waiting for acceptance "aged".
  const stuck = { in_progress: [], total: 0 };
  const waiting = { in_review: [], total: 0 };
  if (board.error === null) {
    const titles = new Map(tasks.map((task) => [task?.identifier, task?.title ?? null]));
    stuck.in_progress = planPatrol({ tasks, now: nowMs })
      .map((alert) => ({
        ref: alert.identifier,
        title: titles.get(alert.identifier) ?? null,
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

  const attentionReasons = [];
  if (stuck.total > 0) attentionReasons.push(`stuck_cards: ${stuck.total}`);
  if (blockedAcceptance.total > 0) {
    attentionReasons.push(`blocked_acceptance: ${blockedAcceptance.total}`);
  }
  if (compat !== null && compat.ok !== true) attentionReasons.push(`compat: ${compat.code}`);
  if (queue.failed > 0) attentionReasons.push(`queue: ${queue.failed} failed`);
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
    patrol,
    compat,
    board,
    log,
    queue,
    subagents,
    stuck_cards: stuck,
    waiting,
    blocked_acceptance: blockedAcceptance,
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
  lines.push(
    `supervisor  ${report.supervisor?.verdict ?? "unknown"}` +
      (pool?.live === true ? `  pool pid ${pool.poolPid} (control ${pool.controlMode})` : ""),
  );
  lines.push(`agents      ${report.agents.length > 0 ? report.agents.join(", ") : "(none resolved)"}`);

  lines.push(
    report.compat === null
      ? "compat      skipped"
      : report.compat.ok === true
        ? `compat      OK — board ${report.compat.version} (schema_version ${report.compat.schemaVersion ?? "?"}) satisfies ${report.compat.boardInterface}`
        : `compat      FAILED — ${report.compat.code}: ${report.compat.message}`,
  );

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

  lines.push(`stuck       ${report.stuck_cards.total} card(s): ${report.stuck_cards.in_progress.length} in_progress`);
  for (const card of report.stuck_cards.in_progress) {
    const why =
      card.reason === "stale"
        ? `stale ${minutes(card.age_ms)} > ${minutes(card.threshold_ms)}`
        : `heartbeat-unreadable (${card.detail ?? "unknown"})`;
    lines.push(`  ${card.ref}  in_progress  ${why}  ${card.title ?? ""}`.trimEnd());
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
