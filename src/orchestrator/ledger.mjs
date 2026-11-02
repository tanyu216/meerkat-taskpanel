/**
 * The subagent ledger — durable, application-level state for work delegated to
 * an agent's subagents.
 *
 * The ledger is deliberately *not* a copy of an agent transcript. It records only
 * what the supervisor needs to recover work across a crash:
 *
 *   sessionKey   the project directory whose lane session spawned it
 *   subagentId   the agent's handle (Claude agentId, Codex thread id, …)
 *   role/card    what the subagent is responsible for
 *   status       spawned | running | completed | failed | interrupted | stale
 *
 * Agent transcripts are internal formats; the ledger is the supervisor's own
 * state and the only thing resume/reattach reads.
 *
 * Node builtins only; no network, no dependencies.
 */

import { QUEUE_FILES, readJsonFile, writeJsonFile } from "./queue.mjs";
import { join } from "node:path";

// The live set is shared with the installer's status probe; re-exported because
// this module was its first home and the loop tests import it from here.
export { LIVE_STATUSES } from "../foundation/loop-state.mjs";
import { LIVE_STATUSES } from "../foundation/loop-state.mjs";

/** A completed ledger row is kept this long for audit/reconcile. */
export const DEFAULT_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {string} stateDir */
export function ledgerPath(stateDir) {
  return join(stateDir, QUEUE_FILES.ledger);
}

/** @param {*} value @returns {{version: number, subagents: object[]}} */
function normalise(value) {
  const ledger = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    ...ledger,
    subagents: Array.isArray(ledger.subagents) ? ledger.subagents : [],
  };
}

/**
 * @param {string} stateDir
 * @returns {{value: {version: number, subagents: object[]}, error: string|null}}
 */
export function readLedger(stateDir) {
  const read = readJsonFile(ledgerPath(stateDir), { version: 1, subagents: [] });
  return { value: normalise(read.value), error: read.error };
}

/** @param {string} stateDir @param {{version: number, subagents: object[]}} ledger */
export function writeLedger(stateDir, ledger) {
  return writeJsonFile(ledgerPath(stateDir), normalise(ledger));
}

/** @param {object} entry */
export function isLive(entry) {
  return LIVE_STATUSES.includes(String(entry?.status ?? ""));
}

/** @param {{subagents: object[]}} ledger */
export function liveSubagents(ledger) {
  return normalise(ledger).subagents.filter(isLive);
}

/**
 * Insert or update one subagent. Identity is the agent handle when present,
 * else (sessionKey, card, role). Callers may upsert a row before the agent has
 * assigned an id; the later upsert with the id fills it in.
 *
 * @param {{subagents: object[]}} ledger
 * @param {object} record
 * @returns {object} the updated ledger
 */
export function upsertSubagent(ledger, record) {
  const next = normalise(ledger);
  const id = record.subagentId === undefined || record.subagentId === null ? null : String(record.subagentId);
  // Prefer the agent handle. A row created before the handle existed is matched
  // by (sessionKey, card, role), but only while it is still live: a retry of a
  // finished card is a new subagent, not the old row.
  let index = id === null ? -1 : next.subagents.findIndex((entry) => entry.subagentId === id);
  if (index === -1) {
    index = next.subagents.findIndex(
      (entry) =>
        String(entry.sessionKey ?? "") === String(record.sessionKey ?? "") &&
        String(entry.card ?? "") === String(record.card ?? "") &&
        String(entry.role ?? "worker") === String(record.role ?? "worker") &&
        (entry.subagentId === null || entry.subagentId === undefined || entry.subagentId === "" || isLive(entry)),
    );
  }
  const merged = {
    version: 1,
    sessionKey: record.sessionKey ?? null,
    actorKind: record.actorKind ?? null,
    subagentId: id ?? (index === -1 ? null : next.subagents[index].subagentId ?? null),
    role: record.role ?? (index === -1 ? "worker" : next.subagents[index].role ?? "worker"),
    lane: record.lane ?? (index === -1 ? null : next.subagents[index].lane ?? null),
    card: record.card ?? (index === -1 ? null : next.subagents[index].card ?? null),
    type: record.type ?? (index === -1 ? null : next.subagents[index].type ?? null),
    queueId: record.queueId ?? (index === -1 ? null : next.subagents[index].queueId ?? null),
    // A card's project and its project checkout travel with the row so the
    // per-project cap can count a project's worktrees as one project.
    project: record.project ?? (index === -1 ? null : next.subagents[index].project ?? null),
    projectDir: record.projectDir ?? (index === -1 ? null : next.subagents[index].projectDir ?? null),
    workspace: record.workspace ?? (index === -1 ? null : next.subagents[index].workspace ?? null),
    status: record.status ?? (index === -1 ? "spawned" : next.subagents[index].status ?? "spawned"),
    startedAt: record.startedAt ?? (index === -1 ? new Date().toISOString() : next.subagents[index].startedAt),
    lastSeenAt: record.lastSeenAt ?? new Date().toISOString(),
    lastResult: record.lastResult ?? (index === -1 ? null : next.subagents[index].lastResult ?? null),
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts
      : index === -1
        ? []
        : next.subagents[index].artifacts ?? [],
    transcriptPath: record.transcriptPath ?? (index === -1 ? null : next.subagents[index].transcriptPath ?? null),
  };
  if (index === -1) next.subagents.push(merged);
  else next.subagents[index] = merged;
  return next;
}

/**
 * Drop long-finished rows. Live rows are never pruned.
 *
 * @param {{subagents: object[]}} ledger
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {object}
 */
export function prune(ledger, options = {}) {
  const next = normalise(ledger);
  const now = options.now ?? Date.now();
  const ttlMs = Number(options.ttlMs ?? DEFAULT_COMPLETED_TTL_MS);
  next.subagents = next.subagents.filter((entry) => {
    if (isLive(entry)) return true;
    const seen = Date.parse(String(entry.lastSeenAt ?? entry.startedAt ?? ""));
    return !Number.isFinite(seen) || now - seen <= ttlMs;
  });
  return next;
}
