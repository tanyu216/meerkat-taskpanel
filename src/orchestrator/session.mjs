/**
 * The resident session pool — the loop's long-lived agent conversations.
 *
 * One **card** session per card — worker or review — plus one **director** lane
 * per project directory for the question lane. The director decision turn runs
 * in the directory's project context; no session spawns another.
 *
 * The pool manager owns the queues, routing, ledger, concurrency, heartbeat,
 * idle eviction and resume. It never speaks the board's HTTP API: the
 * supervisor's tick runs `taskctl loop patrol|workflow|poll`, the poll pass
 * writes the card queue, and the pool's one board write is the card's session
 * row through `taskctl session set|close` (`board-session.mjs`).
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { cardDirRel, cardFileRel } from "../foundation/card-brief.mjs";
import { DIRECTOR_ACTOR_ID, ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
import { pidMatches, processStartToken } from "../foundation/daemon-state.mjs";
import { acquireFileLock, releaseFileLock } from "../foundation/file-lock.mjs";
import {
  loadRoles,
  resolveDirectorSkill,
  roleVariant,
  selectRole,
  selectWorkerRole,
  skillFingerprint,
  skillLoadMode,
} from "../foundation/roles.mjs";
import {
  buildQuestionPrompt,
  buildSessionSystemPrompt,
  REVIEWER_SYSTEM_PROMPT_FALLBACK,
  WORKER_SYSTEM_PROMPT_FALLBACK,
} from "../foundation/scheduling.mjs";
import { holdCard, releaseCard } from "./holds.mjs";
import { createKindPool } from "./kind-session.mjs";
import { agentPaths } from "./options.mjs";
import { drainInFlight, readCardForRedispatch, readQuestionOutcome, readRedispatchContext, readRouteOutcome, readTriageOutcome, runCli, runCliAsync } from "./runtime.mjs";
import { createBoardSession } from "./board-session.mjs";
import { isTurnTimeoutError } from "./turn-errors.mjs";
import {
  appendWorkerTurn,
  buildWorkerDispatchPrompt,
  buildWorkerReplayPrompt,
  buildWorkerResumePrompt,
  buildWorkerReworkPrompt,
  copyWorkerTranscript,
  dropOlderWorkerRecords,
  isWorkerKey,
  moveWorkerTranscript,
  parseWorkerKey,
  planWorkerCarry,
  planWorkerOpen,
  readWorkerSessions,
  readWorkerTranscript,
  retireWorkerGenerations,
  roundOf,
  transcriptFile,
  workerKey,
} from "./worker-session.mjs";

/** Role warnings are configuration noise; say each one once per process. */
const loggedRoleWarnings = new Set();
import {
  claimCards,
  completeCards,
  ensureStateDir,
  pruneCards,
  readCards,
  readJsonFile,
  recoverStaleCards,
  requeueCards,
  resumeCards,
  retireLegacyDispatched,
  timeoutCards,
  TIMEOUT_MAX_ATTEMPTS,
  writeJsonFile,
} from "./queue.mjs";
import {
  liveSubagents,
  prune,
  readLedger,
  upsertSubagent,
  writeLedger,
} from "./ledger.mjs";

// The pool's timing and lock vocabulary is shared with the installer and the
// status probe; re-exported because this module was its first home.
export {
  POOL_HEARTBEAT_MS,
  POOL_REATTACH_MAX_MS,
  POOL_STALE_MS,
  POOL_START_BUDGET_MS,
  POOL_VERDICTS,
  POOL_WEDGE_MARGIN_MS,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  killDeadlineMs,
  poolVerdict,
  sendDeadlineMs,
} from "../foundation/loop-state.mjs";
import {
  OPENER_TIMEOUT_MS,
  POOL_HEARTBEAT_MS,
  POOL_REATTACH_MAX_MS,
  POOL_STALE_MS,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
  STOP_DRAIN_MS,
  effectiveTurnTimeoutMs,
  poolVerdict,
} from "../foundation/loop-state.mjs";

/** Actor kinds whose adapter turns `role` into a real tool allowlist. */
const ROLE_ALLOWLIST_KINDS = new Set(["claude", "pi"]);

/**
 * How long a reaped orphan gets between SIGTERM and SIGKILL. A child that will
 * not stop within the grace is killed; the restart must not wait on it longer.
 */
export const REAP_GRACE_MS = 5_000;

/** Startup/shutdown budget for reconciling board session rows. */
export const RECONCILE_BOARD_BUDGET_MS = 10_000;

/** Questions answered in one project-session turn. */
const QUESTION_BATCH_MAX = 8;

/**
 * How long an unsettled question row waits before the director's retry turn.
 *
 * A turn that wrote a note but did not release the card must not be retried in
 * the same second (a tight LLM loop), and it must not wait for the next poll
 * (ten minutes, past the worker's hold). 30s fits inside the default 110s wait.
 */
const QUESTION_RETRY_BACKOFF_MS = 30_000;

/**
 * How often the loop pulses a claimed card while its turn is in flight. Below
 * the board's 10-minute fresh window (and the 30-minute stale window), so a long
 * turn is never mistaken for a stale claim. `opts.cardHeartbeatMs` is a test
 * seam, never a configuration key.
 */
export const CARD_HEARTBEAT_MS = 5 * 60_000;

/** A queue row on the question lane (everything else is a card handoff). */
const isQuestionRow = (row) => String(row?.queue_kind ?? "handoff") === "question";

/**
 * The session an event belongs to.
 *
 * Two lanes share a cwd, so a session id is the only unambiguous routing key.
 * `cwd` is a fallback for an event that carries no id, and only when exactly one
 * open session runs there — otherwise the event is dropped rather than guessed
 * onto the wrong lane.
 *
 * @param {Iterable<object>} entries open pool sessions (`{cwd, handle}`)
 * @param {{sessionId?: string, cwd?: string}} event
 * @returns {object|null}
 */
export function matchEventSession(entries, event) {
  const list = [...entries];
  if (event?.sessionId !== undefined) {
    return list.find((entry) => entry.handle?.sessionId === event.sessionId) ?? null;
  }
  if (event?.cwd !== undefined) {
    const matches = list.filter((entry) => entry.cwd === event.cwd);
    if (matches.length === 1) return matches[0];
  }
  return null;
}


function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/** @param {string} stateDir */
function sessionsFile(stateDir) {
  return join(stateDir, "sessions.state.json");
}

/** @param {string} stateDir */
function lockFile(stateDir) {
  return join(stateDir, SESSION_LOCK_FILE);
}

