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
  // Ping-owned: the last wedge it acted on (`wedgedKillAt`). Kept out of
  // `sessions.state.json` because the pool's heartbeat rewrites that file.
  poolWedge: "pool-wedge.json",
  // The long-lived entries' boot ledger: the last start, the last crash, the
  // recent starts and the consecutive boot-failure streak (`orchestrator/
  // boot-health.mjs`). One record per state directory, because one supervisor
  // runs per machine.
  health: "supervisor.health.json",
  // The ping's board-liveness streak (`orchestrator/runtime.mjs`). The installed
  // ping is one-shot, so the consecutive `/health` failure count has to outlive
  // the process that measured it.
  boardHealth: "board-health.json",
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

/**
 * The grace an outside authority gives a wedged phase before it acts. The
 * verdict calls a phase `wedged` at its deadline; the ping waits one more
 * minute so a legitimate turn that is merely finishing is never killed.
 */
export const POOL_KILL_GRACE_MS = 60_000;

/**
 * How long a shutdown waits for an in-flight pass before it exits anyway. The
 * daemon's SIGTERM handler and `runSession.stop()` share this bound: a service
 * manager gives a few seconds, not the turn timeout, and one stuck continue
 * must not delay a restart.
 */
export const STOP_DRAIN_MS = 10_000;

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
 * its own grace. The ping clock is the only authority that reads it; no
 * in-process timer acts on a pool.
 *
 * @param {unknown} turnTimeoutMs
 * @returns {number}
 */
export function killDeadlineMs(turnTimeoutMs) {
  return sendDeadlineMs(turnTimeoutMs) + POOL_KILL_GRACE_MS;
}

/**
 * When the outside authority may act on a pool stuck in the starting phase.
 *
 * @returns {number}
 */
