/**
 * The resident session pool — the loop's long-lived agent conversations.
 *
 * One **worker** session per card, one **reviewer** session per target
 * directory and one **director** lane per project directory. The director
 * decision turn runs in the directory's project context; reviewer subagents
 * inherit that directory.
 *
 * The pool manager owns the queues, routing, ledger, concurrency, heartbeat,
 * idle eviction and resume. It never talks to the board itself: the supervisor's
 * tick runs `taskctl loop patrol|workflow|poll`, and the poll pass writes the card queue.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { cardFileRel } from "../foundation/card-brief.mjs";
import { ORCHESTRATOR_ACTOR_ID, SYSTEM_KIND } from "../foundation/constants.mjs";
import { acquireFileLock, releaseFileLock } from "../foundation/file-lock.mjs";
import { loadRoles } from "../foundation/roles.mjs";
import { buildQuestionPrompt } from "../foundation/scheduling.mjs";
import { createKindPool } from "./kind-session.mjs";
import { agentPaths } from "./options.mjs";
import { readCardForRedispatch, readQuestionOutcome, readRedispatchContext, readRouteOutcome, runCli } from "./runtime.mjs";
import {
  appendWorkerTurn,
  buildWorkerDispatchPrompt,
  buildWorkerReplayPrompt,
  buildWorkerResumePrompt,
  isWorkerHandoff,
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
  markSubagent,
  prune,
  reap,
  readLedger,
  reattachCandidates,
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

/**
 * A review card is dispatched from its own resident conversation.
 *
 * A subagent inherits its session's permission surface, and the `reviewer` role
 * has no Edit/Write. The worker lane keeps the directory itself as its key, so
 * state written before the split still resumes.
 */
const REVIEWER_KEY_SUFFIX = "#reviewer";

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
 * The session key for a review card's lane. The kind is part of the key when it
 * is known: two reviewer roles on different platforms review in the same
 * directory, and their conversations must not merge.
 */
function reviewerKey(dir, actorKind) {
  return typeof actorKind === "string" && actorKind !== ""
    ? `${dir}${REVIEWER_KEY_SUFFIX}@${actorKind}`
    : `${dir}${REVIEWER_KEY_SUFFIX}`;
}

/** The lane a pool session key belongs to. */
function laneOf(key) {
  if (isWorkerKey(key)) return "worker-session";
  return String(key).includes(REVIEWER_KEY_SUFFIX) ? "reviewer" : "worker";
}

/** The directory a lane key runs in; a worker key carries its cwd on the entry. */
function targetDirOf(key) {
  const value = String(key);
  if (isWorkerKey(value)) return "";
  const index = value.indexOf(REVIEWER_KEY_SUFFIX);
  return index === -1 ? value : value.slice(0, index);
}

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
 * The prompt a reviewer lane gets for a batch of review cards.
 *
 * Review cards are the only lane that still batches: the lane conversation
 * spawns one subagent per card and pairs returned ids positionally. Worker cards
 * run in their own worker session and never enter this prompt.
 *
 * @param {object[]} cards queue rows in dispatch order
 * @param {{roles?: object[]}|null} [roleSet] discovered roles, for a native agent name
 * @returns {string}
 */
export function buildReviewerBatchPrompt(cards, roleSet = null) {
  const first = cards[0] ?? {};
  const project = String(first.project ?? "the project");
  const dir = String(first.target_dir ?? "");
  const roles = Array.isArray(roleSet?.roles) ? roleSet.roles : [];
  const roleFor = (agent) =>
    roles.find((role) => role.agent.toLowerCase() === String(agent ?? "").toLowerCase()) ?? null;
  const named = [];
  for (const card of cards) {
    if (!card.agent_role) continue;
    const role = roleFor(card.agent_role);
    if (role && !named.some((entry) => entry.agent === role.agent)) named.push(role);
  }

  const lines = [
    `You are the reviewer session for ${project} at ${dir}.`,
    "",
    "Review cards in this batch:",
  ];
  if (named.length > 0) {
    lines.push("", "Named role agents (when the actor kind supports them):");
    for (const role of named) {
      lines.push(`  ${role.agent} — spawn as "${role.nativeAgent}" and pass the handoff verbatim.`);
    }
    lines.push(
      "If a named agent is unavailable, spawn the default subagent; the handoff carries the",
      "role workflow it must read.",
    );
  }
  cards.forEach((card, index) => {
    const roleSuffix = card.agent_role ? ` role ${card.agent_role}` : "";
    lines.push(`  ${index + 1}) ${card.card} (${card.role ?? "reviewer"})${roleSuffix} handoff:`);
    for (const line of String(card.handoff ?? "").split("\n")) lines.push(`     ${line}`);
  });
  lines.push(
    "",
    "Spawn exactly one subagent per numbered card, in the exact order listed: the loop pairs",
    "each returned agent id with the card at the same position. Pass the handoff text verbatim.",
    "Do not work the cards yourself. Do not move the cards you spawn. Return after spawning;",
    "record each subagent's agent/session id.",
    "",
    "Do not answer questions and do not move any card. A review ends in a verdict on the",
    "review card; the loop applies it.",
  );
  return lines.join("\n");
}

