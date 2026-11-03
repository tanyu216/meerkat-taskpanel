/**
 * The loop's state-file vocabulary, resident-pool defaults and the one liveness
 * verdict.
 *
 * One source for names the orchestrator, the installer's status probe and the
 * loop's own tests read: a rename here changes every reader at once. The values
 * are file names, never paths — `statePathsForDir` joins them onto a directory.
 *
 * `poolVerdict` is the one decision every reader of `sessions.state.json` makes.
 * It takes facts (pid, phase, the three timestamps) and the clock's injected
 * seams, and decides; the caller owns the file I/O. `live` is `verdict !==
 * "gone"`: a stale heartbeat can make a pool unresponsive, never absent.
 *
 * Node builtins only; no I/O beyond the injected `isAlive` check.
 */

import { join } from "node:path";

import { pidAlive, pidMatches } from "./daemon-state.mjs";

/** The files a queue row and the pool's registry live in. */
export const QUEUE_FILES = Object.freeze({
  cards: "cards.queue.json",
  ledger: "subagents.state.json",
  sessions: "sessions.state.json",
  // Per-card worktree/branch records (`orchestrator/workspace.mjs`).
  workspaces: "workspaces.json",
});

/** Every other file the loop keeps beside its state directory. */
export const STATE_FILES = Object.freeze({
  supervisor: "supervisor.state.json",
  log: "supervisor.log",
  continueState: "continue.state.json",
  slaLedger: "sla-ledger.json",
  workflowLedger: "workflow-ledger.json",
  slaLastOk: "loop-patrol-last-ok.json",
  deferrals: "deferrals.json",
  subscribe: "subscribe.state.json",
  sessionLock: "session.lock",
  runLock: "run.lock",
  sessionRecord: "supervisor.session.json",
});

/** Statuses a legacy ledger row may carry while it still claims a concurrency slot. */
export const LIVE_STATUSES = Object.freeze(["spawned", "running", "reattaching"]);

/** The resident pool's defaults; every CLI flag overrides one. */
export const SESSION_DEFAULTS = Object.freeze({
  maxConcurrency: 8,
  projectConcurrency: 8,
  poolMax: 8,
  projectIdleMs: 30 * 60 * 1000,
  sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  turnTimeoutMs: 30 * 60 * 1000,
  pollMs: 1000,
});

/** The pool's exclusive lock, beside the queue files. */
export const SESSION_LOCK_FILE = STATE_FILES.sessionLock;

/**
 * The pool rewrites `sessions.state.json` on this cadence while a turn is in
 * flight, so another process can tell "busy" from "gone".
 */
export const POOL_HEARTBEAT_MS = 15_000;

/**
 * Six missed heartbeats: a live pid with an older heartbeat is *unresponsive*,
 * not gone. Four beats is too tight under load; the heartbeat only separates the
 * kinds of live, never liveness itself.
 */
export const POOL_STALE_MS = 6 * POOL_HEARTBEAT_MS;

/** How long the startup phase may last before it is wedged, not starting. */
export const POOL_START_BUDGET_MS = 5 * 60_000;

/** A tick may outlast its turn by this much before it is wedged. */
export const POOL_WEDGE_MARGIN_MS = 2 * 60_000;

/** The most the background reattach pass may spend, even on a long turn. */
export const POOL_REATTACH_MAX_MS = 2 * 60_000;

/** The six states, in one closed list. */
export const POOL_VERDICTS = Object.freeze([
  "running",
  "busy",
  "starting",
  "unresponsive",
  "wedged",
  "gone",
]);

/**
 * The turn timeout a verdict must use. An absent or invalid value is the
 * documented default, never a second hardcoded threshold.
 *
 * @param {unknown} turnTimeoutMs
 * @returns {number}
 */