/** @param {string} stateDir */
function readSessionsState(stateDir) {
  const empty = { version: 3, projects: {} };
  const read = readJsonFile(sessionsFile(stateDir), empty);
  if (read.error !== null) return { value: { ...empty }, error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  return {
    // v1/v2 files are read for their `projects` map; the version is
    // informational, not a gate. v3 adds `worker:` records to `projects`. An old
    // `control` record is ignored: no control session exists any more.
    value: {
      version: 3,
      projects: value.projects && typeof value.projects === "object" ? value.projects : {},
    },
    error: null,
  };
}

/**
 * Is a resident pool running? The answer lives in `sessions.state.json`, so a
 * pass in another process (the supervisor's `passes.mjs poll`) asks the
 * same question the pool answers — no IPC, no network.
 *
 * Liveness is the shared pool verdict: a live pid whose start token still matches
 * is live, and the phase and timestamps decide which kind of live it is (`busy`,
 * `starting`, `unresponsive`, `wedged`); only a dead pid or a mismatched start
 * token is `gone`. A stale heartbeat makes a live pool `unresponsive`; it never
 * turns a live pid into an absent one.
 *
 * @param {{
 *   opts?: object,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 * }} [input]
 * @returns {{
 *   live: boolean,
 *   verdict: string|null,
 *   reason: string|null,
 *   file: string,
 *   poolPid: number|null,
 *   projects: Record<string, object>,
 *   workers: Record<string, object>,
 *   capabilities: string[],
 *   phase: string|null,
 *   heartbeatAgeMs?: number,
 *   tickAgeMs?: number,
 *   startAgeMs?: number,
 *   turnTimeoutMs?: number,
 * }}
 */
export function poolStatus(input = {}) {
  const opts = input.opts ?? {};
  const isAlive = input.isAlive ?? isProcessAlive;
  const now = input.now ?? Date.now;
  const stateDir = dirname(String(opts.state ?? join(process.cwd(), "supervisor.state.json")));
  const file = opts.sessionState ?? sessionsFile(stateDir);
  const empty = {
    live: false,
    verdict: null,
    reason: null,
    file,
    poolPid: null,
    projects: {},
    workers: {},
    capabilities: [],
  };

  // `--resident=no` is a deployment decision, not a liveness read.
  if (String(opts.resident ?? "auto").trim().toLowerCase() === "no") {
    return { ...empty, reason: "--resident=no" };
  }
  const read = readJsonFile(file, null);
  if (read.error !== null) return { ...empty, reason: read.error };
  const value = read.value;
  if (value === null || typeof value !== "object") return { ...empty, reason: "no session state" };
  const projects = value.projects && typeof value.projects === "object" ? value.projects : {};
  const workers = {};
  for (const [key, record] of Object.entries(projects)) {
    if (isWorkerKey(key)) workers[key] = record;
  }
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((entry) => typeof entry === "string")
    : [];
  const rawPid = Number(value.poolPid);
  const poolPid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  // One verdict, shared with `loop status` and the installer's pool report: the
  // pid and its start token decide "gone"; the phase and the timestamps decide
  // which kind of live this is. A stale heartbeat never turns a live pid into
  // an absent pool.
  const verdict = poolVerdict({
    poolPid,
    poolPidStart: value.poolPidStart ?? null,
    phase: value.phase,
    startStartedAt: value.startStartedAt ?? null,
    heartbeatAt: value.heartbeatAt ?? null,
    tickStartedAt: value.tickStartedAt ?? null,
    turnTimeoutMs:
      Number(opts.sessionTurnTimeoutMs) > 0
        ? Number(opts.sessionTurnTimeoutMs)
        : value.turnTimeoutMs,
    now,
    isAlive,
  });
  return {
    ...empty,
    live: verdict.live,
    verdict: verdict.verdict,
    reason: verdict.reason,
    poolPid: verdict.verdict === "gone" ? null : poolPid,
    projects,
    workers,
    capabilities,
    phase: verdict.phase,
    heartbeatAgeMs: verdict.heartbeatAgeMs,
    tickAgeMs: verdict.tickAgeMs,
    startAgeMs: verdict.startAgeMs,
    turnTimeoutMs: verdict.turnTimeoutMs,
  };
}

/**
 * Create the pool. The returned object is usable in-process, which is how the
 * tests drive it; `runSession` below is the long-running entry.
 *
 * @param {{
 *   opts: object,
 *   log?: (line: string) => void,
 *   kindPool?: object,
 *   kindPools?: Map<string, object>,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 * }} input
 */
export function createSessionPool(input = {}) {
  const opts = input.opts ?? {};
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;
  const isAlive = input.isAlive ?? isProcessAlive;
  // A retry must re-read the board: a worker can deliver (or a human can move
  // the card) while the turn that was about to be retried is still unwinding.
  const revalidateCard = typeof input.revalidateCard === "function" ? input.revalidateCard : null;
  // A director turn's exit code is not evidence: the card must be re-read to
  // prove it was released. Null in tests that do not inject a board.
  const questionOutcome =
    typeof input.readQuestionOutcome === "function" ? input.readQuestionOutcome : null;
  // A route row has the same "prove it" rule: the card must be assigned (or
  // have left `todo`), not merely have had a turn.
  const routeOutcome = typeof input.routeOutcome === "function" ? input.routeOutcome : null;
  // A triage row's producer is already `done`; its decision is the marker, and
  // a producer that moved on makes the row stale rather than unsettled.
  const triageOutcome = typeof input.triageOutcome === "function" ? input.triageOutcome : null;
  const stateDir = dirname(String(opts.state));
  const reapGraceMs = Number.isFinite(input.reapGraceMs) && input.reapGraceMs >= 0
    ? Number(input.reapGraceMs)
    : REAP_GRACE_MS;
  // `internal` is the installed supervisor; `external` marks a pool started by a
  // live session (`loop status --take-over`). It is an observational marker only:
  // it changes neither the pool's lifetime nor what the pool dispatches, and
  // there is no control turn in either mode — the supervisor's tick runs the
  // passes, the pool dispatches.
  const controlMode = opts.control === "external" ? "external" : "internal";
  const maxConcurrency = Number(opts.maxConcurrency ?? SESSION_DEFAULTS.maxConcurrency);
  const projectConcurrency = Number(opts.projectConcurrency ?? SESSION_DEFAULTS.projectConcurrency);
  const poolMax = Number(opts.sessionPoolMax ?? SESSION_DEFAULTS.poolMax);
  const projectIdleMs = Number(opts.projectIdleMs ?? SESSION_DEFAULTS.projectIdleMs);
  const sessionMaxAgeMs = Number(opts.sessionMaxAgeMs ?? SESSION_DEFAULTS.sessionMaxAgeMs);
  const turnTimeoutMs = Number(opts.sessionTurnTimeoutMs ?? SESSION_DEFAULTS.turnTimeoutMs);
  const pollMs = Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs);

  // One session's kind environment: the kind's own `bin/` leads PATH so its
  // `taskctl` shim (which bakes `--actor-kind`) is the one a tool call finds, and
  // TASKCTL_ACTOR_KIND is pinned so a supervisor's own env cannot leak into a
  // role running on another platform.
  const kindHome = typeof opts.home === "string" ? opts.home : homedir();
  const kindEnvironment = (kind) => {
    const bin = join(kindHome, agentPaths(kindHome, kind).agentDir, "bin");
    const separator = process.platform === "win32" ? ";" : ":";
    const PATH = [bin, process.env.PATH ?? ""].filter((part) => part !== "").join(separator);
    return { ...process.env, PATH, TASKCTL_ACTOR_KIND: kind };
  };

  const sessions = new Map();
  // The board-visible session row (one stable row per card and segment). The
  // writes are best-effort: a board that is down must never fail a turn.
  const boardSession = createBoardSession({ opts, log, isAlive });
  const stateRead = readSessionsState(stateDir);
  const state = stateRead.value;
  if (stateRead.error !== null) log(`session: ${stateRead.error} — starting from empty state`);
  let ledger = readLedger(stateDir).value;
  const kindPools = new Map();
  const injectedKindPool = input.kindPool ?? null;
  const injectedKindPools = input.kindPools instanceof Map ? input.kindPools : new Map();
  let started = false;
  // The liveness verdict's inputs. `phase` is the pool's own lifecycle;
  // `tickStartedAt` is set only while a dispatch tick is in flight, so a turn
  // that legitimately runs for an hour (plus its opener) is not read as wedged.
  // `startStartedAt`, `poolPidStart` and `previousPoolPid` are published before
  // `start()` so the startup window is visible to every reader.
  let phase = "starting";
  let tickStartedAt = null;
  let startStartedAt = null;
  let lastTickOkAt = null;
  let poolPidStart = null;
  let previousPoolPid = null;
  // The previous incarnation's own start token, beside its pid: a pid alone is
  // not identity, because the OS reuses pids.
  let previousPoolPidStart = null;
  let warnedReviewerAllowlist = false;

  /**
   * The pool for one actor kind. One process holds several: a role runs on the
   * kind that carries its skill. An injected pool (tests) serves every kind
   * unless the test injects one pool per kind.
   *
   * @param {string|null|undefined} actorKind
   */
  const getKindPool = (actorKind) => {
    if (injectedKindPool !== null) return injectedKindPool;
    const kind = typeof actorKind === "string" && actorKind !== "" ? actorKind : (opts.actorKind ?? "claude");
    if (injectedKindPools.has(kind)) return injectedKindPools.get(kind);
    if (!kindPools.has(kind)) {
      kindPools.set(kind, createKindPool({
        actorKind: kind,
        opts,
        log,
        onEvent: handleEvent,
        env: kindEnvironment(kind),
      }));
    }
    return kindPools.get(kind);
  };

  /**
   * The start token for a session's pid, or null when there is no pid (or the
   * platform cannot report one — pid-only liveness is then the rule). Cached on
   * the entry: a heartbeat every 15 s must not spawn `ps` for every session.
   *
   * @param {object} entry
   * @param {unknown} pid
   * @returns {string|null}
   */
  function startTokenFor(entry, pid) {
    if (!Number.isInteger(pid) || pid <= 1) return null;
    if (entry.pidStartPid === pid) return entry.pidStart ?? null;
    entry.pidStartPid = pid;
    entry.pidStart = processStartToken(pid);
    return entry.pidStart;
  }

  /**
   * Capture who we are before the first state write: the previous
   * incarnation's pid and child records (so the next start can reap its
   * children) and our own start token. The file is read once, before any state
   * write replaces it. Idempotent — announce and start both call it.
   */
  let capturedPrior = false;
  let previousProjects = null;
  function captureOwnership() {
    if (!capturedPrior) {
      capturedPrior = true;
      const prior = readJsonFile(sessionsFile(stateDir), null).value;
      previousProjects =
        prior && typeof prior === "object" && prior.projects && typeof prior.projects === "object"
          ? prior.projects
          : {};
      const priorPid = Number(prior?.poolPid);
      if (Number.isInteger(priorPid) && priorPid > 1 && priorPid !== process.pid) {
        previousPoolPid = priorPid;
        // A missing token (a state file written before `poolPidStart`) degrades
        // to pid-only liveness inside `pidMatches`, which is the old behaviour.
        previousPoolPidStart =
          typeof prior?.poolPidStart === "string" && prior.poolPidStart !== ""
            ? prior.poolPidStart
            : null;
      }
    }
    if (startStartedAt === null) startStartedAt = nowIso(now);
    if (poolPidStart === null) poolPidStart = processStartToken(process.pid);
  }

  /**
   * Kill the previous incarnation's still-live children before the reattach
   * pass resumes their conversations. A SIGKILLed pool leaves its agent
   * children running; resuming the same session id opens a second process for
   * the same conversation and working directory, and the card runs twice.
   *
   * Only a child whose recorded start token still matches is killed: a pid
   * alone is not identity, because the OS reuses pids. A record without a
   * token is left alone — a wrong kill is worse than a missed reap, and the
   * stale-claim recovery still protects the card.
   *
   * @returns {Promise<{reaped: number, killed: number}>}
   */
  async function reapPreviousChildren() {
    // start() holds the pool lock; a live previous manager means the file is
    // not ours to clean up (and its children are not orphans). The manager is
    // identified by pid AND start token: a reused pid is a different process,
    // so the incarnation that recorded the children is gone and they are
    // orphans. A missing token degrades to pid-only liveness.
    if (
      previousPoolPid !== null &&
      pidMatches(previousPoolPid, previousPoolPidStart, { isAlive })
    ) {
      return { reaped: 0, killed: 0 };
    }
    const victims = [];
    for (const record of Object.values(previousProjects ?? {})) {
      const pid = Number(record?.pid);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      const token =
        typeof record?.pidStart === "string" && record.pidStart !== "" ? record.pidStart : null;
      if (token === null) continue;
      if (!isAlive(pid)) continue;
      if (processStartToken(pid) !== token) continue;
      victims.push(pid);
    }
    if (victims.length === 0) return { reaped: 0, killed: 0 };
    for (const pid of victims) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    // Process timing is real even when the pool's state clock is injected.
    const deadline = Date.now() + reapGraceMs;
    const allGone = () => victims.every((pid) => !isAlive(pid));
    while (!allGone() && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const survivors = victims.filter((pid) => isAlive(pid));
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    log(
      `session: reaped ${victims.length} orphaned child process(es) from pool ${
        previousPoolPid ?? "unknown"
      }` + (survivors.length > 0 ? ` (${survivors.length} needed SIGKILL)` : ""),
      survivors.length > 0 ? { level: "warn" } : {},
    );
    return { reaped: victims.length, killed: survivors.length };
  }

  function workerPersistRecord(entry, previous = {}) {
    const worker = entry.worker ?? {};
    const pid = entry.handle?.pid ?? null;
    return {
      ...previous,
      kind: "worker-session",
      actorKind: entry.actorKind ?? opts.actorKind ?? "claude",
      // The card's lane. A card session is a worker or a reviewer; the status
      // probe splits its report on this field.
      role: entry.role === "reviewer" ? "reviewer" : "worker",
      cwd: entry.cwd,
      worktree: worker.worktree ?? entry.cwd,
      workspace_created_at: worker.workspace_created_at ?? previous.workspace_created_at ?? null,
      card: worker.card ?? previous.card ?? null,
      // The board UUID and the reviewed round let the startup reconciliation
      // build the natural key of the row it owns (`taskId|seg|owner`).
      taskId: worker.taskId ?? previous.taskId ?? null,
      reviewRound: worker.reviewRound ?? previous.reviewRound ?? null,
      round: worker.round ?? previous.round ?? 1,
      project: worker.project ?? previous.project ?? null,
      projectDir: worker.projectDir ?? previous.projectDir ?? null,
      agent: worker.agent ?? previous.agent ?? null,
      agentRole: worker.agentRole ?? previous.agentRole ?? null,
      queueId: worker.queueId ?? previous.queueId ?? null,
      sessionId: entry.handle?.sessionId ?? entry.sessionId ?? null,
      pid,
      pidStart: startTokenFor(entry, pid),
      generation: worker.generation ?? previous.generation ?? 1,
      status: entry.busy === true ? "running" : worker.status ?? previous.status ?? "idle",
      resumeState: worker.resumeState ?? previous.resumeState ?? "fresh",
      needsReplay: worker.needsReplay === true,
      worktree_gone: worker.worktree_gone === true,
      blocked: worker.blocked === true,
      transcriptPath: worker.transcriptPath ?? transcriptFile(stateDir, entry.key),
      lastBoardStatus: worker.lastBoardStatus ?? previous.lastBoardStatus ?? null,
      startedAt: entry.startedAt,
      lastHeartbeatAt: nowIso(now),
      lastUsedAt: entry.lastUsedAt,
      lastResumeAt: worker.lastResumeAt ?? previous.lastResumeAt ?? null,
      lastError: worker.lastError ?? null,
      openerFingerprint: entry.openerFingerprint ?? previous.openerFingerprint ?? null,
      closedAt: null,
    };
  }

  const persistState = () => {
    // A stopped pool that no longer holds the lock must not publish: an
    // abandoned in-flight tick resumes after shutdown, and its state write
    // would clobber a new pool's file.
    if (phase === "stopped" && lockToken === null) return false;
    const projects = { ...(state.projects ?? {}) };
    for (const [key, entry] of sessions) {
      if (isWorkerKey(key)) {
        projects[key] = workerPersistRecord(entry, projects[key]);
        continue;
      }
      const pid = entry.handle.pid ?? null;
      projects[key] = {
        actorKind: entry.actorKind ?? opts.actorKind ?? "claude",
        cwd: entry.cwd,
        sessionId: entry.handle.sessionId ?? entry.sessionId ?? null,
        pid,
        pidStart: startTokenFor(entry, pid),
        startedAt: entry.startedAt,
        lastHeartbeatAt: nowIso(now),
        lastUsedAt: entry.lastUsedAt,
        openerFingerprint: entry.openerFingerprint ?? null,
        closedAt: null,
      };
    }
    const next = {
      // 3 — worker sessions. The question lane is unchanged; a poll from this
      // release only enqueues question rows when the live pool advertises the
      // capability, and worker rows carry their own `worker:` session key.
      version: 3,
      capabilities: ["question-lane", "worker-sessions"],
      // The pool manager's own pid, not an agent child's: an orphaned agent process
      // would otherwise keep answering "resident" after its manager died. A
      // stopping pool publishes no pid, so the next start is not refused by a
      // process that is only waiting to exit.
      poolPid: phase === "stopped" ? null : process.pid,
      poolPidStart: phase === "stopped" ? null : poolPidStart,
      // The incarnation whose children the next start must reap before it
      // reattaches.
      previousPoolPid,
      phase,
      startStartedAt,
      tickStartedAt,
      lastTickOkAt,
      // The thresholds every reader derives its verdict from; the installer's
      // pool report has no opts, so the pool publishes the effective value.
      turnTimeoutMs,
      heartbeatAt: nowIso(now),
      // An observational marker only: it records who started the pool and changes
      // neither its lifetime nor its dispatch. It is not a session.
      controlMode,
      projects,
    };
    state.projects = projects;
    const written = writeJsonFile(sessionsFile(stateDir), next);
    if (!written.ok) log(`session: could not write state: ${written.error}`);
    return written.ok;
  };

  /** @param {string} key */
  function storedSession(key) {
    return state.projects?.[key] ?? null;
  }

  /**
   * Record that a session has loaded its skill. The opener is sent once per
   * fresh process; the fingerprint lets a later skill change reopen it.
   *
   * @param {object} entry
   * @param {string|null} fingerprint
   */
  function markOpener(entry, fingerprint) {
    entry.fresh = false;
    entry.openerFingerprint = fingerprint;
    const record = state.projects?.[entry.key];
    if (record !== undefined) record.openerFingerprint = fingerprint ?? null;
    persistState();
  }

  /**
   * Send the resident session's opener (`/<skill>` + Flags) when the session is
   * fresh or its installed skill changed. A resume with the same fingerprint
   * skips it: the skill is in the conversation history.
   *
   * A lane whose adapter loaded the skill at open (`opener` is null) sends no
   * message but still records the fingerprint, so the next tick does not mistake
   * the lane for one whose skill changed.
   *
   * @param {object} entry
   * @param {{command: string, flags: string, fingerprint: string|null}|null} opener
   * @param {string|null} [fingerprint] the skill fingerprint for an inline lane
   * @returns {Promise<{ok: boolean, sent: boolean, error?: string}>}
   */
  async function ensureOpener(entry, opener, fingerprint = null) {
    if (opener === null || typeof opener.command !== "string" || opener.command === "") {
      if (entry.fresh === true && typeof fingerprint === "string") {
        markOpener(entry, fingerprint);
      }
      return { ok: true, sent: false };
    }
    const needed =
      entry.fresh === true ||
      (typeof opener.fingerprint === "string" && entry.openerFingerprint !== opener.fingerprint);
    if (!needed) return { ok: true, sent: false };
    const text = `${opener.command}\nFlags: ${opener.flags}`;
    // Loading a skill is not a card turn: bound it separately, and never above
    // the turn itself.
    const outcome = await entry.handle.send(text, {
      timeoutMs: Math.min(turnTimeoutMs, OPENER_TIMEOUT_MS),
    });
    if (outcome?.ok !== true) {
      const error = String(outcome?.error ?? "unknown error");
      log(`session: ${entry.key} skill opener failed (${error}) — falling back to paths`);
      return { ok: false, sent: true, error };
    }
    markOpener(entry, opener.fingerprint ?? null);
    log(`session: ${entry.key} opened with ${opener.command}`);
    return { ok: true, sent: true };
  }

  /**
   * Open (or resume/replay) a card's own worker session.
   *
   * @param {string} key
   * @param {{cwd: string, role: string, skillPath?: string|null, systemPrompt?: string|null,
   *   worker?: {row?: object, workspace?: object|null, forceReplay?: boolean}}} options
   */
  function openWorkerSession(key, options) {
    const stored = storedSession(key);
    const worker = options.worker ?? {};
    const row = worker.row ?? null;
    const parsed = parseWorkerKey(key);
    const card = row?.card ?? parsed?.card ?? stored?.card ?? null;
    const round = roundOf(row ?? stored ?? {});
    const actorKind =
      (typeof row?.actor_kind === "string" && row.actor_kind !== "" ? row.actor_kind : null) ??
      (typeof stored?.actorKind === "string" ? stored.actorKind : null) ??
      opts.actorKind ??
      "claude";
    // A role migrated to another platform is a new generation: never resume a
    // native session id on a CLI that did not create it.
    const sameKind = typeof stored?.actorKind !== "string" || stored.actorKind === actorKind;
    let plan =
      worker.forceReplay === true
        ? {
            mode: "replay",
            generation: Number(stored?.generation ?? 1),
            reason: "native resume failed",
          }
        : !sameKind
          ? {
              mode: "fresh",
              generation: Number(stored?.generation ?? 1) + 1,
              reason: `role moved from ${stored?.actorKind} to ${actorKind}`,
            }
          : planWorkerOpen(stored, {
              targetDir: options.cwd,
              workspaceCreatedAt: worker.workspace?.created_at ?? null,
              now: now(),
              maxAgeMs: sessionMaxAgeMs,
            });
    // A rework whose live process is gone replays the previous round's bounded
    // transcript in a new native session; the full native history is never
    // loaded. A one-shot reset, or a previous record from another agent, actor
    // kind or worktree, falls back to the ordinary fresh path.
    let carry = null;
    const carryFromRound = Number(row?.carry_from_round);
    if (
      plan.mode === "fresh" &&
      row?.rework === true &&
      row?.force_fresh !== true &&
      card !== null &&
      Number.isInteger(carryFromRound) &&
      carryFromRound > 0
    ) {
      const sourceKey = workerKey(card, carryFromRound);
      const source = storedSession(sourceKey);
      const verdict = planWorkerCarry(source, {
        card,
        agent: row?.agent,
        actorKind,
        worktree: options.cwd,
        workspaceCreatedAt: worker.workspace?.created_at ?? null,
      });
      if (verdict.ok) {
        carry = { source, sourceKey, reason: verdict.reason };
        plan = {
          mode: "replay",
          generation: Number(source.generation ?? 1) + 1,
          reason: verdict.reason,
          transcriptReset: false,
        };
      } else if (source !== null) {
        log(`session: ${key} does not carry the previous round: ${verdict.reason}`);
      }
    }
    if (plan.mode === "blocked") {
      throw new Error(`worker session ${key} is blocked: ${plan.reason}`);
    }
    if (plan.mode === "fresh" && stored !== null && card !== null) {
      // A round bump starts a new generation; old records/transcripts retire.
      retireWorkerGenerations(stateDir, card, round);
    }
    if (plan.transcriptReset === true) {
      try {
        rmSync(transcriptFile(stateDir, key), { force: true });
      } catch {
        // A missing transcript is already the reset state.
      }
    }
    if (carry !== null) copyWorkerTranscript(stateDir, carry.sourceKey, key);
    const resumeId = plan.mode === "resume" ? plan.sessionId ?? null : null;
    const laneRole = options.role === "reviewer" ? "reviewer" : "worker";
    // A resumed native session already carries the system prompt from the turn
    // that opened it; only a fresh or replayed native session is injected.
    const systemPrompt = plan.mode === "resume" ? null : options.systemPrompt ?? null;
    const handle = getKindPool(actorKind).openSession({
      cwd: options.cwd,
      sessionId: resumeId,
      role: laneRole,
      skillPath: options.skillPath ?? null,
      systemPrompt,
    });
    const entry = {
      key,
      cwd: options.cwd,
      role: laneRole,
      actorKind,
      handle,
      sessionId: resumeId,
      startedAt: nowIso(now),
      lastUsedAt: nowIso(now),
      busy: false,
      fresh: plan.mode !== "resume",
      openerFingerprint:
        typeof stored?.openerFingerprint === "string"
          ? stored.openerFingerprint
          : typeof carry?.source?.openerFingerprint === "string"
            ? carry.source.openerFingerprint
            : null,
      worker: {
        ...(stored ?? {}),
        kind: "worker-session",
        role: laneRole,
        worktree: options.cwd,
        workspace_created_at:
          worker.workspace?.created_at ?? stored?.workspace_created_at ?? null,
        card,
        round,
        taskId: row?.task_id ?? stored?.taskId ?? null,
        reviewRound: row?.review_round ?? stored?.reviewRound ?? null,
        project: row?.project ?? stored?.project ?? null,
        projectDir: row?.project_dir ?? stored?.projectDir ?? null,
        agent: row?.agent ?? stored?.agent ?? null,
        agentRole: row?.agent_role ?? stored?.agentRole ?? null,
        queueId: row?.id ?? stored?.queueId ?? null,
        generation: plan.generation,
        planMode: plan.mode,
        reason: plan.reason,
        transcriptPath: transcriptFile(stateDir, key),
        status: "idle",
        resumeState:
          carry !== null
            ? "replayed_after_rework"
            : plan.mode === "replay"
              ? "resumed_by_replay"
              : "fresh",
        needsReplay: plan.mode === "replay",
        blocked: false,
        lastResumeAt: stored?.lastResumeAt ?? carry?.source?.lastResumeAt ?? null,
        lastError: stored?.lastError ?? null,
        lastBoardStatus: stored?.lastBoardStatus ?? null,
      },
    };
    sessions.set(key, entry);
    persistState();
    if (carry !== null || (row?.force_fresh === true && card !== null)) {
      // The source round is consumed: one record per card, current round only.
      // This mutates the in-memory map so the next persist cannot restore it.
      dropOlderWorkerRecords(stateDir, state.projects, card, round);
      persistState();
    }
    log(
      `session: opened worker ${key} (cwd=${options.cwd}, ` +
        `${plan.mode === "resume" ? `resume=${resumeId}` : plan.mode === "replay" ? `replay=${plan.reason}` : "fresh"})`,
    );
    return entry;
  }

  /**
   * @param {string} key
   * @param {{cwd: string, role: string, sessionId?: string|null, worker?: object}} options
   */
  function openSession(key, options) {
    const open = sessions.get(key);
    if (open !== undefined) {
      // The session is already open: a second handoff for the same card is a
      // resume turn, not a fresh briefing. The live id comes from the adapter
      // once it has spoken; before that the first turn is still in flight.
      if (isWorkerKey(key) && open.worker !== undefined && open.worker.planMode !== "replay") {
        const liveId = open.handle?.sessionId ?? open.sessionId ?? null;
        if (liveId !== null && liveId !== undefined && liveId !== "") {
          open.worker.planMode = "resume";
          open.worker.reason = "same-round re-dispatch";
        }
      }
      return open;
    }
    if (isWorkerKey(key)) return openWorkerSession(key, options);
    const stored = storedSession(key);
    const storedKind = typeof stored?.actorKind === "string" ? stored.actorKind : null;
    const actorKind =
      (typeof options.actorKind === "string" && options.actorKind !== "" ? options.actorKind : null) ??
      storedKind ??
      opts.actorKind ??
      "claude";
    // A role migrated between platforms starts a new conversation: the old
    // kind's native session id is meaningless, and possibly a different CLI.
    const sameKind = storedKind === null || storedKind === actorKind;
    if (!sameKind) {
      log(`session: ${key} role moved from ${storedKind} to ${actorKind} — starting a fresh conversation`);
    }
    const storedAge =
      !sameKind || stored?.startedAt === undefined
        ? Number.POSITIVE_INFINITY
        : now() - Date.parse(String(stored.startedAt));
    const resumeId =
      options.sessionId !== undefined && options.sessionId !== null && sameKind
        ? options.sessionId
        : storedAge < sessionMaxAgeMs
          ? stored?.sessionId ?? null
          : null;
    const handle = getKindPool(actorKind).openSession({
      cwd: options.cwd,
      sessionId: resumeId,
      role: options.role,
      skillPath: options.skillPath ?? null,
    });
    const entry = {
      key,
      cwd: options.cwd,
      role: options.role,
      actorKind,
      handle,
      sessionId: resumeId,
      startedAt: nowIso(now),
      lastUsedAt: nowIso(now),
      busy: false,
      fresh: resumeId === null,
      openerFingerprint:
        typeof stored?.openerFingerprint === "string" ? stored.openerFingerprint : null,
    };
    sessions.set(key, entry);
    if (
      (options.sessionId === undefined && storedAge >= sessionMaxAgeMs && stored !== null) ||
      !sameKind
    ) {
      // A fresh conversation supersedes the expired (or foreign-kind) handle.
      delete state.projects[key];
    }
    persistState();
    log(
      `session: opened ${key} (cwd=${options.cwd}` +
        `${resumeId === null ? ", fresh" : `, resume=${resumeId}`})`,
    );
    return entry;
  }

  /** @param {string} key @param {{cwd: string, role: string, actorKind?: string|null}} options */
  async function ensureSession(key, options) {
    const requested =
      typeof options.actorKind === "string" && options.actorKind !== "" ? options.actorKind : null;
    let entry = sessions.get(key) ?? null;
    // A role moved between platforms while its session was open: the open
    // conversation belongs to the old CLI, so it is closed and never reused.
    if (entry !== null && requested !== null && entry.actorKind !== undefined && entry.actorKind !== requested) {
      log(`session: ${key} moved from ${entry.actorKind} to ${requested} — starting a fresh conversation`);
      await closeEntry(entry, { dropSession: true });
      entry = null;
    }
    entry = entry ?? openSession(key, options);
    if (entry.handle.closed === true) {
      sessions.delete(key);
      return openSession(key, options);
    }
    return entry;
  }

  /** @param {object} event */
  function handleEvent(event) {
    const eventSession = matchEventSession(sessions.values(), event);
    if (eventSession !== null) {
      eventSession.lastUsedAt = nowIso(now);
      if (event.type === "init" && typeof event.sessionId === "string") {
        eventSession.sessionId = event.sessionId;
        persistState();
      }
      if (event.type === "subagent" && typeof event.subagentId === "string") {
        // A card session owns its whole card; it spawns nothing. A subagent
        // event is legacy state from the old reviewer lane, worth a line only.
        log(
          `session: ${eventSession.key} reported a subagent ${event.subagentId} — no card session spawns one`,
        );
      }
    }
    if (event.type === "assistant" && typeof event.text === "string" && event.text !== "") {
      log(`session: ${eventSession?.key ?? event.sessionId ?? "?"} assistant: ${event.text.slice(0, 200)}`);
    }
  }

  function writeLedgerState() {
    const written = writeLedger(stateDir, ledger);
    if (!written.ok) log(`session: could not write ledger: ${written.error}`);
  }

  /**
   * Close the card's older generations. A rework keeps the records: the pool
   * still needs the previous round's transcript to replay when the live process
   * is gone, and the identity fields are what a carry validates.
   */
  async function closeOlderWorkerGenerations(card, round, { keepRecords = false } = {}) {
    for (const entry of [...sessions.values()]) {
      if (!isWorkerKey(entry.key)) continue;
      const parsed = parseWorkerKey(entry.key);
      if (parsed === null || parsed.card !== card || parsed.round >= round) continue;
      await closeEntry(entry, { dropSession: !keepRecords });
    }
  }

  /**
   * Move a live worker entry from the rejected round's key to this round's,
   * in place: no spawn, no re-brief. The native conversation and the worktree
   * are already the right ones, so only the pool's identity changes.
   *
   * @param {object} entry @param {object} row
   * @param {{cwd: string, workspaceCreatedAt?: string|null}} options
   * @returns {{ok: true, key: string} | {ok: false, deferred?: boolean, reason: string}}
   */
  function rekeyWorkerEntry(entry, row, options = {}) {
    const newKey = workerKey(row.card, roundOf(row));
    if (newKey === entry.key) return { ok: false, reason: "already the current round" };
    if (entry.role === "reviewer") return { ok: false, reason: "a review is not a rework" };
    if (entry.busy === true) return { ok: false, deferred: true, reason: "the session is still running" };
    if (entry.handle?.closed === true) return { ok: false, reason: "the native session is closed" };
    const stored = state.projects?.[entry.key] ?? {};
    const verdict = planWorkerCarry(
      {
        card: entry.worker?.card ?? stored.card,
        agent: entry.worker?.agent ?? stored.agent,
        actorKind: entry.actorKind ?? stored.actorKind,
        worktree: entry.worker?.worktree ?? entry.cwd,
        workspace_created_at:
          entry.worker?.workspace_created_at ?? stored.workspace_created_at ?? null,
        blocked: entry.worker?.blocked === true || stored.blocked === true,
        worktree_gone: entry.worker?.worktree_gone === true || stored.worktree_gone === true,
      },
      {
        card: row.card,
        agent: row.agent,
        actorKind: row.actor_kind ?? entry.actorKind,
        worktree: options.cwd,
        workspaceCreatedAt: options.workspaceCreatedAt ?? null,
      },
    );
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const oldKey = entry.key;
    sessions.delete(oldKey);
    entry.key = newKey;
    entry.worker.card = row.card;
    entry.worker.round = roundOf(row);
    entry.worker.queueId = row.id ?? entry.worker.queueId;
    entry.worker.project = row.project ?? entry.worker.project;
    entry.worker.projectDir = row.project_dir ?? entry.worker.projectDir;
    entry.worker.agentRole = row.agent_role ?? entry.worker.agentRole;
    entry.worker.agent = row.agent ?? entry.worker.agent;
    entry.worker.generation = Number(entry.worker.generation ?? 1) + 1;
    entry.worker.planMode = "resume";
    entry.worker.resumeState = "rekeyed_rework";
    entry.worker.reason = verdict.reason;
    entry.worker.status = "idle";
    entry.worker.transcriptPath = transcriptFile(stateDir, newKey);
    entry.worker.lastResumeAt = nowIso(now);
    entry.worker.lastUsedAt = nowIso(now);
    // A running session's max-age clock is per generation: leaving the old
    // start would let `evictIdle` retire a conversation that just continued.
    entry.startedAt = nowIso(now);
    entry.lastUsedAt = nowIso(now);
    entry.fresh = false;
    // Rewrite the pool's own keying and leave no earlier-round record.
    moveWorkerTranscript(stateDir, oldKey, newKey);
    sessions.set(newKey, entry);
    delete state.projects[oldKey];
    dropOlderWorkerRecords(stateDir, state.projects, row.card, roundOf(row));
    persistState();
    log(`session: rekeyed ${oldKey} → ${newKey} — same conversation and workspace`);
    return { ok: true, key: newKey };
  }

  async function closeEntry(entry, { dropSession = false, boardStatus = "closed" } = {}) {
    closeBoardSession(entry, boardStatus);
    try {
      await entry.handle.close();
    } catch (err) {
      log(`session: close ${entry.key} failed: ${err.message}`);
    }
    sessions.delete(entry.key);
    if (dropSession) {
      delete state.projects[entry.key];
    } else if (state.projects?.[entry.key] !== undefined) {
      state.projects[entry.key] = {
        ...state.projects[entry.key],
        sessionId: entry.handle.sessionId ?? entry.sessionId ?? null,
        pid: null,
        closedAt: nowIso(now),
        // A closed conversation is not running. Without this a mid-turn snapshot
        // (`status:"running"`) keeps the card out of the stale re-claim.
        ...(isWorkerKey(entry.key) ? { status: "idle" } : {}),
      };
    }
    persistState();
  }

  /**
   * A card session's stable board segment: one row per card per lane, across
   * rounds. The reviewer's row names the round it audits, not the review card's
   * own delivery round.
   */
  function boardSegmentOf(entry) {
    return entry.role === "reviewer" ? "reviewer" : "worker";
  }

  /**
   * Register the board-visible row for the turn that is about to run. Best
   * effort by construction: a missing agent or a down board only logs.
   */
  function registerBoardSession(entry, row) {
    if (opts.dryRun === true) return;
    if (entry.boardSession?.status === "running") return;
    const owner = String(entry.worker?.agent ?? "").trim();
    if (owner === "") {
      log(`session: ${entry.key} has no agent — no board session row is written`, { level: "warn" });
      return;
    }
    const seg = boardSegmentOf(entry);
    const round =
      entry.role === "reviewer"
        ? Number(entry.worker?.reviewRound ?? row?.review_round ?? roundOf(row))
        : roundOf(row);
    const registered = boardSession.register({
      card: row?.card ?? entry.worker?.card ?? null,
      seg,
      owner,
      ownerKind: entry.actorKind,
      phase: seg,
      pid: entry.handle?.pid ?? null,
      round,
      generation: entry.worker?.generation ?? 1,
      planMode: entry.worker?.planMode ?? "fresh",
      carry: entry.worker?.resumeState ?? null,
    });
    if (registered.ok === true) {
      entry.boardSession = { seg, status: "running" };
    }
  }

  /** Close the row once per turn; every terminal branch may call this. */
  function closeBoardSession(entry, status = "closed") {
    if (entry?.boardSession?.status !== "running") return;
    entry.boardSession.status = "closing";
    boardSession.close({
      card: entry.worker?.card ?? null,
      seg: entry.boardSession.seg,
      owner: entry.worker?.agent ?? null,
      failed: status === "failed",
    });
    entry.boardSession.status = "closed";
  }

  /**
   * Close board rows this pool did not live to close. The natural key is
   * `taskId|seg|owner`; a row whose pid is still alive belongs to a live
   * conversation and is never closed from here.
   */
  async function reconcileBoardSessions(deadline) {
    const liveKeys = new Set();
    for (const entry of sessions.values()) {
      const taskId = entry.worker?.taskId;
      const owner = entry.worker?.agent;
      if (typeof taskId !== "string" || taskId === "" || typeof owner !== "string" || owner === "") continue;
      liveKeys.add(`${taskId}|${boardSegmentOf(entry)}|${owner}`);
    }
    return boardSession.reconcile({ loopId: boardSession.loopId, liveKeys, deadline });
  }

  /**
   * Answer the question lane: one project-session turn per directory.
   *
   * Questions ride the worker lane's conversation — it owns the card context,
   * and the answer is a board write done as the card's agent. No subagent is
   * spawned, no ledger row is written, and the subagent budget is untouched.
   */
  async function routeQuestions(rows) {
    const groups = new Map();
    for (const row of rows) {
      const dir = String(row.target_dir ?? "");
      if (dir === "" || !dir.startsWith("/") || !existsSync(dir)) {
        completeCards(stateDir, [row.id], { status: "failed", error: "target_dir missing or not absolute" });
        log(`session: question ${row.card} has no usable target_dir (${JSON.stringify(row.target_dir)}) — failed`);
        continue;
      }
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(row);
    }
    let answered = 0;
    // The in-flight card sessions, counted from the queue: a processing row is
    // the slot. The question rows themselves are not card work.
    const processingByProject = new Map();
    for (const row of readCards(stateDir).value.cards) {
      if (row.status !== "processing" || isQuestionRow(row)) continue;
      const key = String(row.project ?? row.project_dir ?? row.target_dir ?? "");
      processingByProject.set(key, (processingByProject.get(key) ?? 0) + 1);
    }
    for (const [dir, cards] of groups) {
      // The director lane draws no worker budget, but it is still bounded by the
      // project's concurrency cap: one decision conversation per project must not
      // pile on a project whose workers are already at the limit.
      const project = String(cards[0]?.project ?? cards[0]?.project_dir ?? dir);
      const projectLive = processingByProject.get(project) ?? 0;
      if (projectConcurrency > 0 && projectLive >= projectConcurrency) {
        log(`session: ${project} is at its project cap — leaving ${cards.length} decision row(s) pending`);
        continue;
      }
      // The director lane draws no worker slot, but it is still a session: the
      // pool's global bound applies before a new project lane is opened. Only
      // non-worker conversations hold lane slots — worker sessions are bounded
      // by `--max-concurrency` through their processing rows, and counting them
      // here would let card work starve the director lane. Recomputed per group
      // so a lane opened earlier in this loop fills the pool for the next one.
      const laneSessions = [...sessions.keys()].filter((key) => !isWorkerKey(key)).length;
      if (!sessions.has(dir) && poolMax > 0 && laneSessions >= poolMax) {
        log(`session: lane session pool is full (${poolMax}) — leaving ${cards.length} decision row(s) pending`);
        continue;
      }
      // The director skill is part of the lane's opening state, so it is
      // resolved before the lane opens: an inline adapter takes it at open.
      const roleSet = loadRoles({
        home: opts.home,
        primaryKind: opts.actorKind,
        kindOrder: opts.kindOrder,
        explicitDir: opts.rolesDir ?? null,
      });
      // Installation location is the routing for the director too: the skill may sit on
      // another kind (a codex-only install, or a copy that was not migrated). Use the
      // kind that actually carries it, so the lane opens with that CLI.
      const directorKind = String(
        roleSet?.decisionPolicy?.kind ?? opts.actorKind ?? roleSet?.primaryKind ?? "claude",
      );
      const directorSkillDir = roleSet?.decisionPolicy?.skillDir ?? null;
      const directorFingerprint = skillFingerprint(directorSkillDir);
      const directorMode = skillLoadMode(directorKind);
      const directorSkillPath =
        directorMode === "inline" &&
        typeof directorSkillDir === "string" &&
        existsSync(join(directorSkillDir, "SKILL.md"))
          ? join(directorSkillDir, "SKILL.md")
          : null;
      const opener =
        directorMode === "opener"
          ? {
              command: "/meerkat-director",
              flags: `--agent ${DIRECTOR_ACTOR_ID} --actor-kind=${directorKind}`,
              fingerprint: directorFingerprint,
            }
          : null;
      let entry = await ensureSession(dir, {
        cwd: dir,
        role: "director",
        actorKind: directorKind,
        skillPath: directorSkillPath,
      });
      if (entry.busy === true) {
        log(`session: ${dir} is busy — leaving ${cards.length} decision row(s) pending`);
        continue;
      }
      const claimed = claimCards(stateDir, {
        claimedBy: dir,
        pid: process.pid,
        limit: Math.min(QUESTION_BATCH_MAX, cards.length),
        ids: cards.map((row) => row.id),
        queueKind: "question",
        now: nowIso(now),
      });
      if (!claimed.ok || claimed.cards.length === 0) {
        if (!claimed.ok) log(`session: question claim failed: ${claimed.error}`);
        continue;
      }
      if (
        entry.fresh !== true &&
        typeof directorFingerprint === "string" &&
        entry.openerFingerprint !== directorFingerprint
      ) {
        await closeEntry(entry, { dropSession: true });
        entry = await ensureSession(dir, {
          cwd: dir,
          role: "director",
          actorKind: directorKind,
          skillPath: directorSkillPath,
        });
      }
      entry.busy = true;
      let outcome;
      try {
        const opened = await ensureOpener(entry, opener, directorFingerprint);
        // Only a skill that actually resolved makes the per-turn path
        // redundant; a missing or failed install keeps the old fallback.
        const charterLoaded =
          opened.ok === true &&
          (directorMode === "inline"
            ? directorSkillPath !== null
            : typeof directorFingerprint === "string");
        outcome = await entry.handle.send(
          buildQuestionPrompt(claimed.cards, {
            // The lane runs on the kind that carries the director skill, which
            // may not be the supervisor's primary kind: name the one that writes.
            actorKind: directorKind,
            decisionPolicyPath: charterLoaded
              ? null
              : (roleSet?.decisionPolicy?.path ?? null),
            routing: roleSet?.routing?.text ?? null,
          }),
          { timeoutMs: turnTimeoutMs },
        );
      } finally {
        entry.busy = false;
        entry.lastUsedAt = nowIso(now);
      }
      if (outcome?.ok === true) {
        // The turn exited 0; that is not proof it settled the board. Verify each
        // question row against the live card. A note-only turn leaves the card
        // in_progress and is requeued for one backoff retry (the row-level cap
        // still bounds it); a failed read is fail-soft — completing the row lets
        // the next poll re-enqueue it if the question is still open.
        const settled = [];
        const unsettled = [];
        for (const row of claimed.cards) {
          if (row.triage === true) {
            // The producer is `done`: a question-style outcome would settle on
            // "not in_progress" before the director did anything. The marker is
            // the only proof, and a stale producer needs no decision at all.
            if (triageOutcome === null) {
              settled.push(row);
              continue;
            }
            const live = await triageOutcome({
              card: row.card,
              round: row.round ?? row.delivery_round,
              row,
            });
            if (live?.ok === true && live.settled !== true && live.stale !== true) {
              unsettled.push(row);
            } else {
              settled.push(row);
            }
            continue;
          }
          if (row.route === true) {
            // A route turn is settled only when the board shows an assignee (or
            // the card left `todo`). A turn that exits 0 without assigning is
            // retried, and the exhaustion path parks the card for a human.
            if (routeOutcome === null) {
              settled.push(row);
              continue;
            }
            const live = await routeOutcome({ card: row.card, row });
            if (live?.ok === true && live.settled !== true) unsettled.push(row);
            else settled.push(row);
            continue;
          }
          if (questionOutcome === null) {
            settled.push(row);
            continue;
          }
          const live = await questionOutcome({ card: row.card, questionId: row.question_id, row });
          if (live?.ok === true && live.settled !== true) unsettled.push(row);
          else settled.push(row);
        }
        if (settled.length > 0) completeCards(stateDir, settled.map((card) => card.id));
        if (unsettled.length > 0) {
          // Retry the same row after a short backoff instead of failing it and
          // waiting for the next poll: the director's first turn may have written
          // the answer and only missed the release, and the worker is holding for
          // one bounded wait. The attempt budget is two turns per question.
          const retried = requeueCards(stateDir, unsettled.map((card) => card.id), {
            maxAttempts: 2,
            error: "director turn did not settle the question",
            retryAt: new Date(now() + QUESTION_RETRY_BACKOFF_MS).toISOString(),
          });
          // The bound is the end of the automatic path. Parking the card is
          // what stops a permanently unowned card from being re-offered every
          // pass with nobody to act on it.
          for (const row of unsettled) {
            if (!(retried.failedIds ?? []).includes(String(row.id))) continue;
            if (row.triage === true) {
              // The producer is terminal: parkCard would try a move the state
              // machine refuses (and write a `question` nobody can answer).
              // Record the failed decision on the card and leave it `done`.
              noteTriageFailed(
                row.card,
                "the director did not consume the required handoff",
              );
              continue;
            }
            parkCard(
              row.card,
              row.route === true
                ? "the director never assigned this unowned card (routing-table gap)"
                : "the director never settled the question",
              "decision",
            );
          }
          log(
            `session: director did not settle ${unsettled.map((card) => card.card).join(", ")} — ` +
              (retried.failed > 0 ? "row failed after 2 attempts" : "retry scheduled"),
          );
        }
        answered += settled.length;
        continue;
      }
      // A persistent spawn/turn failure must not spin: the question interval
      // runs every second, so the row waits out the same backoff as an unsettled
      // turn, with the same two-turn budget.
      requeueCards(stateDir, claimed.cards.map((card) => card.id), {
        maxAttempts: 2,
        error: outcome?.error ?? "question turn failed",
        retryAt: new Date(now() + QUESTION_RETRY_BACKOFF_MS).toISOString(),
      });
      log(`session: question turn for ${dir} failed: ${outcome?.error ?? "unknown error"} — retry scheduled`);
      if (/closed|exited|spawn error|timed out/.test(String(outcome?.error ?? ""))) {
        await closeEntry(entry, { dropSession: false });
      }
    }
    return answered;
  }

  /**
   * Route pending question rows only.
   *
   * This runs on its own interval, not inside the dispatch tick: the tick awaits
   * every worker turn, and a worker holding in `issue wait` must not keep the
   * director lane from being routed until that turn ends. It reads the queue and
   * drives the director lane; it never claims a card and never moves one.
   */
  async function routeQuestionsNow() {
    const read = readCards(stateDir);
    if (read.error !== null) {
      log(`session: card queue unreadable: ${read.error}`);
      return 0;
    }
    const due = read.value.cards.filter((row) => {
      if (row.status !== "pending" || !isQuestionRow(row)) return false;
      const retryAt = Date.parse(String(row.retry_at ?? ""));
      return Number.isNaN(retryAt) || retryAt <= now();
    });
    if (due.length === 0) return 0;
    return routeQuestions(due);
  }

  /**
   * Route pending card handoffs to their lane sessions.
   */
  async function routeCards() {
    const workerRecords = readWorkerSessions(stateDir).workers;
    const recovered = recoverStaleCards(stateDir, {
      isAlive,
      now: now(),
      maxAgeMs: 2 * turnTimeoutMs,
      // A live orphan's claim is re-pointed at this pool, not at a dead pid.
      poolPid: process.pid,
      // A worker with a durable record is recovered by `recoverWorkerSessions`
      // and resumed; requeueing it here would put a second worker on the card.
      isResumableWorker: (row) =>
        typeof row?.worker_key === "string" &&
        row.worker_key !== "" &&
        workerRecords[row.worker_key] !== undefined &&
        workerRecords[row.worker_key].blocked !== true,
    });
    // A silent requeue hides a dead worker; one line, only when something moved.
    if (recovered.recovered > 0) {
      log(`session: recovered ${recovered.recovered} stale claim(s)`, { level: "debug" });
    }
    if (recovered.reowned > 0) {
      log(`session: re-owned ${recovered.reowned} live orphan claim(s)`, { level: "debug" });
    }
    // The queue is a work list, not a log: a terminal row is dropped after its
    // retention, and the board's card remains the durable record.
    pruneCards(stateDir, { now: now() });
    retireLegacyDispatched(stateDir);
    let read = readCards(stateDir);
    if (read.error !== null) {
      log(`session: card queue unreadable: ${read.error}`);
      return { ok: false, error: read.error, dispatched: 0 };
    }
    const pending = read.value.cards.filter((card) => card.status === "pending");
    if (pending.length === 0) {
      return { ok: true, dispatched: 0 };
    }
    // Question rows are routed by their own interval (routeQuestionsNow). Here
    // they only gate handoffs for the same worker card: a worker whose question
    // is still unsettled must not be re-prompted by a second handoff. A review
    // card never asks, so it is never gated on one.
    // A timed-out row waits out its backoff. Question rows are never filtered:
    // an unsettled question must keep blocking its card's handoff.
    const due = (row) => {
      const at = Date.parse(String(row.retry_at ?? ""));
      return Number.isNaN(at) || at <= now();
    };
    const questionRows = pending.filter(isQuestionRow);
    const handoffRows = pending.filter((row) => !isQuestionRow(row) && due(row));
    if (handoffRows.length === 0) {
      return { ok: true, dispatched: 0 };
    }
    const questionCards = new Set(questionRows.map((row) => String(row.card ?? "")));
    const groups = new Map();
    for (const card of handoffRows) {
      const dir = String(card.target_dir ?? "");
      if (dir === "" || !dir.startsWith("/") || !existsSync(dir)) {
        completeCards(stateDir, [card.id], { status: "failed", error: "target_dir missing or not absolute" });
        log(`session: card ${card.card} has no usable target_dir (${JSON.stringify(card.target_dir)}) — failed`);
        continue;
      }
      // Every card — review or worker — is its own top-level session, keyed by
      // card + round; the role skill loads when it opens. While a worker's
      // question row is open, the director lane owns the card; the handoff
      // waits one tick rather than racing a second writer.
      const review = String(card.role ?? "worker") === "reviewer";
      if (!review && questionCards.has(String(card.card ?? ""))) {
        log(`session: worker ${card.card} has an open question — leaving its handoff pending`);
        continue;
      }
      const key = typeof card.worker_key === "string" && card.worker_key !== ""
        ? card.worker_key
        : workerKey(card.card, roundOf(card));
      groups.set(key, {
        key,
        dir,
        lane: review ? "reviewer" : "worker-session",
        cards: [card],
      });
    }
    let dispatched = 0;
    /**
     * Drop retried rows whose card already left the work state. Returns the
     * rows still worth dispatching and how many slots to give back.
     */
    const revalidateBatch = async (cards) => {
      if (revalidateCard === null) return { batch: cards, dropped: 0 };
      const kept = [];
      let dropped = 0;
      for (const card of cards) {
        // A first dispatch needs no re-check; a retry of either kind does.
        if (Number(card.attempts ?? 0) === 0 && Number(card.timeouts ?? 0) === 0) {
          kept.push(card);
          continue;
        }
        const live = await revalidateCard({ card: card.card, row: card });
        if (live?.ok === false) {
          requeueCards(stateDir, [card.id], {
            error: `redispatch check failed: ${live.error ?? "unknown"}`,
          });
          dropped += 1;
          log(`session: ${card.card} redispatch check failed — requeued`);
          continue;
        }
        if (live?.status !== "todo" && live?.status !== "in_progress") {
          completeCards(stateDir, [card.id], {
            status: "done",
            error: `not re-dispatched: card is ${live?.status ?? "unknown"}`,
          });
          dropped += 1;
          log(
            `session: ${card.card} is ${live?.status ?? "unknown"} — ` +
              "handoff completed without a re-dispatch",
          );
          continue;
        }
        kept.push(card);
      }
      return { batch: kept, dropped };
    };
    // The global cap is per tick, not per directory: planning is sequential and
    // the budget is fixed before any turn starts. A card session holds its slot
    // through its queue row — every turn is one card, so the processing rows
    // are the live sessions. `claimedByProject` keeps `--project-concurrency`
    // honest across a project's worktrees, whose turns overlap.
    const processingRows = read.value.cards.filter(
      (row) => row.status === "processing" && !isQuestionRow(row),
    ).length;
    let globalBudget = Math.max(0, maxConcurrency - processingRows);
    const claimedByProject = new Map();
    const jobs = [];
    for (const { key, dir, lane, cards } of groups.values()) {
      if (globalBudget === 0) {
        log(`session: global concurrency cap reached (${maxConcurrency}) — leaving ${cards.length} card(s) pending`);
        break;
      }
      // A session that is still in a turn — including a worker holding on
      // `issue wait` — must not receive a second prompt. The queue row waits;
      // the director's release may have re-claimed the card in the meantime,
      // and `revalidateBatch` drops the row if the worker already moved it.
      {
        const existing = sessions.get(key);
        // `busy` is the in-process truth; the persisted status can lag a failed
        // turn and must not be used as a lock.
        if (existing?.busy === true) {
          log(`session: card ${cards[0].card} is still running — leaving its handoff pending`);
          continue;
        }
      }
      // A rework continues the rejected round's live conversation in place: the
      // key moves to this round, nothing is spawned and the opener is skipped.
      // A busy entry is deferred untouched — a rekey must never interrupt an
      // in-flight turn, and `closeOlderWorkerGenerations` must not close it.
      if (lane !== "reviewer" && cards[0].rework === true && cards[0].force_fresh !== true) {
        const carryFrom = Number(cards[0].carry_from_round);
        const previous =
          Number.isInteger(carryFrom) && carryFrom > 0
            ? [...sessions.values()].find((candidate) => {
                const parsedPrevious = parseWorkerKey(candidate.key);
                return parsedPrevious?.card === cards[0].card && parsedPrevious.round === carryFrom;
              })
            : undefined;
        if (previous !== undefined) {
          const rekeyed = rekeyWorkerEntry(previous, cards[0], {
            cwd: dir,
            workspaceCreatedAt: cards[0].workspace?.created_at ?? null,
          });
          if (rekeyed.deferred === true) {
            log(`session: rework ${cards[0].card} is still running — deferring the rekey`);
            continue;
          }
          if (
            rekeyed.ok !== true &&
            !/native session is closed|current round/.test(rekeyed.reason)
          ) {
            log(`session: rework ${cards[0].card} does not rekey: ${rekeyed.reason}`);
          }
        }
      }
      if (!sessions.has(key)) {
        const openCards = [...sessions.values()].filter((session) => isWorkerKey(session.key));
        if (openCards.length >= maxConcurrency) {
          const victim = openCards
            .filter((session) => session.busy !== true && session.worker?.status !== "running")
            .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))[0];
          if (victim === undefined) {
            log(`session: card session cap reached (${maxConcurrency}) — leaving ${cards[0].card} pending`);
            continue;
          }
          await closeEntry(victim, { dropSession: false });
        }
      }
      if (lane === "reviewer" && !ROLE_ALLOWLIST_KINDS.has(String(opts.actorKind ?? "")) && !warnedReviewerAllowlist) {
        warnedReviewerAllowlist = true;
        log(
          `session: ${opts.actorKind} has no per-role tool allowlist — ` +
            "the reviewer boundary is prompt-only for this actor kind",
        );
      }
      {
        const parsed = parseWorkerKey(key);
        if (parsed !== null) {
          // A rework keeps the older record even when its live entry closes:
          // the record is the bounded replay source for the new session.
          await closeOlderWorkerGenerations(parsed.card, parsed.round, {
            keepRecords: cards[0].rework === true && cards[0].force_fresh !== true,
          });
        }
        // A parked session must become runnable again once a human has cleared
        // the hold. Without this the stored `blocked` flag outlives the board
        // state and every dispatch throws for ever.
        const stored = state.projects?.[key];
        if (stored?.blocked === true && revalidateCard !== null) {
          const live = await revalidateCard({ card: cards[0].card, row: cards[0] });
          if (live?.ok === true && (live.status === "todo" || live.status === "in_progress")) {
            delete state.projects[key];
            persistState();
            log(
              `session: card ${cards[0].card} was parked; the board cleared the hold — opening a fresh session`,
            );
          }
        }
      }
      // The role skill is part of the session's opening state, so the role is
      // selected before the session is opened: an inline host
      // (`developerInstructions`, `--append-system-prompt`) can only take the
      // skill at open time, not in a later message.
      const roleSet = loadRoles({
        home: opts.home,
        primaryKind: opts.actorKind,
        kindOrder: opts.kindOrder,
        explicitDir: opts.rolesDir ?? null,
      });
      for (const warning of roleSet.warnings) {
        if (loggedRoleWarnings.has(warning)) continue;
        loggedRoleWarnings.add(warning);
        log(`roles: ${warning}`);
      }
      const row = cards[0];
      // The card data states the lane; the assignee selects the role within it.
      // A review card never falls back to a different role.
      const role =
        lane === "reviewer"
          ? selectRole(roleSet, row.agent, "reviewer")
          : (selectRole(roleSet, row.agent, "worker") ?? selectWorkerRole(roleSet));
      const sessionKind = String(row.actor_kind ?? opts.actorKind ?? "claude");
      const skillMode = skillLoadMode(sessionKind);
      const files = role === null ? null : roleVariant(role, sessionKind);
      const skillReady = typeof files?.workflow === "string";
      const roleSkillPath = files?.skillDir ? join(files.skillDir, "SKILL.md") : null;
      const fingerprint = files?.skillDir ? skillFingerprint(files.skillDir) : null;
      // The attribution every write carries; the opener and the system prompt
      // are built from this one value so they cannot drift.
      const flags =
        `${row.agent ? `--agent ${row.agent} ` : ""}` + `--actor-kind=${sessionKind}`;
      const skill =
        role === null || !skillReady
          ? null
          : {
              path: roleSkillPath,
              fingerprint,
              opener:
                skillMode === "opener"
                  ? {
                      command: `/${basename(files.skillDir)}`,
                      flags,
                      fingerprint,
                      skillPath: roleSkillPath,
                    }
                  : null,
              // The adapter receives this only when it loads the skill itself.
              skillPath: skillMode === "inline" ? roleSkillPath : null,
            };
      // The card context rides the system prompt, so it reaches the agent at
      // `openSession` time — before, and independent of, the opener's turn.
      const systemPrompt = buildSessionSystemPrompt({
        staticPrompt: role?.systemPrompt ?? null,
        fallbackPrompt:
          lane === "reviewer" ? REVIEWER_SYSTEM_PROMPT_FALLBACK : WORKER_SYSTEM_PROMPT_FALLBACK,
        lane: lane === "reviewer" ? "reviewer" : "worker",
        agent: row.agent ?? null,
        project: row.project ?? null,
        cardRef: String(row.card),
        cardPath: join(dir, cardFileRel(row.card)),
        planPath: join(dir, cardDirRel(row.card), "plan.md"),
        processDir: join(dir, cardDirRel(row.card)),
        flags,
        reviewRef: row.review_of ?? null,
        reviewPath: row.review_of ? join(dir, cardFileRel(row.review_of)) : null,
        reviewPlanPath: row.review_of ? join(dir, cardDirRel(row.review_of), "plan.md") : null,
        // A review row's `round` is the review card's own delivery round (1 for
        // a fresh review card); the audited round is `review_round`, and a
        // missing one stays null so the prompt omits `(round N)`.
        round: lane === "reviewer" ? (row.review_round ?? null) : (row.round ?? 1),
      });
      const openOptions = {
        cwd: dir,
        role: lane === "reviewer" ? "reviewer" : "worker",
        actorKind: cards[0].actor_kind ?? null,
        skillPath: skill?.skillPath ?? null,
        systemPrompt,
        worker: { row: cards[0], workspace: cards[0].workspace ?? null },
      };
      let entry;
      try {
        entry = await ensureSession(key, openOptions);
      } catch (err) {
        if (String(cards[0].role ?? "worker") === "reviewer") {
          // A review has no human to wake; a failed open is retried by the queue
          // on a later tick, and held at the row's attempt bound.
          await settleFailedHandoff(cards[0], true, err.message);
        } else {
          // An unrestorable worker session is not retried: the row fails and the
          // card is parked at once (docs/scheduling.md, "worker session
          // unrestorable"), never left `in_progress` for a stale recovery.
          completeCards(stateDir, [cards[0].id], { status: "failed", error: err.message });
          log(`session: worker ${cards[0].card} could not open a session: ${err.message} — failed`);
          parkCard(cards[0].card, err.message);
        }
        continue;
      }
      // A project's cards may run in several worktrees; the cap is on the
      // project, not on one directory. A row written before worktrees carries
      // no project and falls back to the directory it runs in. The processing
      // rows are the live card sessions (this tick claims after this read).
      const project = String(cards[0]?.project ?? cards[0]?.project_dir ?? dir);
      const projectLive =
        read.value.cards.filter(
          (row) =>
            row.status === "processing" &&
            !isQuestionRow(row) &&
            String(row.project ?? row.project_dir ?? row.target_dir ?? "") === project,
        ).length + (claimedByProject.get(project) ?? 0);
      const budget = Math.max(0, Math.min(globalBudget, projectConcurrency - projectLive));
      if (budget === 0) {
        log(`session: ${dir} is at its project concurrency cap — leaving ${cards.length} card(s) pending`);
        continue;
      }
      const claimed = claimCards(stateDir, {
        claimedBy: dir,
        pid: process.pid,
        limit: Math.min(budget, cards.length),
        // Claim exactly this group's rows. A first-come scan would let one
        // directory (or lane) take another's handoffs.
        ids: cards.map((card) => card.id),
        now: nowIso(now),
      });
      if (!claimed.ok || claimed.cards.length === 0) {
        if (!claimed.ok) log(`session: card claim failed: ${claimed.error}`);
        continue;
      }
      globalBudget -= claimed.cards.length;
      // A retried handoff is re-checked against the board before it is sent: the
      // previous turn may have delivered (or a human may have moved the card)
      // after the turn that produced this retry had already been interrupted.
      const { batch, dropped } = await revalidateBatch(claimed.cards);
      if (dropped > 0) globalBudget += dropped;
      if (batch.length === 0) continue;
      claimedByProject.set(project, (claimedByProject.get(project) ?? 0) + batch.length);
      if (
        skill !== null &&
        entry.fresh !== true &&
        typeof skill.fingerprint === "string" &&
        entry.openerFingerprint !== skill.fingerprint
      ) {
        await closeEntry(entry, { dropSession: true });
        entry = await ensureSession(key, openOptions);
      }
      jobs.push({ key, dir, lane, entry, cards: batch, roleSet, skill, openOptions });
    }

    // Fan out: each job owns a distinct card session, so no two sends share a
    // handle. Planning and claiming finished before the first send, so the
    // per-tick budget is fixed. Results are applied serially — the ledger and
    // the queue are single files.
    /**
     * Pulse the claimed card as its holder for the life of the turn.
     *
     * A 60-minute turn cannot beat the board's 10-minute fresh window from
     * inside the agent, so the loop writes the heartbeat itself. The pulse is
     * best-effort: a refusal stops it, and it never changes the turn's outcome.
     *
     * @param {object} row the handoff queue row
     * @returns {{stop: () => void}}
     */
    const startCardPulse = (row) => {
      const agent = typeof row?.agent === "string" ? row.agent.trim() : "";
      const card = String(row?.card ?? "");
      if (opts.dryRun || agent === "" || card === "") return { stop: () => {} };
      const every = Math.max(1, Number(opts.cardHeartbeatMs ?? CARD_HEARTBEAT_MS));
      let stopped = false;
      let inFlight = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      };
      const timer = setInterval(() => {
        // One pulse at a time: a slow board must not stack calls, and one
        // refusal must be the end of the timer, not the first of several.
        if (stopped || inFlight) return;
        inFlight = true;
        void runCliAsync(opts, agent, ["issue", "heartbeat", card], {
          actorKind: row.actor_kind ?? opts.actorKind,
        })
          .then((result) => {
            if (result.ok === true) return;
            stop();
            log(
              `session: card heartbeat for ${card} refused (${result.code ?? result.error ?? "unknown"}) — pulse stopped`,
              { level: "debug" },
            );
          })
          .finally(() => {
            inFlight = false;
          });
      }, every);
      timer.unref?.();
      return { stop };
    };

    const sendCardTurn = async (job) => {
      const row = job.cards[0];
      const plan = job.entry.worker?.planMode ?? "fresh";
      // A rework is not a question-lane resume: its delta prompt is the answer,
      // and reading the human answer would make it look like a same-round retry.
      const rework = row.rework === true && row.force_fresh !== true;
      let answer = null;
      if (plan !== "fresh" && !rework) {
        const context = await readRedispatchContext(opts, row.card, log);
        answer = context.ok === true ? context.answer : null;
      }
      const run = async (entry, planMode, { skipOpener = false } = {}) => {
        entry.busy = true;
        entry.worker.status = "running";
        persistState();
        try {
          // A closed handle answers every send with `session is closed`; sending
          // the card prompt into it would spend the row's attempt budget on a
          // dead pipe. Report it so the caller can open a fresh conversation.
          if (entry.handle?.closed === true) {
            return {
              ok: false,
              error: "session is closed",
              sessionId: entry.sessionId,
              cwd: entry.cwd,
            };
          }
          // The board row mirrors the turn: running while it is in flight and
          // closed/failed on every terminal branch below.
          registerBoardSession(entry, row);
          let opened = { ok: true, sent: false };
          if (!skipOpener) {
            opened = await ensureOpener(
              entry,
              job.skill?.opener ?? null,
              job.skill?.fingerprint ?? null,
            );
            // The opener is optional: a timeout or a closed handle is transient.
            // Report it so the caller reopens a conversation instead of spending
            // the card's attempt on a turn it never received.
            if (
              opened.ok !== true &&
              (isTurnTimeoutError(opened.error) || entry.handle?.closed === true)
            ) {
              return {
                ok: false,
                error: opened.error ?? "session is closed",
                openerTimedOut: true,
                sessionId: entry.sessionId,
                cwd: entry.cwd,
              };
            }
          }
          const prompt =
            planMode === "replay"
              ? buildWorkerReplayPrompt({
                  row,
                  handoff: row.handoff,
                  reason: entry.worker?.reason,
                  answer,
                  transcript: readWorkerTranscript(stateDir, job.key),
                  nativeError: entry.worker?.lastError,
                  rework,
                })
              : planMode === "resume"
                ? rework
                  ? buildWorkerReworkPrompt({
                      row,
                      handoff: row.handoff,
                      carryFromRound: row.carry_from_round,
                    })
                  : buildWorkerResumePrompt({
                      row,
                      handoff: row.handoff,
                      reason: entry.worker?.reason,
                      answer,
                      sessionId: entry.sessionId,
                    })
                : buildWorkerDispatchPrompt({ row, handoff: row.handoff });
          // A skipped opener (the reopen path) needs the same pointer a failed
          // opener gets: the new conversation has not loaded the skill.
          const fallback =
            (skipOpener || opened.ok !== true) && typeof job.skill?.path === "string"
              ? `Role skill: ${job.skill.path} — read it before acting.\n\n`
              : "";
          appendWorkerTurn(stateDir, job.key, { kind: "dispatch", text: `${planMode} ${row.card}` });
          const result = await entry.handle.send(`${fallback}${prompt}`, {
            timeoutMs: turnTimeoutMs,
          });
          if (result?.ok === true && skipOpener === true) {
            // The card prompt carried the skill pointer; record the skill as
            // loaded so this session's next retry does not spend another opener.
            markOpener(entry, job.skill?.opener?.fingerprint ?? null);
          }
          return result;
        } finally {
          entry.busy = false;
          entry.lastUsedAt = nowIso(now);
        }
      };
      // Normalize through the one seam that replaces a closed handle: a session
      // that died between ticks must not cost the card a turn. A timed-out
      // opener takes the same path — the opener holds the skill, not the card.
      let entry = await ensureSession(job.key, job.openOptions);
      job.entry = entry;
      let usedPlan = entry.worker?.planMode ?? plan;
      let reopened = false;
      const runTurn = async (current, planMode) => {
        const result = await run(current, planMode);
        if (
          (result?.error !== "session is closed" && result?.openerTimedOut !== true) ||
          reopened === true
        ) {
          return { result, current, planMode };
        }
        reopened = true;
        await closeEntry(current, { dropSession: true });
        const next = await ensureSession(job.key, job.openOptions);
        job.entry = next;
        const nextPlan = next.worker?.planMode ?? "fresh";
        return {
          result: await run(next, nextPlan, { skipOpener: true }),
          current: next,
          planMode: nextPlan,
        };
      };
      let turn = await runTurn(entry, usedPlan);
      entry = turn.current;
      usedPlan = turn.planMode;
      let outcome = turn.result;
      if (outcome?.resumeFailed === true && usedPlan === "resume") {
        await closeEntry(entry, { dropSession: false });
        entry = openSession(job.key, {
          cwd: job.dir,
          role: job.lane === "reviewer" ? "reviewer" : "worker",
          skillPath: job.skill?.skillPath ?? null,
          // A replay opens a fresh native session; it needs the context again.
          systemPrompt: job.openOptions.systemPrompt ?? null,
          worker: { row, workspace: row.workspace ?? null, forceReplay: true },
        });
        job.entry = entry;
        turn = await runTurn(entry, "replay");
        entry = turn.current;
        usedPlan = turn.planMode;
        outcome = turn.result;
        entry.worker.resumeState = "resumed_by_replay";
        persistState();
      }
      return { outcome, plan: usedPlan };
    };

    // The pulse covers the opener and the card prompt, and is cleared whatever
    // path the turn takes.
    const sendCardJob = async (job) => {
      const pulse = startCardPulse(job.cards[0]);
      try {
        return await sendCardTurn(job);
      } finally {
        pulse.stop();
      }
    };
    const settled = await Promise.allSettled(jobs.map((job) => sendCardJob(job)));

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const { dir, lane, entry, cards: batch } = job;
      const row = batch[0];
      const review = lane === "reviewer";
      const settledJob = settled[index];
      if (settledJob.status === "rejected") {
        const error = String(settledJob.reason?.message ?? settledJob.reason ?? "card turn failed");
        for (const failedCard of batch) {
          await settleFailedHandoff(failedCard, lane === "reviewer", error);
        }
        entry.worker.status = "idle";
        entry.worker.lastError = error;
        closeBoardSession(entry, "failed");
        persistState();
        if (/closed|exited|spawn error|timed out/.test(error)) {
          await closeEntry(entry, { dropSession: false, boardStatus: "failed" });
        }
        continue;
      }
      const { outcome, plan = null } = settledJob.value;
      if (outcome?.ok === true) {
        // A review turn's whole deliverable is the verdict, so a "successful"
        // turn that left the card in_progress did not do its job. Keep the row
        // for another turn instead of closing the handoff in silence.
        if (review && revalidateCard !== null) {
          const live = await revalidateCard({ card: row.card, row });
          if (live?.ok === true && live.status === "in_progress") {
            const error = "review turn ended without delivering a verdict";
            await settleFailedHandoff(row, true, error);
            entry.worker.status = "idle";
            entry.worker.lastError = error;
            closeBoardSession(entry, "failed");
            persistState();
            continue;
          }
        }
        appendWorkerTurn(stateDir, job.key, { kind: "result", text: String(outcome.result ?? "") });
        // One terminal row per card turn. A card session is the whole unit of
        // work now: the queue's processing row held the slot, so the ledger
        // records the finished turn and nothing live.
        ledger = upsertSubagent(ledger, {
          sessionKey: job.key,
          lane: review ? "reviewer" : "worker",
          actorKind: opts.actorKind,
          subagentId: entry.sessionId,
          role: row.role ?? "worker",
          agentRole: row.agent_role ?? null,
          card: row.card,
          type: "card-session",
          status: "completed",
          lastResult: `${review ? "review" : "worker"} session turn completed`,
          queueId: row.id,
          project: row.project ?? null,
          projectDir: row.project_dir ?? job.dir,
          workspace: row.workspace?.path ?? row.target_dir,
          round: roundOf(row),
        });
        completeCards(stateDir, [row.id]);
        entry.worker.status = "idle";
        entry.worker.planMode = "resume";
        entry.worker.resumeState =
          plan === "resume" ? "resumed" : plan === "replay" ? "resumed_by_replay" : "fresh";
        entry.worker.lastResumeAt = nowIso(now);
        closeBoardSession(entry, "closed");
        dispatched += 1;
        persistState();
        writeLedgerState();
        continue;
      }
      const error = String(outcome?.error ?? `${review ? "review" : "worker"} turn failed`);
      if (plan === "replay" || outcome?.resumeFailed === true) {
        entry.worker.lastError = error;
        // A resume/replay that timed out is the same transient failure as a
        // first turn: it never parks the card.
        if (isTurnTimeoutError(error)) {
          await settleTimedOutHandoff(row, review, `session resume/replay failed: ${error}`);
          entry.worker.status = "idle";
          entry.worker.lastError = error;
          await closeEntry(entry, { dropSession: false, boardStatus: "failed" });
          persistState();
          continue;
        }
        if (review) {
          // A review has no question lane of its own: the session record is not
          // marked blocked, and the queue's attempt budget is what stops it. At
          // the bound the card gets the same execution hold as a worker's.
          await settleFailedHandoff(row, true, `review session resume/replay failed: ${error}`);
          entry.worker.status = "idle";
          await closeEntry(entry, { dropSession: true, boardStatus: "failed" });
          persistState();
          continue;
        }
        entry.worker.status = "stale";
        entry.worker.blocked = true;
        completeCards(stateDir, [row.id], {
          status: "failed",
          error: `worker session resume/replay failed: ${error}`,
        });
        log(`session: worker ${row.card} is blocked after a failed resume: ${error}`, {
          level: "error",
        });
        // Stop the 30-minute re-dispatch loop: the card is parked for a human
        // instead of leaving the claim `in_progress` for the stale recovery.
        parkCard(row.card, error);
        closeBoardSession(entry, "failed");
        persistState();
        continue;
      }
      let stillWorkable = true;
      if (revalidateCard !== null) {
        const live = await revalidateCard({ card: row.card, row });
        if (
          live?.ok === true &&
          typeof live.status === "string" &&
          live.status !== "todo" &&
          live.status !== "in_progress"
        ) {
          completeCards(stateDir, [row.id], {
            status: "done",
            error: `not re-dispatched: card is ${live.status}`,
          });
          entry.worker.status = "idle";
          stillWorkable = false;
          log(
            `session: ${review ? "review " : "worker "}${row.card} is ${live.status} after a failed turn — handoff completed`,
          );
        }
      }
      if (stillWorkable) {
        await settleFailedHandoff(row, review, error);
      }
      closeBoardSession(entry, "failed");
      if (/closed|exited|spawn error|timed out/.test(error)) {
        await closeEntry(entry, { dropSession: false, boardStatus: "failed" });
      }
      // The turn settled; the record must not keep saying `running` (a failed
      // turn is retried on the next tick, and the guard reads `busy`).
      entry.worker.status = "idle";
      entry.worker.lastError = error;
      persistState();
    }
    ledger = prune(ledger, { now: now() });
    writeLedgerState();
    return { ok: true, dispatched };
  }

  async function evictIdle() {
    for (const entry of [...sessions.values()]) {
      if (entry.busy === true) continue;
      if (isWorkerKey(entry.key)) {
        if (entry.worker?.status === "running") continue;
        const dir = entry.worker?.worktree ?? entry.cwd;
        const age = now() - Date.parse(String(entry.startedAt));
        const idle = now() - Date.parse(String(entry.lastUsedAt));
        if (!existsSync(dir)) {
          entry.worker.worktree_gone = true;
          entry.worker.status = "idle";
          await closeEntry(entry, { dropSession: false });
          const record = state.projects?.[entry.key];
          if (record !== undefined) {
            record.worktree_gone = true;
            record.sessionId = null;
            record.status = "idle";
          }
          persistState();
          log(`session: worker ${entry.key} — its workspace is gone; will start fresh`);
          continue;
        }
        if (sessionMaxAgeMs > 0 && age > sessionMaxAgeMs) {
          entry.worker.needsReplay = true;
          entry.worker.status = "idle";
          await closeEntry(entry, { dropSession: false });
          const record = state.projects?.[entry.key];
          if (record !== undefined) {
            record.needsReplay = true;
            record.sessionId = null;
            record.status = "idle";
          }
          persistState();
          log(`session: worker ${entry.key} reached max-age — will replay on the next dispatch`);
        } else if (projectIdleMs >= 0 && idle > projectIdleMs) {
          entry.worker.status = "idle";
          await closeEntry(entry, { dropSession: false });
          log(`session: worker ${entry.key} idle — closed; resume id kept`);
        }
        continue;
      }
      // A non-card key is a director lane: the key is its directory.
      const dir = entry.key;
      const age = now() - Date.parse(String(entry.startedAt));
      const idle = now() - Date.parse(String(entry.lastUsedAt));
      // A swept worktree takes its session with it; a stale key must not be
      // reused for a path that no longer exists.
      if (!existsSync(dir)) {
        await closeEntry(entry, { dropSession: true });
        log(`session: lane session ${entry.key} — its directory is gone; closed`);
        continue;
      }
      if (sessionMaxAgeMs > 0 && age > sessionMaxAgeMs) {
        await closeEntry(entry, { dropSession: true });
        log(`session: lane session ${entry.key} reached max-age — fresh next batch`);
      } else if (projectIdleMs >= 0 && idle > projectIdleMs) {
        await closeEntry(entry, { dropSession: false });
        log(`session: lane session ${entry.key} idle — closed; resume id kept`);
      }
    }
  }

  /**
   * Park a card whose worker session cannot be restored.
   *
   * A blocked session record is skipped by recovery and every re-dispatch
   * throws again, so the claim would sit `in_progress` until the board's stale
   * recovery — a 30-minute loop. `blocked/resource` is the honest state: the
   * loop could not run it, and a human must clear the cause and move it back.
   */
  /**
   * A triage that exhausted its turns. The producer is `done`, so there is no
   * legal move and no question to answer; record the failure on the card and
   * let `loop doctor` surface the unconsumed handoff.
   */
  function noteTriageFailed(ref, reason) {
    const card = String(ref ?? "");
    if (card === "") return;
    const body = [
      `The director could not consume this card's required handoff (${reason}).`,
      "",
      "The card stays `done`. Create the proposed downstream card, record `handoff_declined_round`, or clear `stage_handoff` if the handoff was withdrawn.",
    ].join("\n");
    runCli(
      opts,
      ORCHESTRATOR_ACTOR_ID,
      ["comment", "add", card, "--kind", "note", "--body", body],
      { actorKind: SYSTEM_KIND },
    );
  }

  /**
   * Settle a failed card handoff. A transient timeout takes the timeout path;
   * everything else keeps the attempt bound. Below the bound the same claim is
   * retried; at the bound the row is terminal, so the card gets the execution
   * hold instead of being left `in_progress` for a stale recovery that may
   * never come (docs/scheduling.md, ADR 0009).
   *
   * @param {object} row queue row (one card)
   * @param {boolean} review
   * @param {string} error
   * @returns {Promise<{terminal: boolean}>}
   */
  async function settleFailedHandoff(row, review, error) {
    if (isTurnTimeoutError(error)) return settleTimedOutHandoff(row, review, error);
    const label = review ? "review " : "worker ";
    const result = requeueCards(stateDir, [row.id], { error });
    if (result.ok !== true) {
      log(`session: ${label}${row.card} could not record the failure: ${result.error ?? "unknown error"}`, {
        level: "error",
      });
      return { terminal: false };
    }
    if (result.failed > 0) {
      const attempts = Number(result.attempts?.[String(row.id)] ?? 0);
      log(
        `session: ${label}${row.card} failed: ${error} — row failed after ${attempts} attempt(s); card held blocked/resource`,
        { level: "error" },
      );
      holdCard(opts, log, row.card, {
        code: "HANDOFF_FAILED",
        reason: error,
        body: [
          `The loop stopped dispatching this card after ${attempts} failed handoff turn(s).`,
          "",
          String(error ?? "").slice(0, 500),
          "",
          "It will not be retried automatically. Fix the cause, then move this card back to `todo` (or `in_progress`).",
        ].join("\n"),
      });
      return { terminal: true };
    }
    if (result.requeued > 0) {
      log(`session: ${label}${row.card} failed: ${error} — requeued`);
    } else {
      log(`session: ${label}${row.card} failed: ${error} — no live row to requeue`, {
        level: "warn",
      });
    }
    return { terminal: false };
  }

  /**
   * Settle a timed-out turn: its own counter, its own backoff, never a hold.
   *
   * Below the bound the row is pending with a `retry_at`; the next tick after
   * the backoff re-dispatches the card to the same session. On the third, the
   * card is re-read **before** it is moved: the turn may have delivered (or a
   * human may have moved it) while it was unwinding. Only a card still
   * `in_progress` returns to `todo`; a read failure leaves it to the ordinary
   * stale-claim recovery.
   *
   * @param {object} row queue row (one card)
   * @param {boolean} review
   * @param {string} error
   * @returns {Promise<{terminal: boolean}>}
   */
  async function settleTimedOutHandoff(row, review, error) {
    const label = review ? "review " : "worker ";
    const result = timeoutCards(stateDir, [row.id], { error, now: now() });
    if (result.ok !== true) {
      log(
        `session: ${label}${row.card} could not record the timeout: ${result.error ?? "unknown error"}`,
        { level: "error" },
      );
      return { terminal: false };
    }
    const count = Number(result.timeouts?.[String(row.id)] ?? 0);
    if (count === 0) {
      log(`session: ${label}${row.card} has no in-flight row to time out`, { level: "warn" });
      return { terminal: false };
    }
    if (result.exhaustedIds.length === 0) {
      log(
        `session: ${label}${row.card} timed out (${count}/${TIMEOUT_MAX_ATTEMPTS}) — ` +
          `retry at ${result.retryAt ?? "the next tick"}`,
      );
      return { terminal: false };
    }
    // The release is a board write after a re-read: never move a card that has
    // already moved (a delivery, a human, or an awaiting/review state).
    const live = revalidateCard === null ? null : await revalidateCard({ card: row.card, row });
    if (live?.ok === true && live.status === "in_progress") {
      const released = releaseCard(opts, log, row.card, {
        reason: `turn timed out ${count} time(s); returned to the queue`,
        body: [
          `The loop stopped waiting on this turn after ${count} timeout(s).`,
          "",
          "The card is back in `todo`; a later poll will dispatch it again. This is a loop-side timeout, not a delivery failure.",
        ].join("\n"),
      });
      completeCards(stateDir, [row.id], {
        status: "failed",
        error: `turn timed out ${count} time(s)`,
      });
      if (released.ok !== true) {
        log(
          `session: ${label}${row.card} could not be released after ${count} timeout(s): ` +
            `${released.error ?? "unknown error"}`,
          { level: "error" },
        );
      }
      return { terminal: true };
    }
    if (live?.ok === true) {
      completeCards(stateDir, [row.id], {
        status: "done",
        error: `not re-dispatched: card is ${live.status ?? "unknown"}`,
      });
      log(
        `session: ${label}${row.card} is ${live.status ?? "unknown"} after the timeout — handoff completed`,
      );
      return { terminal: true };
    }
    // Fail-soft: an unreadable board never moves a card. The row is closed and
    // the ordinary stale-claim recovery owns the claim.
    completeCards(stateDir, [row.id], {
      status: "failed",
      error: `turn timed out ${count} time(s); card state unreadable`,
    });
    log(
      `session: ${label}${row.card} could not be re-checked after ${count} timeout(s) — not released`,
      { level: "warn" },
    );
    return { terminal: true };
  }

  function parkCard(ref, reason, blockedReason = "resource") {
    const card = String(ref ?? "");
    if (card === "") return;
    const body = [
      `The loop could not restore this card's worker session (${reason}).`,
      "",
      "It will not be dispatched again automatically. Fix the cause (the agent CLI, the session, the workspace), then move this card back to `todo` or `in_progress`.",
    ].join("\n");
    holdCard(opts, log, card, {
      code: "WORKER_SESSION_UNRESTORABLE",
      reason,
      blockedReason,
      body,
    });
  }

  /**
   * A crash leaves a worker row `processing` and its session record durable.
   * Return the row to pending **without** an attempt so the next tick resumes
   * the same conversation; a replay or a fresh open is never a second worker.
   *
   * Runs as the background reattach pass, after the tick and heartbeat start.
   * The optional deadline is the whole pass's bound: a group that would begin
   * after it is recorded as `reattach_timeout` and left to the stale-claim
   * recovery, never allowed to hold the startup window open.
   *
   * @param {{deadline?: number|null}} [options]
   */
  async function recoverWorkerSessions(options = {}) {
    const deadline = Number.isFinite(options.deadline) ? options.deadline : null;
    const read = readCards(stateDir);
    if (read.error !== null) {
      log(`session: reattach could not read the card queue: ${read.error}`, { level: "warn" });
      return { ok: false, resumed: 0, timedOut: 0, failed: 0, failedIds: [], error: read.error };
    }
    const workers = readWorkerSessions(stateDir).workers;
    const ids = [];
    const timedOut = [];
    for (const row of read.value.cards) {
      if (row.status !== "processing") continue;
      if (typeof row.worker_key !== "string" || row.worker_key === "") continue;
      const record = workers[row.worker_key];
      if (record === undefined || record.blocked === true) continue;
      if (!started) break;
      if (deadline !== null && now() > deadline) {
        timedOut.push(String(row.card ?? ""));
        continue;
      }
      // The turn may have delivered just before the crash. Resuming it would
      // re-prompt a card that already left the work state; complete the row
      // locally instead (the board is the durable record).
      if (revalidateCard !== null) {
        const live = await revalidateCard({ card: row.card, row });
        if (live?.ok === true && live.status !== "todo" && live.status !== "in_progress") {
          completeCards(stateDir, [row.id], {
            status: "done",
            error: `not resumed: card is ${live.status ?? "unknown"}`,
          });
          log(`session: ${row.card} is ${live.status ?? "unknown"} — recovered row completed without a resume`);
          continue;
        }
      }
      ids.push(String(row.id));
    }
    if (timedOut.length > 0) {
      // One record for the whole pass; the startup continues, and these rows
      // are recoverable work, not a failure.
      log(
        `session: reattach timed out for ${timedOut.join(", ")} — the stale-claim recovery owns them`,
        { level: "warn", event: "reattach_timeout", cards: timedOut },
      );
    }
    if (ids.length === 0) {
      return { ok: true, resumed: 0, timedOut: timedOut.length, failed: 0, failedIds: [], error: null };
    }
    const resumed = resumeCards(stateDir, ids, { error: "worker session recovered; resuming" });
    for (const row of read.value.cards) {
      if (!ids.includes(String(row.id))) continue;
      const key = row.worker_key;
      if (typeof key === "string" && state.projects?.[key] !== undefined) {
        state.projects[key] = {
          ...state.projects[key],
          status: "idle",
          lastError: null,
        };
      }
    }
    persistState();
    if (resumed.failed > 0) {
      for (const id of resumed.failedIds ?? []) {
        const row = read.value.cards.find((entry) => String(entry.id) === id);
        if (row === undefined) continue;
        if (String(row.role ?? "worker") === "reviewer") {
          // A review is never parked: with no handoff it simply falls back to
          // the board's stale-claim recovery, and the next poll re-enqueues it.
          log(`session: review ${row.card} stopped after repeated crash recoveries — not parked`);
          continue;
        }
        parkCard(row.card, "repeated crash recoveries");
      }
      log(
        `session: ${resumed.failed} worker row(s) stopped after repeated crash recoveries — ` +
          "the cards are parked for a human",
        { level: "error" },
      );
    }
    log(`session: recovered ${resumed.resumed} worker session(s) for resume`, { level: "debug" });
    return { ...resumed, timedOut: timedOut.length };
  }

  let lockToken = null;

  async function acquireLock() {
    ensureStateDir(stateDir);
    // The same `wx` lock the queue uses: the pool lock is never stolen from a
    // live pid, so a wedged-but-alive pool is one process, not two. A dead
    // holder (a crash) is reclaimed without waiting for a timeout.
    const lock = acquireFileLock(lockFile(stateDir), {
      retries: 0,
      stealAlive: false,
      // Two pools in one process are two owners: the second is refused, not
      // admitted through the re-entry shortcut.
      reentrant: false,
    });
    if (!lock.acquired) {
      const pid = lock.holder?.pid ?? null;
      return {
        ok: false,
        holder: lock.holder,
        error: pid === null ? "session pool already running" : `session pool already running (pid ${pid})`,
      };
    }
    lockToken = lock.token;
    return { ok: true, holder: null };
  }

  function releaseLock() {
    if (lockToken === null) return;
    releaseFileLock(lockFile(stateDir), lockToken);
    lockToken = null;
  }

  return {
    get sessions() {
      return sessions;
    },
    get ledger() {
      return ledger;
    },
    async start() {
      captureOwnership();
      const lock = await acquireLock();
      if (!lock.ok) return lock;
      // The previous incarnation's children die before anything resumes their
      // conversations; otherwise `--resume` opens a second process for the same
      // session and the card executes twice.
      const reaped = await reapPreviousChildren();
      // The lock is the ownership fact; the phase now says the pool is up. The
      // slow reattach pass is not part of start(): `runSession` starts the tick
      // and heartbeat first, then runs it in the background, so a board read in
      // reattach never holds the startup window open.
      phase = "running";
      started = true;
      persistState();
      return { ok: true, reaped: reaped.reaped };
    },
    /**
     * Publish `phase:starting` before `start()` is attempted, so the startup
     * window is a live pool to every reader instead of an absent one. Never
     * clobber a live pool's state; `start()` will refuse the lock anyway.
     *
     * @returns {{ok: boolean, reason?: string, previousPoolPid?: number|null}}
     */
    announceStarting() {
      const prior = readJsonFile(sessionsFile(stateDir), null).value;
      if (prior !== null && typeof prior === "object") {
        const priorVerdict = poolVerdict({
          poolPid: prior.poolPid,
          poolPidStart: prior.poolPidStart ?? null,
          phase: prior.phase,
          startStartedAt: prior.startStartedAt ?? null,
          heartbeatAt: prior.heartbeatAt ?? null,
          tickStartedAt: prior.tickStartedAt ?? null,
          turnTimeoutMs: prior.turnTimeoutMs ?? turnTimeoutMs,
          now,
          isAlive,
        });
        if (priorVerdict.live) {
          return { ok: false, reason: `a pool is already ${priorVerdict.verdict}` };
        }
      }
      captureOwnership();
      phase = "starting";
      persistState();
      return { ok: true, previousPoolPid };
    },
    /**
     * The background reattach pass. Bounded per group: one slow board read is
     * enough to fill the budget, so the rest are recorded as `reattach_timeout`
     * and left for the stale-claim recovery instead of holding startup open.
     */
    async reattachOnStart() {
      if (!started) return { ok: true, resumed: 0, timedOut: 0, failed: 0, failedIds: [] };
      const budgetMs = Math.min(effectiveTurnTimeoutMs(turnTimeoutMs), POOL_REATTACH_MAX_MS);
      const recovered = await recoverWorkerSessions({ deadline: now() + budgetMs });
      // The board rows a dead pool left `running` are closed from the same
      // startup pass; the recovery above may have resumed some of them, so it
      // runs after. Its own independent budget keeps it off the reattach path.
      try {
        await reconcileBoardSessions(now() + RECONCILE_BOARD_BUDGET_MS);
      } catch (err) {
        log(`session: board session reconciliation failed: ${err.message}`, { level: "warn" });
      }
      return recovered;
    },
    async stop() {
      started = false;
      phase = "stopped";
      // Every kind's pool is ours to close. An injected pool (tests) is not:
      // its owner decides when it ends.
      for (const pool of kindPools.values()) {
        try {
          await pool.close();
        } catch (err) {
          log(`session: pool close failed: ${err.message}`);
        }
      }
      kindPools.clear();
      // A stopped pool owns no live turn: close any board row still saying
      // running, within a bounded window so shutdown cannot hang the service.
      // Only the lock owner may write, like the state file itself.
      if (lockToken !== null) {
        const deadline = Date.now() + RECONCILE_BOARD_BUDGET_MS;
        for (const entry of [...sessions.values()]) {
          if (Date.now() > deadline) break;
          closeBoardSession(entry, "closed");
        }
      }
      for (const entry of [...sessions.values()]) sessions.delete(entry.key);
      // Only the lock owner may publish the stopped state: a start that never
      // took the lock (another pool owns it) must not clobber that pool's file.
      if (lockToken !== null) {
        persistState();
        releaseLock();
      }
      return { ok: true };
    },
    async tick(options = {}) {
      // The in-flight marker is what separates a long tick from a healthy one.
      // It is written before the first await and cleared in `finally`, so a
      // thrown pass cannot leave the pool "wedged" forever.
      tickStartedAt = nowIso(now);
      persistState();
      try {
        const cardResult = await routeCards(options);
        await evictIdle();
        // Display-only: the age of the last *successful* tick. A fast failing
        // tick is degradation, not a wedge, so it is not a kill signal.
        lastTickOkAt = nowIso(now);
        return { cards: cardResult };
      } finally {
        tickStartedAt = null;
        persistState();
      }
    },
    async routeCards(options = {}) {
      return routeCards(options);
    },
    async routeQuestionsNow() {
      return routeQuestionsNow();
    },
    async evictIdle() {
      return evictIdle();
    },
    persistState,
    status() {
      const cards = readCards(stateDir).value.cards;
      const workerEntries = [...sessions.values()].filter((entry) => isWorkerKey(entry.key));
      const workerState = {
        open: workerEntries.length,
        running: 0,
        paused: 0,
        stale: 0,
        blocked: 0,
        byRole: { worker: 0, reviewer: 0 },
        byResumeState: { fresh: 0, resumed: 0, resumed_by_replay: 0, stale: 0 },
      };
      for (const entry of workerEntries) {
        const status = String(entry.worker?.status ?? "idle");
        if (Object.hasOwn(workerState, status)) workerState[status] += 1;
        const role = entry.role === "reviewer" ? "reviewer" : "worker";
        workerState.byRole[role] += 1;
        const resumeState = String(entry.worker?.resumeState ?? "fresh");
        if (Object.hasOwn(workerState.byResumeState, resumeState)) {
          workerState.byResumeState[resumeState] += 1;
        }
      }
      return {
        running: started,
        controlMode,
        projects: state.projects ?? {},
        workers: workerState,
        openSessions: [...sessions.keys()],
        liveSubagents: liveSubagents(ledger).length,
        cardPending: cards.filter((card) => card.status === "pending").length,
        cardProcessing: cards.filter((card) => card.status === "processing").length,
        questionPending: cards.filter(
          (card) => String(card.queue_kind ?? "") === "question" && card.status === "pending",
        ).length,
      };
    },
  };
}

