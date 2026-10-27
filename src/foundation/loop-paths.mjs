/**
 * The loop's host-side path and state-file vocabulary, plus the per-kind
 * config's location.
 *
 * One source for names the orchestrator, the installer and the `loop status`
 * probe all read: a rename here changes every reader at once. Pure path
 * arithmetic — `agentPaths` takes the home directory as an argument, and
 * `resolveKindConfigPath` takes the program root, so this module needs no
 * `os.homedir()` and stays deterministic in tests.
 *
 * The roles lookup uses `--roles-dir`, the loop skill's `roles/`, or the state
 * directory; there is no copied execution body for one to travel with.
 *
 * Node builtins only; no I/O.
 */

import { join, resolve } from "node:path";

import { repoRoot } from "./runtime-locator.mjs";

/** Actor kind -> the agent's config directory under the target home. */
export const AGENT_DIRS = Object.freeze({
  claude: ".claude",
  codex: ".codex",
  pi: ".agents",
});

/** The directory holding the per-kind configs; overrides the program root. */
export const KIND_CONFIG_DIR_ENV = "MEERKAT_TASKPANEL_CONFIG_DIR";

/** Per-kind config files are `<program root>/.env.<actor-kind>`. */
export const KIND_CONFIG_FILE_PREFIX = ".env.";

/** A kind that can safely be spliced into a file name. */
const KIND_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * `<program root>/.env.<kind>`, or `<override dir>/.env.<kind>`.
 *
 * The kind is a file-name segment, never a path: a token that is not one plain
 * segment is refused rather than silently normalized. `human` has no per-kind
 * file (a human is not an installed agent kind), and an absent kind returns
 * `null` so callers can decide whether to look.
 *
 * @param {{
 *   actorKind?: string, root?: string, env?: NodeJS.ProcessEnv, cwd?: string,
 * }} [options]
 * @returns {string|null} absolute file path, or null for no kind / the human
 */
export function resolveKindConfigPath(options = {}) {
  const kind = typeof options.actorKind === "string" ? options.actorKind.trim() : "";
  if (kind === "" || kind === "human") return null;
  if (!KIND_TOKEN.test(kind)) {
    throw new Error(`invalid actor kind '${kind}' for a per-kind config path`);
  }

  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const override = env[KIND_CONFIG_DIR_ENV];
  const dir =
    typeof override === "string" && override.trim() !== ""
      ? resolve(cwd, override.trim())
      : resolve(options.root ?? repoRoot());
  return join(dir, `${KIND_CONFIG_FILE_PREFIX}${kind}`);
}

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
 *   log: string, state: string, agentDir: string, projectsJson: string,
 *   loopSkill: string, boardSkill: string, stateDir: string,
 *   loopRoles: string,
 * }}
 */
export function agentPaths(home, actorKind) {
  const dir = join(home, AGENT_DIRS[actorKind]);
  const loopSkill = join(dir, "skills", "meerkat-loop");
  const stateDir = join(dir, "meerkat-taskpanel");
  return {
    log: join(dir, "meerkat-taskpanel", STATE_FILES.log),
    state: join(dir, "meerkat-taskpanel", STATE_FILES.supervisor),
    agentDir: AGENT_DIRS[actorKind],
    projectsJson: join(dir, "skills", "meerkat-taskpanel", "projects.json"),
    // The two skills the resident sessions need: the loop expands
    // `/meerkat-loop` in the control session; project subagents use the board
    // skill. Checked at `--session` start, never assumed.
    loopSkill,
    boardSkill: join(dir, "skills", "meerkat-taskpanel"),
    // The loop's state directory. Runtime state only — a roles root travels
    // with the skill, never here.
    stateDir,
    loopRoles: join(loopSkill, "roles"),
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