export function effectiveTurnTimeoutMs(turnTimeoutMs) {
  const value = Number(turnTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : SESSION_DEFAULTS.turnTimeoutMs;
}

/**
 * When a tick in flight stops being a long turn and becomes a wedge.
 *
 * @param {unknown} turnTimeoutMs
 * @returns {number}
 */
export function sendDeadlineMs(turnTimeoutMs) {
  return effectiveTurnTimeoutMs(turnTimeoutMs) + POOL_WEDGE_MARGIN_MS;
}

/**
 * When an outside authority may act on a wedged pool: after the send has had
 * its own grace. The in-process watchdog (TP-0030) observes only.
 *
 * @param {unknown} turnTimeoutMs
 * @returns {number}
 */
export function killDeadlineMs(turnTimeoutMs) {
  return sendDeadlineMs(turnTimeoutMs) + 60_000;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {number|null}
 */
function ageMs(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const at = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, nowMs - at);
}

/**
 * The pool's one liveness verdict.
 *
 * Six states, and one relation: `live === (verdict !== "gone")`. The heartbeat
 * only decides between `running` and `unresponsive`; a live pid with a stale
 * heartbeat is still a live pool, so a second tick must not start beside it.
 *
 * Order matters: pid liveness, then the startup phase, then the in-flight tick,
 * then the heartbeat. A tick in flight outranks a stale heartbeat, and a
 * `starting` phase inside its budget outranks everything except a dead pid.
 *
 * @param {{
 *   poolPid?: unknown,
 *   poolPidStart?: unknown,
 *   phase?: unknown,
 *   startStartedAt?: unknown,
 *   heartbeatAt?: unknown,
 *   tickStartedAt?: unknown,
 *   turnTimeoutMs?: unknown,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 * }} [input]
 * @returns {{
 *   verdict: "running"|"busy"|"starting"|"unresponsive"|"wedged"|"gone",
 *   live: boolean,
 *   reason: string|null,
 *   phase: string|null,
 *   startAgeMs: number|null,
 *   heartbeatAgeMs: number|null,
 *   tickAgeMs: number|null,
 *   turnTimeoutMs: number,
 *   sendDeadlineMs: number,
 * }}
 */
export function poolVerdict(input = {}) {
  const now = input.now ?? Date.now;
  const isAlive = input.isAlive ?? pidAlive;
  const nowMs = typeof now === "function" ? now() : Number(now);
  const poolPid = integerOrNull(input.poolPid);
  const phase = typeof input.phase === "string" ? input.phase : null;
  const turn = effectiveTurnTimeoutMs(input.turnTimeoutMs);
  const startAge = ageMs(input.startStartedAt, nowMs);
  const heartbeatAge = ageMs(input.heartbeatAt, nowMs);
  const tickAge = ageMs(input.tickStartedAt, nowMs);
  const base = {
    phase,
    startAgeMs: startAge,
    heartbeatAgeMs: heartbeatAge,
    tickAgeMs: tickAge,
    turnTimeoutMs: turn,
    sendDeadlineMs: sendDeadlineMs(turn),
  };

  // Liveness is the pid and its start token. The heartbeat is deliberately not
  // part of this test.
  if (poolPid === null) {
    return { ...base, verdict: "gone", live: false, reason: "no pool pid" };
  }
  if (!pidMatches(poolPid, input.poolPidStart ?? null, { isAlive })) {
    return { ...base, verdict: "gone", live: false, reason: `pool pid ${poolPid} is gone` };
  }

  if (phase === "starting") {
    if (startAge === null || startAge <= POOL_START_BUDGET_MS) {
      return { ...base, verdict: "starting", live: true, reason: null };
    }
    return {
      ...base,
      verdict: "wedged",
      live: true,
      reason: `starting for ${Math.round(startAge / 1000)}s`,
    };
  }

  if (tickAge !== null) {
    if (tickAge > base.sendDeadlineMs) {
      return {
        ...base,
        verdict: "wedged",
        live: true,
        reason: `tick in flight for ${Math.round(tickAge / 1000)}s`,
      };
    }
    return { ...base, verdict: "busy", live: true, reason: null };
  }

  if (heartbeatAge === null || heartbeatAge > POOL_STALE_MS) {
    return {
      ...base,
      verdict: "unresponsive",
      live: true,
      reason:
        heartbeatAge === null
          ? "no heartbeat"
          : `heartbeat ${Math.round(heartbeatAge / 1000)}s old`,
    };
  }
  return { ...base, verdict: "running", live: true, reason: null };
}

/**
 * The state siblings that live beside `continue.state.json`.
 *
 * @param {string} stateDir
 * @returns {{continueState: string, slaLedger: string, workflowLedger: string, slaLastOk: string, deferrals: string}}
 */
export function statePathsForDir(stateDir) {
  const dir = String(stateDir);
  return {
    continueState: join(dir, STATE_FILES.continueState),
    slaLedger: join(dir, STATE_FILES.slaLedger),
    workflowLedger: join(dir, STATE_FILES.workflowLedger),
    slaLastOk: join(dir, STATE_FILES.slaLastOk),
    deferrals: join(dir, STATE_FILES.deferrals),
  };
}
