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
 * turn runs `passes.mjs`, and the poll pass writes the card queue.
 *
 * Node builtins only; no network, no dependencies.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cardFileRel } from "../../src/foundation/card-brief.mjs";
import { loadRoles } from "../../src/foundation/roles.mjs";
import { buildContinuePrompt } from "../../src/foundation/scheduling.mjs";
import { createKindPool } from "./kind-session.mjs";
import { agentPaths, loopCommandArgs } from "./options.mjs";

/** Role warnings are configuration noise; say each one once per process. */
const loggedRoleWarnings = new Set();
import {
  claimCards,
  claimContinue,
  completeCards,
  completeContinue,
  ensureStateDir,
  markCardsDispatched,
  pruneCards,
  readCards,
  readContinue,
  readJsonFile,
  recoverStaleCards,
  requeueCards,
  requeueContinue,
  writeJsonFile,
} from "./queue.mjs";
import {
  liveSubagents,
  markSubagent,
  prune,
  readLedger,
  reattachCandidates,
  reconcile,
  upsertSubagent,
  writeLedger,
} from "./ledger.mjs";

/** Pool defaults; the CLI flags override every one of them. */
export const SESSION_DEFAULTS = Object.freeze({
  maxConcurrency: 8,
  projectConcurrency: 8,
  poolMax: 8,
  projectIdleMs: 30 * 60 * 1000,
  sessionMaxAgeMs: 24 * 60 * 60 * 1000,
  turnTimeoutMs: 30 * 60 * 1000,
  pollMs: 1000,
});

export const SESSION_LOCK_FILE = "session.lock";

/**
 * The pool rewrites `sessions.state.json` on this cadence even while a turn is
 * in flight, so a pass in another process can tell "busy" from "gone".
 */
export const POOL_HEARTBEAT_MS = 15_000;

/** Older than four missed heartbeats: the pool is gone, whatever the pid says. */
export const POOL_STALE_MS = 4 * POOL_HEARTBEAT_MS;

const here = dirname(fileURLToPath(import.meta.url));

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
  const read = readJsonFile(sessionsFile(stateDir), { version: 1, control: null, projects: {} });
  if (read.error !== null) return { value: { version: 1, control: null, projects: {} }, error: read.error };
  const value = read.value && typeof read.value === "object" ? read.value : {};
  return {
    value: {
      version: 1,
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
  const empty = { live: false, reason: null, file, poolPid: null, control: null, projects: {} };

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
  const rawPid = Number(value.poolPid);
  const poolPid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  if (poolPid === null || !isAlive(poolPid)) {
    return { ...empty, reason: poolPid === null ? "no pool pid" : `pool pid ${poolPid} is gone`, control, projects };
  }
  const beat = Date.parse(String(value.heartbeatAt ?? ""));
  if (!Number.isFinite(beat)) return { ...empty, reason: "no heartbeat", poolPid, control, projects };
  const age = now() - beat;
  if (age > POOL_STALE_MS) {
    return {
      ...empty,
      reason: `heartbeat ${Math.round(age / 1000)}s old`,
      poolPid,
      control,
      projects,
    };
  }
  return { live: true, reason: null, file, poolPid, control, projects, heartbeatAgeMs: Math.max(0, age) };
}

/**
 * @param {object[]} cards
 * @param {{roles?: object[]}|null} [roleSet] the effective team, when one exists
 */
export function buildProjectBatchPrompt(cards, roleSet = null) {
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
    `You are the project session for ${project} at ${dir}.`,
    "",
    "Claimed cards in this batch:",
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
    lines.push(`  ${index + 1}) ${card.card} (${card.role ?? "worker"})${roleSuffix} handoff:`);
    for (const line of String(card.handoff ?? "").split("\n")) lines.push(`     ${line}`);
  });
  lines.push(
    "",
    "Spawn one subagent per card using the agent kind's subagent mechanism, passing the handoff",
    "text verbatim. Do not work the cards yourself. Do not move cards. Return after",
    "spawning; record each subagent's agent/session id.",
    "",
    "Subagent questions: read agent-authored `question` comments on in_progress cards.",
    "Answer a question you can decide with a note, then reattach the subagent or move the card",
    "to todo; if you cannot decide, escalate E1-E5 to the human with awaiting. Never write a",
    "decision kind and never use --as-human for your own decision.",
  );
  return lines.join("\n");
}

