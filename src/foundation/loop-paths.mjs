/**
 * The loop's host-side path and state-file vocabulary.
 *
 * One source for names the orchestrator, the installer and the `loop status`
 * probe all read: a rename here changes every reader at once. Pure path
 * arithmetic — `agentPaths` takes the home directory as an argument, so this
 * module needs no `os.homedir()` and stays deterministic in tests.
 *
 * The roles lookup uses `--roles-dir`, the loop skill's `roles/`, or the state
 * directory; there is no copied execution body for one to travel with.
 *
 * Node builtins only; no I/O.
 */

import { join } from "node:path";

/** Actor kind -> the agent's config directory under the target home. */
export const AGENT_DIRS = Object.freeze({
  claude: ".claude",
  codex: ".codex",
  pi: ".agents",
});

/** State-file names beside the loop's state directory. */
export const QUEUE_FILES = Object.freeze({
  continuePending: "continue.pending.json",
  continueProcessing: "continue.processing.json",
  cards: "cards.queue.json",
  ledger: "subagents.state.json",
  sessions: "sessions.state.json",
});

/**
 * Every other file the loop keeps beside its state directory. The values are
 * file names, never paths; `statePathsForDir` joins them.
 */
export const STATE_FILES = Object.freeze({
  supervisor: "supervisor.state.json",
  log: "supervisor.log",
  continueState: "continue.state.json",
  slaLedger: "sla-ledger.json",
  workflowLedger: "workflow-ledger.json",
  slaLastOk: "loop-patrol-last-ok.json",
  subscribe: "subscribe.state.json",
  sessionLock: "session.lock",
  runLock: "run.lock",
  sessionRecord: "supervisor.session.json",
});

/** Statuses that still consume a concurrency slot in the subagent ledger. */
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

/** Older than four missed heartbeats: the pool is gone, whatever the pid says. */
export const POOL_STALE_MS = 4 * POOL_HEARTBEAT_MS;

/**
 * The agent-local files derived from `--home` and `--actor-kind`.
 *
 * @param {string} home
 * @param {string} actorKind
 * @returns {{
 *   log: string, state: string, config: string, projectsJson: string,
 *   loopSkill: string, boardSkill: string, stateDir: string,
 *   loopRoles: string, stateRoles: string,
 * }}
 */
export function agentPaths(home, actorKind) {
  const dir = join(home, AGENT_DIRS[actorKind]);
  const loopSkill = join(dir, "skills", "meerkat-loop");
  const stateDir = join(dir, "meerkat-taskpanel");
  return {
    log: join(dir, "meerkat-taskpanel", STATE_FILES.log),
    state: join(dir, "meerkat-taskpanel", STATE_FILES.supervisor),
    config: join(dir, "meerkat-taskpanel.env"),
    projectsJson: join(dir, "skills", "meerkat-taskpanel", "projects.json"),
    // The two skills the resident sessions need: the loop expands
    // `/meerkat-loop` in the control session; project subagents use the board
    // skill. Checked at `--session` start, never assumed.
    loopSkill,
    boardSkill: join(dir, "skills", "meerkat-taskpanel"),
    // The loop's state directory. A roles root may travel with either the
    // skill (the setup skill's default) or the state directory.
    stateDir,
    loopRoles: join(loopSkill, "roles"),
    stateRoles: join(stateDir, "roles"),
  };
}

/**
 * The state siblings that live beside `continue.state.json`.
 *
 * @param {string} stateDir
 * @returns {{continueState: string, slaLedger: string, workflowLedger: string, slaLastOk: string}}
 */
export function statePathsForDir(stateDir) {
  const dir = String(stateDir);
  return {
    continueState: join(dir, STATE_FILES.continueState),
    slaLedger: join(dir, STATE_FILES.slaLedger),
    workflowLedger: join(dir, STATE_FILES.workflowLedger),
    slaLastOk: join(dir, STATE_FILES.slaLastOk),
  };
}
