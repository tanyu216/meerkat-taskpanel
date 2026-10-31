/**
 * The resident session pool — the loop's long-lived agent conversations.
 *
 * One **control** session runs the board-wide continue turn (cwd = the
 * taskpanel checkout). One **project** session per `target_dir` runs the
 * per-project spawn turn (cwd = that directory), so the worker/reviewer
 * subagents it spawns inherit the project directory.
 *
 * The pool manager owns the queues, routing, ledger, concurrency, heartbeat,
 * idle eviction and resume. It never talks to the board itself: the control
 * turn runs `taskctl loop patrol|workflow|poll`, and the poll pass writes the card queue.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { cardFileRel } from "../foundation/card-brief.mjs";
import { renderOwnershipGuide } from "../foundation/role-prompt.mjs";
import { loadRoles } from "../foundation/roles.mjs";
import { buildContinuePrompt, buildQuestionPrompt } from "../foundation/scheduling.mjs";
import { createKindPool } from "./kind-session.mjs";
import { agentPaths, loopBoardCommand, loopCliCommand } from "./options.mjs";
import { readCardForRedispatch, readRedispatchContext } from "./runtime.mjs";
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
  claimContinue,
  completeCards,
  completeContinue,
  ensureStateDir,
  pruneCards,
  readCards,
  readContinue,
  readJsonFile,
  recoverStaleCards,
  requeueCards,
  requeueContinue,
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
export const REVIEWER_KEY_SUFFIX = "#reviewer";

/** Actor kinds whose adapter turns `role` into a real tool allowlist. */
const ROLE_ALLOWLIST_KINDS = new Set(["claude", "pi"]);

/** Questions answered in one project-session turn. */
const QUESTION_BATCH_MAX = 8;

/** A queue row on the question lane (everything else is a card handoff). */
const isQuestionRow = (row) => String(row?.queue_kind ?? "handoff") === "question";

/** The session key for a review card's lane. */
export function reviewerKey(dir) {
  return `${dir}${REVIEWER_KEY_SUFFIX}`;
}

/** The lane a pool session key belongs to. */
export function laneOf(key) {
  if (isWorkerKey(key)) return "worker-session";
  return String(key).endsWith(REVIEWER_KEY_SUFFIX) ? "reviewer" : "worker";
}

