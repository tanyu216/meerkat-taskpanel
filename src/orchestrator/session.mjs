/**
 * The resident session pool — the loop's long-lived agent conversations.
 *
 * One **card** session per card — worker or review — plus one **director** lane
 * per project directory for the question lane. The director decision turn runs
 * in the directory's project context; no session spawns another.
 *
 * The pool manager owns the queues, routing, ledger, concurrency, heartbeat,
 * idle eviction and resume. It never talks to the board itself: the supervisor's
 * tick runs `taskctl loop patrol|workflow|poll`, and the poll pass writes the card queue.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { cardFileRel } from "../foundation/card-brief.mjs";
import { DIRECTOR_ACTOR_ID, ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
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
import { buildQuestionPrompt } from "../foundation/scheduling.mjs";
import { createKindPool } from "./kind-session.mjs";
import { agentPaths } from "./options.mjs";
import { readCardForRedispatch, readQuestionOutcome, readRedispatchContext, readRouteOutcome, readTriageOutcome, runCli } from "./runtime.mjs";
import {
  appendWorkerTurn,
  buildWorkerDispatchPrompt,
  buildWorkerReplayPrompt,
  buildWorkerResumePrompt,
  isWorkerKey,
  parseWorkerKey,
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
  POOL_STALE_MS,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
} from "../foundation/loop-state.mjs";
import {
  POOL_HEARTBEAT_MS,
  POOL_STALE_MS,
  SESSION_DEFAULTS,
  SESSION_LOCK_FILE,
} from "../foundation/loop-state.mjs";

/** Actor kinds whose adapter turns `role` into a real tool allowlist. */
const ROLE_ALLOWLIST_KINDS = new Set(["claude", "pi"]);

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
 * Liveness is the pool manager's pid **and** a fresh heartbeat. The heartbeat is
 * written on its own timer, not by `tick()`, so a long turn does not read as a
 * dead pool.
 *
 * @param {{
 *   opts?: object,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 * }} [input]
 * @returns {{
 *   live: boolean,
 *   reason: string|null,
 *   file: string,
 *   poolPid: number|null,
 *   projects: Record<string, object>,
 *   heartbeatAgeMs?: number,
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
  if (poolPid === null || !isAlive(poolPid)) {
    return {
      ...empty,
      verdict: "gone",
      reason: poolPid === null ? "no pool pid" : `pool pid ${poolPid} is gone`,
      projects,
      workers,
      capabilities,
    };
  }
  // A live pid is a live pool. The heartbeat and the in-flight tick decide which
  // *kind* of live it is; neither can turn it into "gone", because a blocked
  // event loop and a three-hour turn both keep the pid. The verdict calls for
  // an operator (or the ping watchdog) instead of letting a second pool start.
  const phase = typeof value.phase === "string" ? value.phase : null;
  const beat = Date.parse(String(value.heartbeatAt ?? ""));
  const heartbeatAgeMs = Number.isFinite(beat) ? Math.max(0, now() - beat) : null;
  const tickStart = Date.parse(String(value.tickStartedAt ?? ""));
  const tickAgeMs = Number.isFinite(tickStart) ? Math.max(0, now() - tickStart) : null;
  const turnMs =
    Number(opts.sessionTurnTimeoutMs) > 0
      ? Number(opts.sessionTurnTimeoutMs)
      : SESSION_DEFAULTS.turnTimeoutMs;
  const base = {
    file,
    poolPid,
    projects,
    workers,
    capabilities,
    phase,
    heartbeatAgeMs,
    tickAgeMs,
  };
  if (phase === "starting") {
    return { ...base, live: true, verdict: "starting", reason: null };
  }
  if (phase === "stopped") {
    return { ...base, live: true, verdict: "stopped", reason: "the pool is stopping" };
  }
  if (tickAgeMs !== null && tickAgeMs > 2 * turnMs) {
    return {
      ...base,
      live: true,
      verdict: "wedged",
      reason: `tick in flight for ${Math.round(tickAgeMs / 1000)}s`,
    };
  }
  if (heartbeatAgeMs === null || heartbeatAgeMs > POOL_STALE_MS) {
    return {
      ...base,
      live: true,
      verdict: "unresponsive",
      reason:
        heartbeatAgeMs === null
          ? "no heartbeat"
          : `heartbeat ${Math.round(heartbeatAgeMs / 1000)}s old`,
    };
  }
  return { ...base, live: true, verdict: "running", reason: null };
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
  const stateRead = readSessionsState(stateDir);
  const state = stateRead.value;
  if (stateRead.error !== null) log(`session: ${stateRead.error} — starting from empty state`);
  let ledger = readLedger(stateDir).value;
  const kindPools = new Map();
  const injectedKindPool = input.kindPool ?? null;
  const injectedKindPools = input.kindPools instanceof Map ? input.kindPools : new Map();
  let started = false;
  // The liveness verdict's two inputs. `phase` is the pool's own lifecycle;
  // `tickStartedAt` is set only while a dispatch tick is in flight, so a turn
  // that legitimately runs for half an hour is not read as a wedged tick.
  let phase = "starting";
  let tickStartedAt = null;
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

  function workerPersistRecord(entry, previous = {}) {
    const worker = entry.worker ?? {};
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
      round: worker.round ?? previous.round ?? 1,
      project: worker.project ?? previous.project ?? null,
      projectDir: worker.projectDir ?? previous.projectDir ?? null,
      agent: worker.agent ?? previous.agent ?? null,
      agentRole: worker.agentRole ?? previous.agentRole ?? null,
      queueId: worker.queueId ?? previous.queueId ?? null,
      sessionId: entry.handle?.sessionId ?? entry.sessionId ?? null,
      pid: entry.handle?.pid ?? null,
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
    const projects = { ...(state.projects ?? {}) };
    for (const [key, entry] of sessions) {
      if (isWorkerKey(key)) {
        projects[key] = workerPersistRecord(entry, projects[key]);
        continue;
      }
      projects[key] = {
        actorKind: entry.actorKind ?? opts.actorKind ?? "claude",
        cwd: entry.cwd,
        sessionId: entry.handle.sessionId ?? entry.sessionId ?? null,
        pid: entry.handle.pid ?? null,
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
      phase,
      tickStartedAt,
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
   * @returns {Promise<{ok: boolean, sent: boolean}>}
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
    const outcome = await entry.handle.send(text, { timeoutMs: turnTimeoutMs });
    if (outcome?.ok !== true) {
      log(
        `session: ${entry.key} skill opener failed (${outcome?.error ?? "unknown"}) — falling back to paths`,
      );
      return { ok: false, sent: true };
    }
    markOpener(entry, opener.fingerprint ?? null);
    log(`session: ${entry.key} opened with ${opener.command}`);
    return { ok: true, sent: true };
  }

  /**
   * Open (or resume/replay) a card's own worker session.
   *
   * @param {string} key
   * @param {{cwd: string, role: string, worker?: {row?: object, workspace?: object|null, forceReplay?: boolean}}} options
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
    const plan =
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
    const resumeId = plan.mode === "resume" ? plan.sessionId ?? null : null;
    const laneRole = options.role === "reviewer" ? "reviewer" : "worker";
    const handle = getKindPool(actorKind).openSession({
      cwd: options.cwd,
      sessionId: resumeId,
      role: laneRole,
      skillPath: options.skillPath ?? null,
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
        typeof stored?.openerFingerprint === "string" ? stored.openerFingerprint : null,
      worker: {
        ...(stored ?? {}),
        kind: "worker-session",
        role: laneRole,
        worktree: options.cwd,
        workspace_created_at:
          worker.workspace?.created_at ?? stored?.workspace_created_at ?? null,
        card,
        round,
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
        resumeState: plan.mode === "replay" ? "resumed_by_replay" : "fresh",
        needsReplay: plan.mode === "replay",
        blocked: false,
        lastResumeAt: stored?.lastResumeAt ?? null,
        lastError: stored?.lastError ?? null,
        lastBoardStatus: stored?.lastBoardStatus ?? null,
      },
    };
    sessions.set(key, entry);
    persistState();
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

  async function closeOlderWorkerGenerations(card, round) {
    for (const entry of [...sessions.values()]) {
      if (!isWorkerKey(entry.key)) continue;
      const parsed = parseWorkerKey(entry.key);
      if (parsed === null || parsed.card !== card || parsed.round >= round) continue;
      await closeEntry(entry, { dropSession: true });
    }
  }

  async function closeEntry(entry, { dropSession = false } = {}) {
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
      };
    }
    persistState();
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
    const questionRows = pending.filter(isQuestionRow);
    const handoffRows = pending.filter((row) => !isQuestionRow(row));
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
        if (Number(card.attempts ?? 0) === 0) {
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
        if (parsed !== null) await closeOlderWorkerGenerations(parsed.card, parsed.round);
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
                      flags:
                        `${row.agent ? `--agent ${row.agent} ` : ""}` +
                        `--actor-kind=${sessionKind}`,
                      fingerprint,
                      skillPath: roleSkillPath,
                    }
                  : null,
              // The adapter receives this only when it loads the skill itself.
              skillPath: skillMode === "inline" ? roleSkillPath : null,
            };
      const openOptions = {
        cwd: dir,
        role: lane === "reviewer" ? "reviewer" : "worker",
        actorKind: cards[0].actor_kind ?? null,
        skillPath: skill?.skillPath ?? null,
        worker: { row: cards[0], workspace: cards[0].workspace ?? null },
      };
      let entry;
      try {
        entry = await ensureSession(key, openOptions);
      } catch (err) {
        if (String(cards[0].role ?? "worker") === "reviewer") {
          // A review has no human to wake; a failed open is retried by the queue
          // on a later tick.
          requeueCards(stateDir, [cards[0].id], { error: err.message });
          log(`session: review ${cards[0].card} could not open a session: ${err.message} — requeued`);
        } else {
          completeCards(stateDir, [cards[0].id], { status: "failed", error: err.message });
          log(`session: worker ${cards[0].card} could not open a session: ${err.message} — failed`);
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
      jobs.push({ key, dir, lane, entry, cards: batch, roleSet, skill });
    }

    // Fan out: each job owns a distinct card session, so no two sends share a
    // handle. Planning and claiming finished before the first send, so the
    // per-tick budget is fixed. Results are applied serially — the ledger and
    // the queue are single files.
    const sendCardJob = async (job) => {
      const row = job.cards[0];
      const plan = job.entry.worker?.planMode ?? "fresh";
      let answer = null;
      if (plan !== "fresh") {
        const context = await readRedispatchContext(opts, row.card, log);
        answer = context.ok === true ? context.answer : null;
      }
      const run = async (entry, planMode) => {
        entry.busy = true;
        entry.worker.status = "running";
        persistState();
        try {
          const opened = await ensureOpener(
            entry,
            job.skill?.opener ?? null,
            job.skill?.fingerprint ?? null,
          );
          const prompt =
            planMode === "replay"
              ? buildWorkerReplayPrompt({
                  row,
                  handoff: row.handoff,
                  reason: entry.worker?.reason,
                  answer,
                  transcript: readWorkerTranscript(stateDir, job.key),
                  nativeError: entry.worker?.lastError,
                })
              : planMode === "resume"
                ? buildWorkerResumePrompt({
                    row,
                    handoff: row.handoff,
                    reason: entry.worker?.reason,
                    answer,
                    sessionId: entry.sessionId,
                  })
                : buildWorkerDispatchPrompt({ row, handoff: row.handoff });
          const fallback =
            opened.ok !== true && typeof job.skill?.path === "string"
              ? `Role skill: ${job.skill.path} — read it before acting.\n\n`
              : "";
          appendWorkerTurn(stateDir, job.key, { kind: "dispatch", text: `${planMode} ${row.card}` });
          return await entry.handle.send(`${fallback}${prompt}`, { timeoutMs: turnTimeoutMs });
        } finally {
          entry.busy = false;
          entry.lastUsedAt = nowIso(now);
        }
      };
      let entry = job.entry;
      let usedPlan = plan;
      let outcome = await run(entry, plan);
      if (outcome?.resumeFailed === true && plan === "resume") {
        await closeEntry(entry, { dropSession: false });
        entry = openSession(job.key, {
          cwd: job.dir,
          role: job.lane === "reviewer" ? "reviewer" : "worker",
          skillPath: job.skill?.skillPath ?? null,
          worker: { row, workspace: row.workspace ?? null, forceReplay: true },
        });
        job.entry = entry;
        usedPlan = "replay";
        outcome = await run(entry, "replay");
        entry.worker.resumeState = "resumed_by_replay";
        persistState();
      }
      return { outcome, plan: usedPlan };
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
        requeueCards(stateDir, batch.map((card) => card.id), { error });
        log(`session: ${lane} turn for ${dir} failed: ${error} — ${batch.length} card(s) requeued`);
        entry.worker.status = "idle";
        entry.worker.lastError = error;
        persistState();
        if (/closed|exited|spawn error|timed out/.test(error)) {
          await closeEntry(entry, { dropSession: false });
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
            requeueCards(stateDir, [row.id], {
              error: "review turn ended without delivering a verdict",
            });
            entry.worker.status = "idle";
            entry.worker.lastError = "review turn ended without delivering a verdict";
            log(`session: review ${row.card} ended without a verdict — requeued`);
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
        dispatched += 1;
        persistState();
        writeLedgerState();
        continue;
      }
      const error = String(outcome?.error ?? `${review ? "review" : "worker"} turn failed`);
      if (plan === "replay" || outcome?.resumeFailed === true) {
        entry.worker.lastError = error;
        if (review) {
          // A review must never park: there is no question lane to release it
          // and no human move to wait for. Drop the dead conversation and let
          // the next tick open a fresh one; the queue's attempt budget bounds it.
          requeueCards(stateDir, [row.id], {
            error: `review session resume/replay failed: ${error}`,
          });
          entry.worker.status = "idle";
          log(`session: review ${row.card} is requeued after a failed resume: ${error}`, {
            level: "error",
          });
          await closeEntry(entry, { dropSession: true });
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
        requeueCards(stateDir, [row.id], { error });
        log(`session: ${review ? "review " : "worker "}${row.card} failed: ${error} — requeued`);
      }
      if (/closed|exited|spawn error|timed out/.test(error)) {
        await closeEntry(entry, { dropSession: false });
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

  function parkCard(ref, reason, blockedReason = "resource") {
    const card = String(ref ?? "");
    if (card === "") return;
    const body = [
      `The loop could not restore this card's worker session (${reason}).`,
      "",
      "It will not be dispatched again automatically. Fix the cause (the agent CLI, the session, the workspace), then move this card back to `todo` or `in_progress`.",
    ].join("\n");
    runCli(
      opts,
      ORCHESTRATOR_ACTOR_ID,
      ["comment", "add", card, "--kind", "question", "--body", body],
      { actorKind: SYSTEM_KIND },
    );
    const moved = runCli(
      opts,
      ORCHESTRATOR_ACTOR_ID,
      ["issue", "move", card, "blocked", "--blocked-reason", blockedReason, "--reason", "the loop stopped dispatching this card"],
      { actorKind: SYSTEM_KIND },
    );
    if (moved.ok !== true) {
      log(`session: could not park ${card}: ${moved.error ?? "unknown error"}`, { level: "warn" });
    }
  }

  /**
   * A crash leaves a worker row `processing` and its session record durable.
   * Return the row to pending **without** an attempt so the next tick resumes
   * the same conversation; a replay or a fresh open is never a second worker.
   */
  async function recoverWorkerSessions() {
    const read = readCards(stateDir);
    if (read.error !== null) return 0;
    const workers = readWorkerSessions(stateDir).workers;
    const ids = [];
    for (const row of read.value.cards) {
      if (row.status !== "processing") continue;
      if (typeof row.worker_key !== "string" || row.worker_key === "") continue;
      const record = workers[row.worker_key];
      if (record === undefined || record.blocked === true) continue;
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
    if (ids.length === 0) return 0;
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
    return resumed.resumed;
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
      const lock = await acquireLock();
      if (!lock.ok) return lock;
      // The startup window is its own verdict: a second pool must not start
      // beside a pool that is still reattaching its sessions.
      phase = "starting";
      persistState();
      started = true;
      await recoverWorkerSessions();
      phase = "running";
      persistState();
      return { ok: true };
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
      for (const entry of [...sessions.values()]) sessions.delete(entry.key);
      persistState();
      releaseLock();
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
 * @param {{log?: (line: string) => void, kindPool?: object, now?: () => number, isAlive?: (pid: number) => boolean, signal?: AbortSignal}} [deps]
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
    return 2;
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
  let ticking = false;
  const interval = setInterval(() => {
    // A turn can outlive many poll intervals; a second concurrent tick would
    // re-read the same queues for no gain.
    if (ticking) return;
    ticking = true;
    pool
      .tick()
      .catch((err) => log(`session: tick failed: ${err.message}`, { level: "error" }))
      .finally(() => {
        ticking = false;
      });
  }, Math.max(50, Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs)));
  // Questions have their own clock. The dispatch tick awaits worker turns, and a
  // worker holding for an answer is exactly when the director lane must still be
  // routed; sharing the tick would serialize the answer behind the very turn it
  // is meant to unblock.
  let routingQuestions = false;
  const questionInterval = setInterval(() => {
    if (routingQuestions) return;
    routingQuestions = true;
    pool
      .routeQuestionsNow()
      .catch((err) => log(`session: question tick failed: ${err.message}`, { level: "error" }))
      .finally(() => {
        routingQuestions = false;
      });
  }, Math.max(50, Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs)));
  // The heartbeat is independent of the tick: while a turn is in flight the
  // state file must still say "the pool is here".
  const heartbeat = setInterval(() => pool.persistState(), POOL_HEARTBEAT_MS);
  // These three timers are the pool's lifetime in every deployment shape: the
  // installed daemon, a `--take-over` pool, and a hand-run `loop session`. Agent
  // children are created lazily, so a fully idle board has none and cannot be
  // relied on to hold the loop. The service manager's KeepAlive / Restart=always
  // is recovery, not residency. `stop()` clears all three synchronously before
  // its first await, so a signalled supervisor still exits once the pool closes.
  let stopPromise = null;
  const stop = () =>
    (stopPromise ??= (async () => {
      clearInterval(interval);
      clearInterval(questionInterval);
      clearInterval(heartbeat);
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