/** @param {{targetDir: string, subagents: object[]}} input */
function buildReattachPrompt(input) {
  const lines = [
    `You are the reviewer session for ${input.targetDir}.`,
    "The previous process left these review subagents unfinished:",
  ];
  for (const subagent of input.subagents) {
    const card = typeof subagent.card === "string" && subagent.card !== "" ? subagent.card : null;
    lines.push(
      `  - ${subagent.subagentId} (${subagent.role ?? "reviewer"}) card ${card ?? "?"}` +
        (card === null
          ? ""
          : ` — re-read ${cardFileRel(card)} before continuing; never edit it`),
    );
  }
  lines.push(
    "",
    "Reattach each one with the agent kind's native mechanism (Claude: SendMessage with the agent",
    "id; Codex: thread/resume; Pi: subagent resume). Verify side effects before",
    "continuing. If a handle cannot be reattached, say so; do not repeat work blindly.",
  );
  return lines.join("\n");
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
  const stateDir = dirname(String(opts.state));
  // `internal` is the installed supervisor; `external` marks a pool started by a
  // live session (`loop status --take-over`). There is no control turn in either
  // mode: the supervisor's tick runs the passes, the pool dispatches.
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
      role: "worker",
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
      // A takeover marker only: `--control=external` still decides whether the
      // pool's timers keep a signalled process alive. It is not a session.
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
    const handle = getKindPool(actorKind).openSession({
      cwd: options.cwd,
      sessionId: resumeId,
      role: "worker",
    });
    const entry = {
      key,
      cwd: options.cwd,
      role: "worker",
      actorKind,
      handle,
      sessionId: resumeId,
      startedAt: nowIso(now),
      lastUsedAt: nowIso(now),
      busy: false,
      batch: null,
      worker: {
        ...(stored ?? {}),
        kind: "worker-session",
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
      batch: null,
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
        if (eventSession.batch !== null) eventSession.batch.ids.push(event.subagentId);
        else
          log(
            `session: ${eventSession.key} reported subagent ${event.subagentId} with no batch — recording it in the ledger`,
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
    for (const [dir, cards] of groups) {
      // The director lane draws no worker budget, but it is still bounded by the
      // project's concurrency cap: one decision conversation per project must not
      // pile on a project whose workers are already at the limit.
      const project = String(cards[0]?.project ?? cards[0]?.project_dir ?? dir);
      const projectLive = liveSubagents(ledger).filter(
        (subagent) => String(subagent.project ?? subagent.sessionKey ?? "") === project,
      ).length;
      if (projectConcurrency > 0 && projectLive >= projectConcurrency) {
        log(`session: ${project} is at its project cap — leaving ${cards.length} decision row(s) pending`);
        continue;
      }
      // The director lane draws no worker slot, but it is still a session: the
      // pool's global bound applies before a new project lane is opened. A lane
      // that already exists is counted there and stays reachable.
      if (!sessions.has(dir) && poolMax > 0 && sessions.size >= poolMax) {
        log(`session: lane session pool is full (${poolMax}) — leaving ${cards.length} decision row(s) pending`);
        continue;
      }
      const entry = await ensureSession(dir, { cwd: dir, role: "director" });
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
      const roleSet = loadRoles({
        home: opts.home,
        primaryKind: opts.actorKind,
        explicitDir: opts.rolesDir ?? null,
      });
      entry.busy = true;
      let outcome;
      try {
        outcome = await entry.handle.send(
          buildQuestionPrompt(claimed.cards, {
            actorKind: opts.actorKind,
            decisionPolicyPath: roleSet?.decisionPolicy?.path ?? null,
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
    // A live row is either a turn in flight or an orphan. No adapter reports a
    // subagent's end, so age is the only release signal.
    const reaped = reap(ledger, { now: now() });
    ledger = reaped.ledger;
    if (reaped.reaped.length > 0) {
      log(`session: reaped stale ledger row(s): ${reaped.reaped.join(", ")}`);
      writeLedgerState();
    }
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
    // they only gate handoffs for the same card: a worker whose question is
    // still unsettled must not be re-prompted by a second handoff.
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
      // A review card runs in its own conversation: the reviewer subagent
      // inherits that session's tool surface, which has no Write.
      if (String(card.role ?? "worker") === "reviewer") {
        const key = reviewerKey(dir, card.actor_kind ?? null);
        let group = groups.get(key);
        if (group === undefined) {
          group = { key, dir, lane: "reviewer", cards: [] };
          groups.set(key, group);
        }
        group.cards.push(card);
        continue;
      }
      // A worker card is its own top-level session, keyed by card + round.
      // While its question row is open, the director lane owns the card; the
      // handoff waits one tick rather than racing a second writer.
      if (questionCards.has(String(card.card ?? ""))) {
        log(`session: worker ${card.card} has an open question — leaving its handoff pending`);
        continue;
      }
      const key = typeof card.worker_key === "string" && card.worker_key !== ""
        ? card.worker_key
        : workerKey(card.card, roundOf(card));
      groups.set(key, { key, dir, lane: "worker-session", cards: [card] });
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
    // the budget is fixed before any turn starts. `claimedByProject` keeps
    // `--project-concurrency` honest across a project's worktrees and its two
    // lanes, whose turns now overlap.
    let globalBudget = Math.max(0, maxConcurrency - liveSubagents(ledger).length);
    const claimedByProject = new Map();
    const jobs = [];
    for (const { key, dir, lane, cards } of groups.values()) {
      if (globalBudget === 0) {
        log(`session: global concurrency cap reached (${maxConcurrency}) — leaving ${cards.length} card(s) pending`);
        break;
      }
      if (
        lane !== "worker-session" &&
        !sessions.has(key) &&
        [...sessions.keys()].filter((entryKey) => !isWorkerKey(entryKey)).length >=
          poolMax
      ) {
        log(`session: lane session pool is full (${poolMax}) — leaving ${dir} (${lane}) pending`);
        continue;
      }
      // A worker that is still in a turn — including a worker holding on
      // `issue wait` — must not receive a second prompt. The queue row waits;
      // the director's release may have re-claimed the card in the meantime,
      // and `revalidateBatch` drops the row if the worker already moved it.
      if (lane === "worker-session") {
        const existing = sessions.get(key);
        // `busy` is the in-process truth; the persisted `worker.status` can lag
        // a failed turn and must not be used as a lock.
        if (existing?.busy === true) {
          log(`session: worker ${cards[0].card} is still running — leaving its handoff pending`);
          continue;
        }
      }
      if (lane === "worker-session" && !sessions.has(key)) {
        const openWorkers = [...sessions.values()].filter((session) => isWorkerKey(session.key));
        if (openWorkers.length >= maxConcurrency) {
          const victim = openWorkers
            .filter((session) => session.busy !== true && session.worker?.status !== "running")
            .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))[0];
          if (victim === undefined) {
            log(`session: worker session cap reached (${maxConcurrency}) — leaving ${cards[0].card} pending`);
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
      if (lane === "worker-session") {
        const parsed = parseWorkerKey(key);
        if (parsed !== null) await closeOlderWorkerGenerations(parsed.card, parsed.round);
        // A parked worker session must become runnable again once a human has
        // cleared the hold. Without this the stored `blocked` flag outlives the
        // board state and every dispatch throws for ever.
        const stored = state.projects?.[key];
        if (stored?.blocked === true && revalidateCard !== null) {
          const live = await revalidateCard({ card: cards[0].card, row: cards[0] });
          if (live?.ok === true && (live.status === "todo" || live.status === "in_progress")) {
            delete state.projects[key];
            persistState();
            log(
              `session: worker ${cards[0].card} was parked; the board cleared the hold — opening a fresh session`,
            );
          }
        }
      }
      let entry;
      try {
        entry = await ensureSession(key, {
          cwd: dir,
          role: lane === "reviewer" ? "reviewer" : lane === "worker-session" ? "worker" : "project",
          actorKind: cards[0].actor_kind ?? null,
          ...(lane === "worker-session"
            ? { worker: { row: cards[0], workspace: cards[0].workspace ?? null } }
            : {}),
        });
      } catch (err) {
        completeCards(stateDir, [cards[0].id], { status: "failed", error: err.message });
        log(`session: worker ${cards[0].card} could not open a session: ${err.message} — failed`);
        continue;
      }
      const live = liveSubagents(ledger);
      // A project's cards may run in several worktrees; the cap is on the
      // project, not on one directory. A row written before worktrees carries
      // no project and falls back to its session key (the shared directory).
      const project = String(cards[0]?.project ?? cards[0]?.project_dir ?? dir);
      const projectLive =
        live.filter(
          (subagent) =>
            String(subagent.project ?? subagent.projectDir ?? subagent.sessionKey ?? "") === project,
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
      const roleSet = loadRoles({
        home: opts.home,
        primaryKind: opts.actorKind,
        explicitDir: opts.rolesDir ?? null,
      });
      for (const warning of roleSet.warnings) {
        if (loggedRoleWarnings.has(warning)) continue;
        loggedRoleWarnings.add(warning);
        log(`roles: ${warning}`);
      }
      jobs.push({ key, dir, lane, entry, cards: batch, roleSet });
    }

    // Fan out: each job owns a distinct session key, so no two sends share a
    // handle. Planning and claiming finished before the first send, so the
    // per-tick budget is fixed. Results are applied serially — the ledger and
    // the queue are single files.
    const sendWorkerJob = async (job) => {
      const row = job.cards[0];
      const plan = job.entry.worker?.planMode ?? "fresh";
      let answer = null;
      if (plan !== "fresh") {
        const context = await readRedispatchContext(opts, row.card, log);
        answer = context.ok === true ? context.answer : null;
      }
      const run = async (entry, planMode) => {
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
        appendWorkerTurn(stateDir, job.key, { kind: "dispatch", text: `${planMode} ${row.card}` });
        entry.busy = true;
        entry.worker.status = "running";
        persistState();
        try {
          return await entry.handle.send(prompt, { timeoutMs: turnTimeoutMs });
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
          role: "worker",
          worker: { row, workspace: row.workspace ?? null, forceReplay: true },
        });
        job.entry = entry;
        usedPlan = "replay";
        outcome = await run(entry, "replay");
        entry.worker.resumeState = "resumed_by_replay";
        persistState();
      }
      return { outcome, ids: [], plan: usedPlan };
    };
    const settled = await Promise.allSettled(
      jobs.map(async (job) => {
        if (job.lane === "worker-session") return sendWorkerJob(job);
        job.entry.batch = { cards: job.cards, ids: [] };
        job.entry.busy = true;
        let outcome;
        try {
          outcome = await job.entry.handle.send(
            buildReviewerBatchPrompt(job.cards, job.roleSet),
            { timeoutMs: turnTimeoutMs },
          );
        } finally {
          job.entry.busy = false;
          job.entry.lastUsedAt = nowIso(now);
        }
        const ids =
          job.entry.batch.ids.length > 0
            ? job.entry.batch.ids.slice()
            : Array.isArray(outcome?.ids)
              ? outcome.ids.slice()
              : [];
        job.entry.batch = null;
        return { outcome, ids };
      }),
    );

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const { dir, lane, entry, cards: batch } = job;
      const settledJob = settled[index];
      if (settledJob.status === "rejected") {
        const error = String(settledJob.reason?.message ?? settledJob.reason ?? "project turn failed");
        requeueCards(stateDir, batch.map((card) => card.id), { error });
        log(`session: ${lane} turn for ${dir} failed: ${error} — ${batch.length} card(s) requeued`);
        if (isWorkerKey(entry.key)) {
          entry.worker.status = "idle";
          entry.worker.lastError = error;
          persistState();
        }
        if (/closed|exited|spawn error|timed out/.test(error)) {
          await closeEntry(entry, { dropSession: false });
        }
        continue;
      }
      const { outcome, ids, plan = null } = settledJob.value;
      if (lane === "worker-session") {
        const row = batch[0];
        if (outcome?.ok === true) {
          appendWorkerTurn(stateDir, job.key, { kind: "result", text: String(outcome.result ?? "") });
          ledger = upsertSubagent(ledger, {
            sessionKey: job.key,
            lane: "worker",
            actorKind: opts.actorKind,
            subagentId: entry.sessionId,
            role: "worker",
            card: row.card,
            type: "worker-session",
            status: "completed",
            lastResult: "worker session turn completed",
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
        const error = String(outcome?.error ?? "worker turn failed");
        if (plan === "replay" || outcome?.resumeFailed === true) {
          entry.worker.status = "stale";
          entry.worker.blocked = true;
          entry.worker.lastError = error;
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
            log(`session: worker ${row.card} is ${live.status} after a failed turn — handoff completed`);
          }
        }
        if (stillWorkable) {
          requeueCards(stateDir, [row.id], { error });
          log(`session: worker ${row.card} failed: ${error} — requeued`);
        }
        if (/closed|exited|spawn error|timed out/.test(error)) {
          await closeEntry(entry, { dropSession: false });
        }
        // The turn settled; the record must not keep saying `running` (a failed
        // turn is retried on the next tick, and the guard reads `busy`).
        entry.worker.status = "idle";
        entry.worker.lastError = error;
        persistState();
        continue;
      }
      if (outcome?.ok !== true) {
        // A failed (often timed-out) turn is not proof the work is unfinished:
        // the worker may have delivered just before the interrupt. Re-check each
        // card and only requeue the ones still claimable.
        const retry = [];
        for (const card of batch) {
          if (revalidateCard === null) {
            retry.push(card);
            continue;
          }
          const live = await revalidateCard({ card: card.card, row: card });
          if (live?.ok === true && live.status !== "todo" && live.status !== "in_progress") {
            completeCards(stateDir, [card.id], {
              status: "done",
              error: `not re-dispatched: card is ${live.status}`,
            });
            log(`session: ${card.card} is ${live.status} after a failed turn — handoff completed`);
            continue;
          }
          retry.push(card);
        }
        if (retry.length > 0) {
          requeueCards(stateDir, retry.map((card) => card.id), {
            error: outcome?.error ?? "project turn failed",
          });
        }
        log(
          `session: ${lane} turn for ${dir} failed: ${outcome?.error ?? "unknown error"} — ` +
            `${retry.length} card(s) requeued`,
        );
        if (/closed|exited|spawn error|timed out/.test(String(outcome?.error ?? ""))) {
          await closeEntry(entry, { dropSession: false });
        }
        continue;
      }
      let matched = 0;
      batch.forEach((card, cardIndex) => {
        const subagentId = ids[cardIndex];
        if (subagentId === undefined) return;
        matched += 1;
        ledger = upsertSubagent(ledger, {
          sessionKey: dir,
          lane,
          actorKind: opts.actorKind,
          subagentId,
          role: card.role ?? "worker",
          agentRole: card.agent_role ?? null,
          card: card.card,
          type: "subagent",
          status: "completed",
          lastResult: `${lane} session turn completed`,
          queueId: card.id,
          project: card.project ?? null,
          projectDir: card.project_dir ?? dir,
          workspace: card.workspace ?? null,
        });
        completeCards(stateDir, [card.id]);
      });
      for (const extra of ids.slice(batch.length)) {
        ledger = upsertSubagent(ledger, {
          sessionKey: dir,
          lane,
          actorKind: opts.actorKind,
          subagentId: extra,
          status: "completed",
        });
      }
      const unmatched = batch.slice(matched);
      if (unmatched.length > 0) {
        // A successful turn that reports no id for a card is ambiguous: the
        // adapter only captures ids from a tool result, and the session may
        // also stand down when the lane already holds the card. Ask the board,
        // which owns the fact: a card that left `todo` got its handoff, so
        // retrying it would put a second worker on the same card.
        const requeue = [];
        let inFlight = 0;
        for (const card of unmatched) {
          if (revalidateCard === null) {
            requeue.push(card);
            continue;
          }
          const live = await revalidateCard({ card: card.card, row: card });
          if (live?.ok === true && typeof live.status === "string" && live.status !== "todo") {
            completeCards(stateDir, [card.id], { status: "done", error: "handoff already in flight" });
            inFlight += 1;
            log(`session: ${card.card} is ${live.status} with no reported subagent id — handoff already in flight`);
            continue;
          }
          requeue.push(card);
        }
        if (requeue.length > 0) {
          requeueCards(stateDir, requeue.map((card) => card.id), {
            error: `reviewer session reported ${ids.length} subagent(s) for ${batch.length} card(s)`,
          });
        }
        log(
          `session: ${dir} reported ${ids.length} subagent(s) for ${batch.length} card(s) — ` +
            `${inFlight} already in flight, ${requeue.length} requeued`,
        );
      }
      dispatched += matched;
      writeLedgerState();
      persistState();
    }
    ledger = prune(ledger, { now: now() });
    writeLedgerState();
    return { ok: true, dispatched };
  }

  async function evictIdle() {
    const live = liveSubagents(ledger);
    for (const entry of [...sessions.values()]) {
      if (entry.busy === true || entry.batch !== null) continue;
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
      const dir = targetDirOf(entry.key);
      const lane = laneOf(entry.key);
      const held = live.some(
        (subagent) =>
          String(subagent.sessionKey ?? "") === dir &&
          String(subagent.lane ?? (String(subagent.role ?? "") === "reviewer" ? "reviewer" : "worker")) === lane,
      );
      if (held) continue;
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

  async function reattachOnStart() {
    const groups = new Map();
    let staleWorkers = 0;
    for (const subagent of reattachCandidates(ledger)) {
      const dir = String(subagent.sessionKey ?? "");
      if (dir === "" || !existsSync(dir)) {
        ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        continue;
      }
      // Only reviewer subagents are reattached. A worker card resumes through
      // its own worker session; an old worker subagent row is stale history and
      // would only pin a concurrency slot.
      const lane = String(
        subagent.lane ?? (String(subagent.role ?? "") === "reviewer" ? "reviewer" : "worker"),
      );
      if (lane !== "reviewer") {
        ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        staleWorkers += 1;
        continue;
      }
      const key = reviewerKey(dir, subagent.actorKind ?? null);
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, dir, lane, subagents: [] };
        groups.set(key, group);
      }
      group.subagents.push(subagent);
    }
    if (staleWorkers > 0) {
      writeLedgerState();
      log(`session: marked ${staleWorkers} legacy worker subagent(s) stale — their cards resume as worker sessions`, {
        level: "debug",
      });
    }
    for (const { key, dir, lane, subagents } of groups.values()) {
      const entry = await ensureSession(key, { cwd: dir, role: "reviewer" });
      entry.busy = true;
      let outcome;
      try {
        outcome = await entry.handle.send(buildReattachPrompt({ targetDir: dir, subagents }), {
          timeoutMs: turnTimeoutMs,
        });
      } finally {
        entry.busy = false;
        entry.lastUsedAt = nowIso(now);
      }
      if (outcome?.ok === true) {
        log(`session: reattach prompt sent for ${dir} (${lane}, ${subagents.length} subagent(s))`);
      } else {
        for (const subagent of subagents) {
          ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        }
        log(`session: reattach failed for ${dir} (${lane}): ${outcome?.error ?? "unknown error"} — marked stale`);
      }
      writeLedgerState();
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
        if (row !== undefined) parkCard(row.card, "repeated crash recoveries");
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
      await reattachOnStart();
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
        byResumeState: { fresh: 0, resumed: 0, resumed_by_replay: 0, stale: 0 },
      };
      for (const entry of workerEntries) {
        const status = String(entry.worker?.status ?? "idle");
        if (Object.hasOwn(workerState, status)) workerState[status] += 1;
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
  // install is a hard error, not a session that silently cannot work.
  const paths = agentPaths(opts.home ?? homedir(), opts.actorKind ?? "claude");
  const missing = [paths.directorSkill, paths.boardSkill].filter(
    (dir) => !existsSync(join(dir, "SKILL.md")),
  );
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
  // In external (take-over) mode no long-lived agent holds the event loop, so the
  // timers are the process's only handles: unref'd, the pool would exit the
  // moment it started and `--take-over` would never see it. The internal pool
  // has an agent process; unref'ing there lets a signalled
  // supervisor exit once that child closes.
  if (opts.control !== "external") {
    interval.unref?.();
    questionInterval.unref?.();
    heartbeat.unref?.();
  }
  const stop = async () => {
    clearInterval(interval);
    clearInterval(questionInterval);
    clearInterval(heartbeat);
    await pool.stop();
    log("session: pool stopped");
  };
  const signal = deps.signal;
  if (signal !== undefined) {
    if (signal.aborted) await stop();
    else signal.addEventListener("abort", () => void stop(), { once: true });
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