/** The directory a lane key runs in; a worker key carries its cwd on the entry. */
export function targetDirOf(key) {
  const value = String(key);
  if (isWorkerKey(value)) return "";
  return laneOf(value) === "reviewer" ? value.slice(0, -REVIEWER_KEY_SUFFIX.length) : value;
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
  const empty = { version: 3, control: null, projects: {} };
  const read = readJsonFile(sessionsFile(stateDir), empty);
  if (read.error !== null) return { value: { ...empty }, error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  return {
    // v1/v2 files are read as the same {control, projects} shape; the version is
    // informational, not a gate. v3 adds `worker:` records to `projects`.
    value: {
      version: 3,
      control: value.control ?? null,
      projects: value.projects && typeof value.projects === "object" ? value.projects : {},
    },
    error: null,
  };
}

/**
 * Is a resident pool running? The answer lives in `sessions.state.json`, so a
 * pass in another process (the control session's `passes.mjs poll`) asks the
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
 *   control: object|null,
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
    reason: null,
    file,
    poolPid: null,
    control: null,
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
  const control = value.control ?? null;
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
      reason: poolPid === null ? "no pool pid" : `pool pid ${poolPid} is gone`,
      control,
      projects,
      workers,
      capabilities,
    };
  }
  const beat = Date.parse(String(value.heartbeatAt ?? ""));
  if (!Number.isFinite(beat)) {
    return { ...empty, reason: "no heartbeat", poolPid, control, projects, workers, capabilities };
  }
  const age = now() - beat;
  if (age > POOL_STALE_MS) {
    return {
      ...empty,
      reason: `heartbeat ${Math.round(age / 1000)}s old`,
      poolPid,
      control,
      projects,
      workers,
      capabilities,
    };
  }
  return {
    live: true,
    reason: null,
    file,
    poolPid,
    control,
    projects,
    workers,
    capabilities,
    heartbeatAgeMs: Math.max(0, age),
  };
}

/**
 * @param {object[]} cards
 * @param {{roles?: object[]}|null} [roleSet] the effective team, when one exists
 * @param {{lane?: "worker"|"reviewer"}} [options]
 */
export function buildProjectBatchPrompt(cards, roleSet = null, options = {}) {
  const lane = options.lane === "reviewer" ? "reviewer" : "worker";
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
    lane === "reviewer"
      ? `You are the reviewer session for ${project} at ${dir}.`
      : `You are the project session for ${project} at ${dir}.`,
    "",
    lane === "reviewer" ? "Review cards in this batch:" : "Claimed cards in this batch:",
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
  if (lane === "worker" && roleSet?.ownership?.path) {
    lines.push("", ...renderOwnershipGuide(roleSet.ownership));
  }
  cards.forEach((card, index) => {
    const roleSuffix = card.agent_role ? ` role ${card.agent_role}` : "";
    lines.push(`  ${index + 1}) ${card.card} (${card.role ?? "worker"})${roleSuffix} handoff:`);
    for (const line of String(card.handoff ?? "").split("\n")) lines.push(`     ${line}`);
  });
  lines.push(
    "",
    "Spawn exactly one subagent per numbered card, in the exact order listed: the loop pairs",
    "each returned agent id with the card at the same position. Pass the handoff text verbatim.",
    "Do not work the cards yourself. Do not move the cards you spawn. Return after spawning;",
    "record each subagent's agent/session id.",
  );
  if (lane === "worker") {
    lines.push(
      "",
      "Subagent questions: read agent-authored `question` comments on in_progress cards.",
      "Answer a question you can decide with a note, then reattach the subagent or move the card",
      "to todo; if you cannot decide, escalate E1-E5 to the human with awaiting. Never write a",
      "decision kind and never use --as-human for your own decision.",
    );
  } else {
    lines.push(
      "",
      "Do not answer questions and do not move any card. A review ends in a verdict on the",
      "review card; the loop applies it.",
    );
  }
  return lines.join("\n");
}

/** @param {{targetDir: string, subagents: object[], lane?: "worker"|"reviewer"}} input */
export function buildReattachPrompt(input) {
  const lane = input.lane === "reviewer" ? "reviewer" : "worker";
  const lines = [
    lane === "reviewer"
      ? `You are the reviewer session for ${input.targetDir}.`
      : `You are the project session for ${input.targetDir}.`,
    "The previous process left these subagents unfinished:",
  ];
  for (const subagent of input.subagents) {
    const card = typeof subagent.card === "string" && subagent.card !== "" ? subagent.card : null;
    lines.push(
      `  - ${subagent.subagentId} (${subagent.role ?? "worker"}) card ${card ?? "?"}` +
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
  const stateDir = dirname(String(opts.state));
  // `internal` is the installed supervisor: the pool owns the control turn. In
  // `external` mode a live /meerkat-loop session is the control; the pool keeps
  // only the project sessions and the card queue (one dispatcher, two drivers).
  const controlMode = opts.control === "external" ? "external" : "internal";
  const maxConcurrency = Number(opts.maxConcurrency ?? SESSION_DEFAULTS.maxConcurrency);
  const projectConcurrency = Number(opts.projectConcurrency ?? SESSION_DEFAULTS.projectConcurrency);
  const poolMax = Number(opts.sessionPoolMax ?? SESSION_DEFAULTS.poolMax);
  const projectIdleMs = Number(opts.projectIdleMs ?? SESSION_DEFAULTS.projectIdleMs);
  const sessionMaxAgeMs = Number(opts.sessionMaxAgeMs ?? SESSION_DEFAULTS.sessionMaxAgeMs);
  const turnTimeoutMs = Number(opts.sessionTurnTimeoutMs ?? SESSION_DEFAULTS.turnTimeoutMs);
  const pollMs = Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs);

  const sessions = new Map();
  const stateRead = readSessionsState(stateDir);
  const state = stateRead.value;
  if (stateRead.error !== null) log(`session: ${stateRead.error} — starting from empty state`);
  let ledger = readLedger(stateDir).value;
  let control = null;
  let kindPool = input.kindPool ?? null;
  let started = false;
  let warnedReviewerAllowlist = false;

  const getKindPool = () => {
    if (kindPool === null) {
      kindPool = createKindPool({ actorKind: opts.actorKind, opts, log, onEvent: handleEvent });
    }
    return kindPool;
  };

  function workerPersistRecord(entry, previous = {}) {
    const worker = entry.worker ?? {};
    return {
      ...previous,
      kind: "worker-session",
      actorKind: opts.actorKind ?? "claude",
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
      if (key === "control") continue;
      if (isWorkerKey(key)) {
        projects[key] = workerPersistRecord(entry, projects[key]);
        continue;
      }
      projects[key] = {
        actorKind: opts.actorKind ?? "claude",
        cwd: entry.cwd,
        sessionId: entry.handle.sessionId ?? entry.sessionId ?? null,
        pid: entry.handle.pid ?? null,
        startedAt: entry.startedAt,
        lastHeartbeatAt: nowIso(now),
        lastUsedAt: entry.lastUsedAt,
        closedAt: null,
      };
    }
    const controlEntry = sessions.get("control") ?? null;
    const next = {
      // 3 — worker sessions. The question lane is unchanged; a poll from this
      // release only enqueues question rows when the live pool advertises the
      // capability, and worker rows carry their own `worker:` session key.
      version: 3,
      capabilities: ["question-lane", "worker-sessions"],
      // The pool manager's own pid, not an agent child's: an orphaned agent process
      // would otherwise keep answering "resident" after its manager died.
      poolPid: process.pid,
      heartbeatAt: nowIso(now),
      controlMode,
      control: controlMode === "external"
        ? null
        : controlEntry
        ? {
            actorKind: opts.actorKind ?? "claude",
            cwd: controlEntry.cwd,
            sessionId: controlEntry.handle.sessionId ?? controlEntry.sessionId ?? null,
            pid: controlEntry.handle.pid ?? null,
            startedAt: controlEntry.startedAt,
            lastHeartbeatAt: nowIso(now),
            lastUsedAt: controlEntry.lastUsedAt,
            closedAt: null,
          }
        : state.control ?? null,
      projects,
    };
    state.control = next.control;
    state.projects = projects;
    const written = writeJsonFile(sessionsFile(stateDir), next);
    if (!written.ok) log(`session: could not write state: ${written.error}`);
    return written.ok;
  };

  /** @param {string} key */
  function storedSession(key) {
    if (key === "control") return state.control ?? null;
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
    const plan =
      worker.forceReplay === true
        ? {
            mode: "replay",
            generation: Number(stored?.generation ?? 1),
            reason: "native resume failed",
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
    const handle = getKindPool().openSession({
      cwd: options.cwd,
      sessionId: resumeId,
      role: "worker",
    });
    const entry = {
      key,
      cwd: options.cwd,
      role: "worker",
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
    const storedAge =
      stored?.startedAt === undefined ? Number.POSITIVE_INFINITY : now() - Date.parse(String(stored.startedAt));
    const resumeId =
      options.sessionId !== undefined && options.sessionId !== null
        ? options.sessionId
        : storedAge < sessionMaxAgeMs
          ? stored?.sessionId ?? null
          : null;
    const handle = getKindPool().openSession({ cwd: options.cwd, sessionId: resumeId, role: options.role });
    const entry = {
      key,
      cwd: options.cwd,
      role: options.role,
      handle,
      sessionId: resumeId,
      startedAt: nowIso(now),
      lastUsedAt: nowIso(now),
      busy: false,
      batch: null,
    };
    sessions.set(key, entry);
    if (key === "control") control = entry;
    else if (options.sessionId === undefined && storedAge >= sessionMaxAgeMs && stored !== null) {
      // A fresh conversation supersedes the expired handle; do not resume it.
      delete state.projects[key];
    }
    persistState();
    log(
      `session: opened ${key === "control" ? "control" : key} (cwd=${options.cwd}` +
        `${resumeId === null ? ", fresh" : `, resume=${resumeId}`})`,
    );
    return entry;
  }

  /** @param {string} key @param {{cwd: string, role: string}} options */
  async function ensureSession(key, options) {
    const entry = sessions.get(key) ?? openSession(key, options);
    if (entry.handle.closed === true) {
      sessions.delete(key);
      if (key === "control") control = null;
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
    if (entry.key === "control") {
      control = null;
      if (dropSession) state.control = null;
    } else if (dropSession) {
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

  async function continueTurn() {
    // The live session owns the control turn in external mode; consuming
    // continue.pending here would run a second, headless control.
    if (controlMode === "external") return { ok: true, skipped: "external control" };
    if (control?.busy === true) return { ok: true, skipped: "control busy" };
    const paths = readContinue(stateDir);
    if (paths.pending === null) return { ok: true, skipped: "no pending continue" };
    const claimed = claimContinue(stateDir);
    if (claimed.request === null) return { ok: true, skipped: "already claimed" };
    const entry = await ensureSession("control", { cwd: opts.repo ?? process.cwd(), role: "control" });
    entry.busy = true;
    const agentFiles = agentPaths(opts.home, opts.actorKind);
    const roleSet = opts.roles ?? loadRoles({
      explicitDir: opts.rolesDir ?? null,
      loopSkillDir: agentFiles.loopSkill,
    });
    const controlAgent = Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : "agent";
    const prompt = buildContinuePrompt({
      actorKind: opts.actorKind,
      agent: controlAgent,
      cliCommand: loopCliCommand(opts),
      boardCommand: loopBoardCommand(opts),
      continueIntervalSeconds: opts.continueInterval,
      openedBy: opts.openedBy,
      decisionPolicy: roleSet.decisionPolicy,
      ownership: roleSet.ownership,
      owners: roleSet.roles.map((role) => role.agent),
    });
    let outcome;
    try {
      outcome = await entry.handle.send(prompt, { timeoutMs: turnTimeoutMs });
    } finally {
      entry.busy = false;
      entry.lastUsedAt = nowIso(now);
    }
    if (outcome?.ok === true) {
      completeContinue(stateDir);
      log("session: control turn complete");
      return { ok: true };
    }
    const requeued = requeueContinue(stateDir, { incrementAttempts: true });
    log(`session: control turn failed: ${outcome?.error ?? "unknown error"}; requeued=${requeued.requeued}`);
    if (/closed|exited|spawn error/.test(String(outcome?.error ?? ""))) {
      await closeEntry(entry, { dropSession: false });
    }
    return { ok: false, error: outcome?.error ?? "unknown error" };
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
      const entry = await ensureSession(dir, { cwd: dir, role: "project" });
      if (entry.busy === true) {
        log(`session: ${dir} is busy — leaving ${cards.length} question(s) pending`);
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
      const paths = agentPaths(opts.home, opts.actorKind);
      const roleSet = loadRoles({
        explicitDir: opts.rolesDir ?? null,
        projectDir: dir,
        loopSkillDir: paths.loopSkill,
      });
      entry.busy = true;
      let outcome;
      try {
        outcome = await entry.handle.send(
          buildQuestionPrompt(claimed.cards, {
            actorKind: opts.actorKind,
            decisionPolicyPath: roleSet?.decisionPolicy?.path ?? null,
          }),
          { timeoutMs: turnTimeoutMs },
        );
      } finally {
        entry.busy = false;
        entry.lastUsedAt = nowIso(now);
      }
      if (outcome?.ok === true) {
        completeCards(stateDir, claimed.cards.map((card) => card.id));
        answered += claimed.cards.length;
        continue;
      }
      requeueCards(stateDir, claimed.cards.map((card) => card.id), {
        error: outcome?.error ?? "question turn failed",
      });
      log(`session: question turn for ${dir} failed: ${outcome?.error ?? "unknown error"} — requeued`);
      if (/closed|exited|spawn error|timed out/.test(String(outcome?.error ?? ""))) {
        await closeEntry(entry, { dropSession: false });
      }
    }
    return answered;
  }

  /**
   * Route pending card handoffs to their project sessions.
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
      return { ok: true, dispatched: 0, answered: 0 };
    }
    // Questions first: they are cheap, they unblock a stopped worker, and they
    // do not draw from the subagent budget.
    const questionRows = pending.filter(isQuestionRow);
    const handoffRows = pending.filter((row) => !isQuestionRow(row));
    const answered = questionRows.length > 0 ? await routeQuestions(questionRows) : 0;
    if (handoffRows.length === 0) {
      return { ok: true, dispatched: 0, answered };
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
        const key = reviewerKey(dir);
        let group = groups.get(key);
        if (group === undefined) {
          group = { key, dir, lane: "reviewer", cards: [] };
          groups.set(key, group);
        }
        group.cards.push(card);
        continue;
      }
      // A worker card is its own top-level session, keyed by card + round.
      // While its question row is open, the project session owns the card; the
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
        [...sessions.keys()].filter((entryKey) => entryKey !== "control" && !isWorkerKey(entryKey)).length >=
          poolMax
      ) {
        log(`session: lane session pool is full (${poolMax}) — leaving ${dir} (${lane}) pending`);
        continue;
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
      }
      let entry;
      try {
        entry = await ensureSession(key, {
          cwd: dir,
          role: lane === "reviewer" ? "reviewer" : lane === "worker-session" ? "worker" : "project",
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
      const paths = agentPaths(opts.home, opts.actorKind);
      const roleSet = loadRoles({
        explicitDir: opts.rolesDir ?? null,
        // Roles and the decision policy live at the project root; a worktree
        // does not carry `.meerkat/roles/`.
        projectDir: String(cards[0]?.project_dir ?? dir),
        loopSkillDir: paths.loopSkill,
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
            buildProjectBatchPrompt(job.cards, job.roleSet, { lane: job.lane }),
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
            error: `project session reported ${ids.length} subagent(s) for ${batch.length} card(s)`,
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
    return { ok: true, dispatched, answered };
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
      if (entry.key === "control") {
        if (sessionMaxAgeMs > 0 && age > sessionMaxAgeMs) {
          await closeEntry(entry, { dropSession: true });
          log("session: control session reached max-age — reopened fresh next turn");
        }
        continue;
      }
      // A swept worktree takes its session with it; a stale key must not be
      // reused for a path that no longer exists.
      if (!existsSync(dir)) {
        await closeEntry(entry, { dropSession: true });
        log(`session: project session ${entry.key} — its directory is gone; closed`);
        continue;
      }
      if (sessionMaxAgeMs > 0 && age > sessionMaxAgeMs) {
        await closeEntry(entry, { dropSession: true });
        log(`session: project session ${entry.key} reached max-age — fresh next batch`);
      } else if (projectIdleMs >= 0 && idle > projectIdleMs) {
        await closeEntry(entry, { dropSession: false });
        log(`session: project session ${entry.key} idle — closed; resume id kept`);
      }
    }
  }

  async function reattachOnStart() {
    const groups = new Map();
    for (const subagent of reattachCandidates(ledger)) {
      const dir = String(subagent.sessionKey ?? "");
      if (dir === "" || !existsSync(dir)) {
        ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        continue;
      }
      // Rows written before the lane split carry no `lane`; the role says it.
      const lane = String(
        subagent.lane ?? (String(subagent.role ?? "") === "reviewer" ? "reviewer" : "worker"),
      );
      const key = lane === "reviewer" ? reviewerKey(dir) : dir;
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, dir, lane, subagents: [] };
        groups.set(key, group);
      }
      group.subagents.push(subagent);
    }
    for (const { key, dir, lane, subagents } of groups.values()) {
      const entry = await ensureSession(key, {
        cwd: dir,
        role: lane === "reviewer" ? "reviewer" : "project",
      });
      entry.busy = true;
      let outcome;
      try {
        outcome = await entry.handle.send(buildReattachPrompt({ targetDir: dir, subagents, lane }), {
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
    log(`session: recovered ${resumed.resumed} worker session(s) for resume`, { level: "debug" });
    return resumed.resumed;
  }

  async function acquireLock() {
    ensureStateDir(stateDir);
    const existing = readJsonFile(lockFile(stateDir), null);
    if (existing.value !== null && isAlive(Number(existing.value.pid))) {
      return { ok: false, holder: existing.value, error: `session pool already running (pid ${existing.value.pid})` };
    }
    const written = writeJsonFile(lockFile(stateDir), {
      version: 1,
      pid: process.pid,
      startedAt: nowIso(now),
    });
    return { ok: written.ok, holder: null, error: written.error };
  }

  function releaseLock() {
    const existing = readJsonFile(lockFile(stateDir), null);
    if (existing.value?.pid === process.pid) rmSync(lockFile(stateDir), { force: true });
  }

  return {
    get sessions() {
      return sessions;
    },
    get ledger() {
      return ledger;
    },
    get control() {
      return control;
    },
    async start() {
      const lock = await acquireLock();
      if (!lock.ok) return lock;
      started = true;
      if (controlMode === "internal") {
        await ensureSession("control", { cwd: opts.repo ?? process.cwd(), role: "control" });
      }
      await reattachOnStart();
      await recoverWorkerSessions();
      persistState();
      return { ok: true };
    },
    async stop() {
      started = false;
      if (kindPool !== null) {
        try {
          await kindPool.close();
        } catch (err) {
          log(`session: pool close failed: ${err.message}`);
        }
      }
      for (const entry of [...sessions.values()]) sessions.delete(entry.key);
      control = null;
      persistState();
      releaseLock();
      return { ok: true };
    },
    async tick(options = {}) {
      const continueResult = await continueTurn();
      const cardResult = await routeCards(options);
      await evictIdle();
      persistState();
      return { continue: continueResult, cards: cardResult };
    },
    async continueTurn() {
      return continueTurn();
    },
    async routeCards(options = {}) {
      return routeCards(options);
    },
    async evictIdle() {
      return evictIdle();
    },
    persistState,
    status() {
      const continueState = readContinue(stateDir);
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
        control: state.control ?? null,
        projects: state.projects ?? {},
        workers: workerState,
        openSessions: [...sessions.keys()],
        liveSubagents: liveSubagents(ledger).length,
        continuePending: continueState.pending !== null,
        continueProcessing: continueState.processing !== null,
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
  // The resident sessions load skills by name: the control session expands
  // `/meerkat-loop`, and a project subagent uses the board skill. A missing
  // install is a hard error, not a session that silently cannot work.
  const paths = agentPaths(opts.home ?? homedir(), opts.actorKind ?? "claude");
  const missing = [paths.loopSkill, paths.boardSkill].filter(
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
  });
  const started = await pool.start();
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
  // The heartbeat is independent of the tick: while a turn is in flight the
  // state file must still say "the pool is here".
  const heartbeat = setInterval(() => pool.persistState(), POOL_HEARTBEAT_MS);
  // In external-control mode no control session holds the event loop, so the
  // timers are the process's only handles: unref'd, the pool would exit the
  // moment it started and `--take-over` would never see it. The internal pool
  // has the control session's process; unref'ing there lets a signalled
  // supervisor exit once that child closes.
  if (opts.control !== "external") {
    interval.unref?.();
    heartbeat.unref?.();
  }
  const stop = async () => {
    clearInterval(interval);
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