/**
 * The long-running `--session` entry. `deps` is the in-process seam the tests
 * use; production passes only `opts`.
 *
 * @param {object} opts
 * @param {{log?: (line: string) => void, kindPool?: object, now?: () => number, isAlive?: (pid: number) => boolean, signal?: AbortSignal, onFirstTick?: () => void}} [deps]
 */
export async function runSession(opts, deps = {}) {
  const log = deps.log ?? (() => {});
  // The resident sessions load skills by name: the director lane runs
  // `meerkat-director`, and workers/reviewers use the board skill. A missing
  // install is a hard error, not a session that silently cannot work. The director
  // is found wherever its skill is installed (the primary kind first): its location
  // is routing, not a config value.
  const home = opts.home ?? homedir();
  const paths = agentPaths(home, opts.actorKind ?? "claude");
  const director = resolveDirectorSkill(home, opts.actorKind ?? "claude", opts.kindOrder);
  const missing = [
    director.exists ? null : director.skillDir,
    existsSync(join(paths.boardSkill, "SKILL.md")) ? null : paths.boardSkill,
  ].filter((dir) => dir !== null);
  if (missing.length > 0) {
    log(
      `session: missing skill(s): ${missing.join(", ")} — run ` +
        `\`install.sh --target ${opts.actorKind ?? "claude"}\` first`,
    );
    // EX_CONFIG: no restart can install a skill. systemd is told not to restart
    // this exit (`RestartPreventExitStatus=78`); launchd has no equivalent and
    // leans on its throttle.
    return 78;
  }
  const pool = createSessionPool({
    opts,
    log,
    kindPool: deps.kindPool,
    now: deps.now,
    isAlive: deps.isAlive,
    revalidateCard: (input) => readCardForRedispatch(opts, input.card, log),
    readQuestionOutcome: (input) =>
      readQuestionOutcome(opts, input.card, input.questionId, log),
    routeOutcome: (input) => readRouteOutcome(opts, input.card, log),
    triageOutcome: (input) => readTriageOutcome(opts, input.card, input.round, log),
  });
  let started;
  try {
    // The startup window is published before `start()`: another reader must
    // see a live `starting` pool, never an absent one, between this process
    // claiming the loop and its first heartbeat.
    pool.announceStarting();
    started = await pool.start();
  } catch (err) {
    // A throw used to escape as an unhandled rejection and kill the pool with
    // no record. 2 is the "cannot run as invoked" code the missing-skill path
    // above already returns; the record names the failed phase.
    log(`session: pool start failed: ${err?.message ?? String(err)}`, {
      level: "error",
      event: "pool_start_failed",
    });
    // `start()` may have taken the lock (and opened a session) before it threw;
    // a failed start must not leave either behind.
    try {
      await pool.stop();
    } catch {
      /* the start failure is the one to report */
    }
    return 2;
  }
  if (!started.ok) {
    log(`session: ${started.error}`, { level: "error" });
    return 1;
  }
  log("session: pool started");
  let stopping = false;
  let ticking = false;
  let inFlightTick = null;
  let firstTickDone = false;
  const interval = setInterval(() => {
    // A turn can outlive many poll intervals; a second concurrent tick would
    // re-read the same queues for no gain. A stopping pool accepts no new tick.
    if (stopping || ticking) return;
    ticking = true;
    inFlightTick = pool
      .tick()
      .catch((err) => log(`session: tick failed: ${err.message}`, { level: "error" }))
      .finally(() => {
        ticking = false;
        inFlightTick = null;
        // The boot succeeded once the first tick settled: the process is alive
        // and doing work. A crash after this point is never delayed.
        if (!firstTickDone) {
          firstTickDone = true;
          deps.onFirstTick?.();
        }
      });
  }, Math.max(50, Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs)));
  // Questions have their own clock. The dispatch tick awaits worker turns, and a
  // worker holding for an answer is exactly when the director lane must still be
  // routed; sharing the tick would serialize the answer behind the very turn it
  // is meant to unblock.
  let routingQuestions = false;
  let inFlightQuestions = null;
  const questionInterval = setInterval(() => {
    if (stopping || routingQuestions) return;
    routingQuestions = true;
    inFlightQuestions = pool
      .routeQuestionsNow()
      .catch((err) => log(`session: question tick failed: ${err.message}`, { level: "error" }))
      .finally(() => {
        routingQuestions = false;
        inFlightQuestions = null;
      });
  }, Math.max(50, Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs)));
  // The heartbeat is independent of the tick: while a turn is in flight the
  // state file must still say "the pool is here".
  const heartbeat = setInterval(() => pool.persistState(), POOL_HEARTBEAT_MS);
  // Reattach is a background pass, started only after the tick and heartbeat
  // own the pool's liveness. A slow board read here must not keep the startup
  // window open; the pass is bounded and records `reattach_timeout`.
  if (deps.signal === undefined || !deps.signal.aborted) {
    void pool
      .reattachOnStart()
      .catch((err) => log(`session: reattach failed: ${err?.message ?? String(err)}`, { level: "warn" }));
  }
  // These three timers are the pool's lifetime in every deployment shape: the
  // installed daemon, a `--take-over` pool, and a hand-run `loop session`. Agent
  // children are created lazily, so a fully idle board has none and cannot be
  // relied on to hold the loop. The service manager's KeepAlive / Restart=always
  // is recovery, not residency. `stop()` clears all three synchronously before
  // its first await, so a signalled supervisor still exits once the pool closes.
  let stopPromise = null;
  const stop = () =>
    (stopPromise ??= (async () => {
      // Stop accepting new ticks first, then give the in-flight passes the same
      // bounded drain the daemon gives a continue. A pass that outlives the
      // bound is abandoned: a restart must not wait out a 30-minute turn.
      stopping = true;
      clearInterval(interval);
      clearInterval(questionInterval);
      clearInterval(heartbeat);
      const drainMs =
        Number.isFinite(deps.stopDrainMs) && deps.stopDrainMs >= 0
          ? Number(deps.stopDrainMs)
          : STOP_DRAIN_MS;
      const drained = await Promise.all([
        drainInFlight(inFlightTick, drainMs),
        drainInFlight(inFlightQuestions, drainMs),
      ]);
      if (drained.includes(false)) {
        log(`session: an in-flight pass outlived ${drainMs}ms — stopping anyway`, {
          level: "warn",
          event: "stop_drain_timeout",
        });
      }
      await pool.stop();
      log("session: pool stopped");
    })());
  const signal = deps.signal;
  if (signal !== undefined) {
    if (signal.aborted) await stop();
    else
      signal.addEventListener(
        "abort",
        () => void stop().catch((err) => log(`session: stop failed: ${err.message}`, { level: "error" })),
        { once: true },
      );
  }
  // Without a signal the process stays alive on the interval. With one, the
  // caller (the supervisor's SIGTERM handler) closes the pool cleanly.
  if (signal === undefined) {
    await new Promise(() => {});
  } else {
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    await stop();
  }
  return 0;
}
