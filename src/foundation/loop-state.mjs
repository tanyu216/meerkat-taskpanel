/**
 * The loop's state-file vocabulary and resident-pool defaults.
 *
 * One source for names the orchestrator, the installer's status probe and the
 * loop's own tests read: a rename here changes every reader at once. The values
 * are file names, never paths — `statePathsForDir` joins them onto a directory.
 *
 * Node builtins only; no I/O.
 */

import { join } from "node:path";

/** The files a queue row and the pool's registry live in. */
export const QUEUE_FILES = Object.freeze({
  continuePending: "continue.pending.json",
  continueProcessing: "continue.processing.json",
  cards: "cards.queue.json",
  ledger: "subagents.state.json",
  sessions: "sessions.state.json",
});

/** Every other file the loop keeps beside its state directory. */
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
