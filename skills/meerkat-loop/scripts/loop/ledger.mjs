/**
 * The subagent ledger — durable, application-level state for work delegated to
 * an agent's subagents.
 *
 * The ledger is deliberately *not* a copy of an agent transcript. It records only
 * what the supervisor needs to recover work across a crash:
 *
 *   sessionKey   the project directory whose project session spawned it
 *   subagentId   the agent's handle (Claude agentId, Codex thread id, …)
 *   role/card    what the subagent is responsible for
 *   status       spawned | running | completed | failed | interrupted | stale
 *
 * Agent transcripts are internal formats; the ledger is the supervisor's own
 * state and the only thing resume/reattach reads.
 *
 * Node builtins only; no network, no dependencies.
 */

import { LEDGER_STALE_MS } from "../foundation/scheduling.mjs";
import { QUEUE_FILES, readJsonFile, writeJsonFile } from "./queue.mjs";
import { join } from "node:path";

/** Statuses that still consume a concurrency slot. */
export const LIVE_STATUSES = Object.freeze(["spawned", "running", "reattaching"]);

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
    card: record.card ?? (index === -1 ? null : next.subagents[index].card ?? null),
    type: record.type ?? (index === -1 ? null : next.subagents[index].type ?? null),
    queueId: record.queueId ?? (index === -1 ? null : next.subagents[index].queueId ?? null),
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
 * Mark one subagent terminal (or refresh its status). `identity` may be the
 * agent handle, or `{sessionKey, card, role}` for a row that never got one.
 *
 * @param {{subagents: object[]}} ledger
 * @param {string|{sessionKey?: string, card?: string, role?: string}} identity
 * @param {{status: string, lastResult?: string|null, artifacts?: string[]}} change
 * @returns {object} the updated ledger
 */
export function markSubagent(ledger, identity, change) {
  const next = normalise(ledger);
  const matches = (entry) => {
    if (typeof identity === "string") return String(entry.subagentId ?? "") === identity;
    return (
      String(entry.sessionKey ?? "") === String(identity.sessionKey ?? "") &&
      String(entry.card ?? "") === String(identity.card ?? "") &&
      String(entry.role ?? "worker") === String(identity.role ?? "worker")
    );
  };
  const entry = next.subagents.find(matches);
  if (entry === undefined) return next;
  entry.status = change.status;
  entry.lastSeenAt = new Date().toISOString();
  if (change.lastResult !== undefined) entry.lastResult = change.lastResult;
  if (Array.isArray(change.artifacts)) entry.artifacts = change.artifacts;
  return next;
}

/**
 * Rows worth trying to reattach after a restart, optionally scoped to one
 * project session. Terminal rows are excluded.
 *
 * @param {{subagents: object[]}} ledger
 * @param {{sessionKey?: string|null}} [options]
 */
export function reattachCandidates(ledger, options = {}) {
  const key = options.sessionKey ?? null;
  return liveSubagents(ledger).filter((entry) => {
    if (entry.subagentId === null || entry.subagentId === undefined || entry.subagentId === "") return false;
    if (key === null) return true;
    return String(entry.sessionKey ?? "") === String(key);
  });
}

/**
 * Extract Claude's subagent handles from a tool-result or hook payload text.
 * The Agent tool result ends with `agentId: <id>`; SubagentStop carries
 * `agent_id`. Both spellings are accepted, de-duplicated.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractAgentIds(text) {
  const out = new Set();
  const body = String(text ?? "");
  // `agentId: x` in prose, and `"agentId":"x"` in an agent event's JSON.
  for (const match of body.matchAll(/\bagentId["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/g)) out.add(match[1]);
  for (const match of body.matchAll(/\bagent_id\b["']?\s*[:=]\s*["']?([A-Za-z0-9_.:-]+)/g)) out.add(match[1]);
  return [...out];
}

/**
 * Reconcile live rows against the board. A subagent whose card is no longer in
 * progress (or whose lastSeenAt is older than the bound) is marked `stale`, so
 * a missed agent event cannot pin a concurrency slot forever.
 *
 * `cardStatus` is a map `card -> status` read from the board; a missing card is
 * treated as unknown, not as finished.
 *
 * @param {{subagents: object[]}} ledger
 * @param {{cardStatus?: Record<string,string>, now?: number, staleAfterMs?: number}} [options]
 * @returns {{ledger: object, stale: string[]}}
 */
export function reconcile(ledger, options = {}) {
  const next = normalise(ledger);
  const cardStatus = options.cardStatus ?? {};
  const now = options.now ?? Date.now();
  const staleAfterMs = Number(options.staleAfterMs ?? LEDGER_STALE_MS);
  const stale = [];
  for (const entry of next.subagents) {
    if (!isLive(entry)) continue;
    const card = String(entry.card ?? "");
    const status = cardStatus[card];
    const lastSeen = Date.parse(String(entry.lastSeenAt ?? entry.startedAt ?? ""));
    const old = Number.isFinite(lastSeen) && now - lastSeen > staleAfterMs;
    const finished = status !== undefined && status !== "in_progress" && status !== "in_review";
    if (finished && old) {
      entry.status = "stale";
      entry.lastSeenAt = new Date(now).toISOString();
      stale.push(String(entry.subagentId ?? `${entry.sessionKey}:${entry.card}:${entry.role}`));
    }
  }
  return { ledger: next, stale };
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