/** @param {{targetDir: string, subagents: object[]}} input */
export function buildReattachPrompt(input) {
  const lines = [
    `You are the project session for ${input.targetDir}.`,
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
    "id; Codex: thread/resume; Pi: subagent resume; OpenCode: resume the child session;",
    "Cursor: pass the agentId back to the subagent task). Verify side effects before",
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

  const getKindPool = () => {
    if (kindPool === null) {
      kindPool = createKindPool({ actorKind: opts.actorKind, opts, log, onEvent: handleEvent });
    }
    return kindPool;
  };

  const persistState = () => {
    const projects = { ...(state.projects ?? {}) };
    for (const [key, entry] of sessions) {
      if (key === "control") continue;
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
      version: 1,
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
   * @param {string} key
   * @param {{cwd: string, role: string, sessionId?: string|null}} options
   */
  function openSession(key, options) {
    const open = sessions.get(key);
    if (open !== undefined) return open;
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
    const eventSession =
      [...sessions.values()].find(
        (entry) =>
          (event.sessionId !== undefined && entry.handle.sessionId === event.sessionId) ||
          (event.cwd !== undefined && entry.cwd === event.cwd),
      ) ?? null;
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
      stateDir: agentFiles.loopBody,
    });
    const prompt = buildContinuePrompt({
      actorKind: opts.actorKind,
      agent: Array.isArray(opts.agents) && opts.agents.length > 0 ? opts.agents[0] : "agent",
      nodePath: process.execPath,
      passesScript: join(here, "passes.mjs"),
      commonArgs: loopCommandArgs(opts),
      continueIntervalSeconds: opts.continueInterval,
      openedBy: opts.openedBy,
      decisionPolicy: roleSet.decisionPolicy,
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
   * Route pending card handoffs to their project sessions.
   *
   * @param {{cardStatus?: Record<string,string>}} [options]
   */
  async function routeCards(options = {}) {
    recoverStaleCards(stateDir, { isAlive, now: now(), maxAgeMs: 2 * turnTimeoutMs });
    // The queue is a work list, not a log: a terminal row is dropped after its
    // retention, and the board's card remains the durable record.
    pruneCards(stateDir, { now: now() });
    let read = readCards(stateDir);
    if (read.error !== null) {
      log(`session: card queue unreadable: ${read.error}`);
      return { ok: false, error: read.error, dispatched: 0 };
    }
    const pending = read.value.cards.filter((card) => card.status === "pending");
    if (pending.length === 0) {
      if (options.cardStatus !== undefined) {
        const result = reconcile(ledger, { cardStatus: options.cardStatus, now: now() });
        ledger = result.ledger;
        if (result.stale.length > 0) log(`session: ledger stale: ${result.stale.join(", ")}`);
        writeLedgerState();
      }
      return { ok: true, dispatched: 0 };
    }
    const groups = new Map();
    for (const card of pending) {
      const dir = String(card.target_dir ?? "");
      if (dir === "" || !dir.startsWith("/") || !existsSync(dir)) {
        completeCards(stateDir, [card.id], { status: "failed", error: "target_dir missing or not absolute" });
        log(`session: card ${card.card} has no usable target_dir (${JSON.stringify(card.target_dir)}) — failed`);
        continue;
      }
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(card);
    }
    let dispatched = 0;
    for (const [dir, cards] of groups) {
      let live = liveSubagents(ledger);
      const globalBudget = Math.max(0, maxConcurrency - live.length);
      if (globalBudget === 0) {
        log(`session: global concurrency cap reached (${maxConcurrency}) — leaving ${cards.length} card(s) pending`);
        break;
      }
      if (!sessions.has(dir) && [...sessions.keys()].filter((key) => key !== "control").length >= poolMax) {
        log(`session: project session pool is full (${poolMax}) — leaving ${dir} pending`);
        continue;
      }
      const entry = await ensureSession(dir, { cwd: dir, role: "project" });
      live = liveSubagents(ledger);
      const projectLive = live.filter((subagent) => String(subagent.sessionKey ?? "") === dir).length;
      const budget = Math.max(0, Math.min(globalBudget, projectConcurrency - projectLive));
      if (budget === 0) {
        log(`session: ${dir} is at its project concurrency cap — leaving ${cards.length} card(s) pending`);
        continue;
      }
      const claimed = claimCards(stateDir, {
        claimedBy: dir,
        pid: process.pid,
        limit: Math.min(budget, cards.length),
        now: nowIso(now),
      });
      if (!claimed.ok || claimed.cards.length === 0) {
        if (!claimed.ok) log(`session: card claim failed: ${claimed.error}`);
        continue;
      }
      const paths = agentPaths(opts.home, opts.actorKind);
      const roleSet = loadRoles({
        explicitDir: opts.rolesDir ?? null,
        projectDir: dir,
        loopSkillDir: paths.loopSkill,
        stateDir: paths.loopBody,
      });
      for (const warning of roleSet.warnings) {
        if (loggedRoleWarnings.has(warning)) continue;
        loggedRoleWarnings.add(warning);
        log(`roles: ${warning}`);
      }
      entry.batch = { cards: claimed.cards, ids: [] };
      entry.busy = true;
      let outcome;
      try {
        outcome = await entry.handle.send(buildProjectBatchPrompt(claimed.cards, roleSet), {
          timeoutMs: turnTimeoutMs,
        });
      } finally {
        entry.busy = false;
        entry.lastUsedAt = nowIso(now);
      }
      const ids =
        entry.batch.ids.length > 0
          ? entry.batch.ids.slice()
          : Array.isArray(outcome?.ids)
            ? outcome.ids.slice()
            : [];
      entry.batch = null;
      if (outcome?.ok !== true) {
        requeueCards(stateDir, claimed.cards.map((card) => card.id), {
          error: outcome?.error ?? "project turn failed",
        });
        log(`session: project turn for ${dir} failed: ${outcome?.error ?? "unknown error"} — cards requeued`);
        if (/closed|exited|spawn error/.test(String(outcome?.error ?? ""))) {
          await closeEntry(entry, { dropSession: false });
        }
        continue;
      }
      let matched = 0;
      claimed.cards.forEach((card, index) => {
        const subagentId = ids[index];
        if (subagentId === undefined) return;
        matched += 1;
        ledger = upsertSubagent(ledger, {
          sessionKey: dir,
          actorKind: opts.actorKind,
          subagentId,
          role: card.role ?? "worker",
          agentRole: card.agent_role ?? null,
          card: card.card,
          type: "subagent",
          status: opts.subagentBackground === true ? "running" : "completed",
          lastResult:
            opts.subagentBackground === true ? null : "project session turn completed",
          queueId: card.id,
        });
        if (opts.subagentBackground === true) markCardsDispatched(stateDir, [card.id], { claimedBy: dir });
        else completeCards(stateDir, [card.id]);
      });
      for (const extra of ids.slice(claimed.cards.length)) {
        ledger = upsertSubagent(ledger, {
          sessionKey: dir,
          actorKind: opts.actorKind,
          subagentId: extra,
          status: opts.subagentBackground === true ? "running" : "completed",
        });
      }
      const unmatched = claimed.cards.slice(matched);
      if (unmatched.length > 0) {
        requeueCards(stateDir, unmatched.map((card) => card.id), {
          error: `project session reported ${ids.length} subagent(s) for ${claimed.cards.length} card(s)`,
        });
        log(
          `session: ${dir} reported ${ids.length} subagent(s) for ${claimed.cards.length} card(s) — ` +
            `${unmatched.length} requeued`,
        );
      }
      dispatched += matched;
      writeLedgerState();
      persistState();
    }
    if (options.cardStatus !== undefined) {
      const result = reconcile(ledger, { cardStatus: options.cardStatus, now: now() });
      ledger = result.ledger;
      if (result.stale.length > 0) log(`session: ledger stale: ${result.stale.join(", ")}`);
      writeLedgerState();
    }
    ledger = prune(ledger, { now: now() });
    writeLedgerState();
    return { ok: true, dispatched };
  }

  async function evictIdle() {
    const live = liveSubagents(ledger);
    for (const entry of [...sessions.values()]) {
      if (entry.busy === true || entry.batch !== null) continue;
      if (live.some((subagent) => String(subagent.sessionKey ?? "") === entry.key)) continue;
      const age = now() - Date.parse(String(entry.startedAt));
      const idle = now() - Date.parse(String(entry.lastUsedAt));
      if (entry.key === "control") {
        if (sessionMaxAgeMs > 0 && age > sessionMaxAgeMs) {
          await closeEntry(entry, { dropSession: true });
          log("session: control session reached max-age — reopened fresh next turn");
        }
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
      const key = String(subagent.sessionKey ?? "");
      if (key === "" || !existsSync(key)) {
        ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        continue;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(subagent);
    }
    for (const [dir, subagents] of groups) {
      const entry = await ensureSession(dir, { cwd: dir, role: "project" });
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
        log(`session: reattach prompt sent for ${dir} (${subagents.length} subagent(s))`);
      } else {
        for (const subagent of subagents) {
          ledger = markSubagent(ledger, subagent.subagentId, { status: "stale" });
        }
        log(`session: reattach failed for ${dir}: ${outcome?.error ?? "unknown error"} — marked stale`);
      }
      writeLedgerState();
    }
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
      return {
        running: started,
        controlMode,
        control: state.control ?? null,
        projects: state.projects ?? {},
        openSessions: [...sessions.keys()],
        liveSubagents: liveSubagents(ledger).length,
        continuePending: continueState.pending !== null,
        continueProcessing: continueState.processing !== null,
        cardPending: cards.filter((card) => card.status === "pending").length,
        cardProcessing: cards.filter((card) => card.status === "processing").length,
        cardDispatched: cards.filter((card) => card.status === "dispatched").length,
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
  const pool = createSessionPool({ opts, log, kindPool: deps.kindPool, now: deps.now, isAlive: deps.isAlive });
  const started = await pool.start();
  if (!started.ok) {
    log(`session: ${started.error}`);
    return 1;
  }
  let ticking = false;
  const interval = setInterval(() => {
    // A turn can outlive many poll intervals; a second concurrent tick would
    // re-read the same queues for no gain.
    if (ticking) return;
    ticking = true;
    pool
      .tick()
      .catch((err) => log(`session: tick failed: ${err.message}`))
      .finally(() => {
        ticking = false;
      });
  }, Math.max(50, Number(opts.sessionPollMs ?? SESSION_DEFAULTS.pollMs)));
  interval.unref?.();
  // The heartbeat is independent of the tick: while a turn is in flight the
  // state file must still say "the pool is here".
  const heartbeat = setInterval(() => pool.persistState(), POOL_HEARTBEAT_MS);
  heartbeat.unref?.();
  const stop = async () => {
    clearInterval(interval);
    clearInterval(heartbeat);
    await pool.stop();
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