export function startKillDeadlineMs() {
  return POOL_START_BUDGET_MS + POOL_KILL_GRACE_MS;
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

/** A timestamp as canonical ISO, or `null` when it is not a time. */
function isoOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const at = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * The ping's one kill decision — the only authority allowed to stop a pool.
 *
 * A phase is *wedged* at its deadline (the same threshold `poolVerdict` uses);
 * the ping acts only after one more `POOL_KILL_GRACE_MS`, so a turn that is
 * merely finishing is never killed. The two phases have separate deadlines:
 * the starting phase at `POOL_START_BUDGET_MS` and a tick in flight at
 * `sendDeadlineMs`. `lastTickOkAt` is deliberately not an input: a fast-failing
 * tick is degraded, not wedged.
 *
 * The marker makes the decision act at most once per wedge. A wedge's identity
 * is the pool (`poolPid` + start token) and the phase timestamp; a restarted
 * pool or a new phase is a new wedge, so a stale marker never applies. The
 * first due ping returns `sigterm`; a later ping for the same live wedge
 * returns `sigkill`, and after that the wedge is closed.
 *
 * @param {{
 *   poolPid?: unknown,
 *   poolPidStart?: unknown,
 *   phase?: unknown,
 *   startStartedAt?: unknown,
 *   tickStartedAt?: unknown,
 *   turnTimeoutMs?: unknown,
 *   marker?: object|null,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 * }} [input]
 * @returns {{
 *   action: "none"|"sigterm"|"sigkill",
 *   reason: string,
 *   poolPid: number|null,
 *   phase: "starting"|"tick"|null,
 *   startedAt: string|null,
 *   ageMs: number|null,
 *   deadlineMs: number|null,
 *   marker: object|null,
 * }}
 */
export function wedgeKillAction(input = {}) {
  const now = input.now ?? Date.now;
  const isAlive = input.isAlive ?? pidAlive;
  const nowMs = typeof now === "function" ? now() : Number(now);
  const poolPid = integerOrNull(input.poolPid);
  const poolPidStart = input.poolPidStart ?? null;
  const marker = input.marker !== null && typeof input.marker === "object" ? input.marker : null;
  const none = (reason, extra = {}) => ({
    action: "none",
    reason,
    poolPid: poolPid ?? null,
    phase: null,
    startedAt: null,
    ageMs: null,
    deadlineMs: null,
    marker: null,
    ...extra,
  });

  if (poolPid === null || !pidMatches(poolPid, poolPidStart, { isAlive })) {
    return none("the pool is gone");
  }

  // The starting phase is the stronger fact: a pool that has not finished
  // starting has no tick to judge.
  let wedge;
  let rawStartedAt;
  let phaseDeadline;
  if (input.phase === "starting") {
    wedge = "starting";
    rawStartedAt = input.startStartedAt;
    phaseDeadline = POOL_START_BUDGET_MS;
  } else {
    wedge = "tick";
    rawStartedAt = input.tickStartedAt;
    phaseDeadline = sendDeadlineMs(input.turnTimeoutMs);
  }
  const startedAt = isoOf(rawStartedAt);
  const age = ageMs(rawStartedAt, nowMs);
  if (age === null || startedAt === null) {
    return none(
      wedge === "tick"
        ? "no tick in flight; lastTickOkAt is not a kill signal"
        : "no start time; the deadline cannot be proven",
    );
  }
  const deadlineMs = phaseDeadline + POOL_KILL_GRACE_MS;
  if (age <= phaseDeadline) {
    return none("inside the phase deadline", { phase: wedge, startedAt, ageMs: age, deadlineMs });
  }
  if (age <= deadlineMs) {
    return none("inside the 60 s grace", { phase: wedge, startedAt, ageMs: age, deadlineMs });
  }

  const identity = { poolPid, poolPidStart, phase: wedge, startedAt };
  const sameWedge =
    marker !== null &&
    Number(marker.poolPid) === poolPid &&
    String(marker.poolPidStart ?? "") === String(poolPidStart ?? "") &&
    marker.phase === wedge &&
    marker.startedAt === startedAt;
  if (sameWedge) {
    if (typeof marker.wedgedSigkillAt === "string" && marker.wedgedSigkillAt !== "") {
      return none("already killed", { phase: wedge, startedAt, ageMs: age, deadlineMs });
    }
    const killedAt = Date.parse(String(marker.wedgedKillAt ?? ""));
    if (Number.isFinite(killedAt) && nowMs <= killedAt) {
      return none("waiting for the next ping", { phase: wedge, startedAt, ageMs: age, deadlineMs });
    }
    return {
      action: "sigkill",
      reason: `still alive ${Math.round(age / 1000)}s into the ${wedge} wedge`,
      poolPid,
      phase: wedge,
      startedAt,
      ageMs: age,
      deadlineMs,
      marker: {
        ...identity,
        wedgedKillAt: marker.wedgedKillAt,
        wedgedSigkillAt: new Date(nowMs).toISOString(),
      },
    };
  }

  return {
    action: "sigterm",
    reason: `${wedge} wedge for ${Math.round(age / 1000)}s`,
    poolPid,
    phase: wedge,
    startedAt,
    ageMs: age,
    deadlineMs,
    marker: { ...identity, wedgedKillAt: new Date(nowMs).toISOString() },
  };
}

/**
 * The state siblings that live beside `continue.state.json`.
 *
 * @param {string} stateDir
 * @returns {{continueState: string, slaLedger: string, workflowLedger: string, slaLastOk: string, deferrals: string, poolWedge: string, health: string}}
 */
export function statePathsForDir(stateDir) {
  const dir = String(stateDir);
  return {
    continueState: join(dir, STATE_FILES.continueState),
    slaLedger: join(dir, STATE_FILES.slaLedger),
    workflowLedger: join(dir, STATE_FILES.workflowLedger),
    slaLastOk: join(dir, STATE_FILES.slaLastOk),
    deferrals: join(dir, STATE_FILES.deferrals),
    poolWedge: join(dir, STATE_FILES.poolWedge),
    health: join(dir, STATE_FILES.health),
    boardHealth: join(dir, STATE_FILES.boardHealth),
  };
}
